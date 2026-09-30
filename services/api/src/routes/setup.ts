/**
 * One-time setup, from the widget: register the user's passkey (their Swish
 * ID), then link each wallet with a USDC allowance.
 *
 * A wallet signs what we build; we check it came back unchanged, then add
 * the sponsor's signature (Swish pays every fee and rent). A first-time
 * wallet signs twice: the Foundation authority first (its id is the slot it
 * lands in, so nothing can be built on it before), then the allowance and
 * the link together. Call `prepare` until it answers `done`.
 */
import { createHmac } from "node:crypto";

import { address, createNoopSigner, getBase64Decoder, getBase64Encoder, isAddress } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import {
  getCreateFixedDelegationOverlayInstructionAsync,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getRevokeDelegationOverlayInstruction,
} from "@solana/subscriptions";
import { Router } from "express";
import { z } from "zod";

import { fromBaseUnits, toBaseUnits } from "../amount.js";
import { requirePublishableKey } from "../auth.js";
import { MAX_ALLOWANCE_NONCE, type Allowance } from "../chain/client.js";
import { linkWalletInstruction, pullerPda, swishIdPda, TOKEN_PROGRAM } from "../chain/program.js";
import { PasskeyError, compressPublicKey, fromB64url } from "../chain/webauthn.js";
import { USDC_DECIMALS, type Deps } from "../context.js";
import { HttpError, badRequest, conflict } from "../http.js";
import { safeEqual } from "../keys.js";

const passkeyBody = z.object({
  credential_id: z.string().min(1).max(1024),
  /** From the browser at creation: `getPublicKey()` (SPKI), base64url. */
  public_key: z.string().min(1),
});

const positiveAmount = z.string().refine((a) => {
  try {
    return toBaseUnits(a, USDC_DECIMALS) > 0n;
  } catch {
    return false;
  }
}, 'a positive amount with at most 6 decimals, e.g. "500"');

const walletRef = z.object({
  credential_id: z.string().min(1),
  wallet: z.string().refine(isAddress, "not a Solana address"),
});

const walletBody = walletRef.extend({
  /** The most Swish may ever pull from this wallet, e.g. "500". */
  allowance: positiveAmount,
});

const limitBody = walletRef.extend({
  /** Added on top of what is left, e.g. "100". */
  add: positiveAmount,
});

const submitBody = z.object({
  /** The transaction from `prepare`, signed by the wallet, base64. */
  transaction: z.string().min(1),
  token: z.string().min(1),
});

export function setupRouter(deps: Deps): Router {
  const router = Router();
  const { db, chain } = deps;
  const publishable = requirePublishableKey(deps);
  const seal = (messageBytes: Uint8Array) =>
    createHmac("sha256", deps.serverSecret).update(messageBytes).digest("base64url");

  async function passkeyFor(credentialId: string) {
    const { rows } = await db.query<{ public_key: Uint8Array; swish_id: string }>(
      "select public_key, swish_id from passkeys where credential_id = $1",
      [credentialId],
    );
    if (!rows[0]) throw new HttpError(404, "no_swish_id", "No Swish passkey found. Set up once, then try again.");
    return { publicKey: new Uint8Array(rows[0].public_key), swishId: rows[0].swish_id };
  }

  router.post("/v1/setup/passkey", publishable, async (req, res) => {
    const body = passkeyBody.parse(req.body);
    let publicKey: Uint8Array;
    try {
      publicKey = compressPublicKey(fromB64url(body.public_key));
    } catch (e) {
      if (e instanceof PasskeyError) throw badRequest("invalid_passkey", e.message);
      throw e;
    }
    const swishId = await swishIdPda(publicKey);
    await db.query(
      "insert into passkeys (credential_id, public_key, swish_id) values ($1, $2, $3) on conflict (credential_id) do nothing",
      [body.credential_id, Buffer.from(publicKey), swishId],
    );
    const stored = await passkeyFor(body.credential_id);
    if (!Buffer.from(stored.publicKey).equals(Buffer.from(publicKey))) {
      throw conflict("credential_taken", "this passkey id is already registered with a different key");
    }
    res.status(201).json({ swish_id: swishId });
  });

  router.post("/v1/setup/wallet/prepare", publishable, async (req, res) => {
    const body = walletBody.parse(req.body);
    const { publicKey, swishId } = await passkeyFor(body.credential_id);
    const walletAddress = address(body.wallet);
    const wallet = createNoopSigner(walletAddress);
    const mint = deps.usdcMint;

    const [userAta] = await findAssociatedTokenPda({ owner: walletAddress, mint, tokenProgram: TOKEN_PROGRAM });
    if (!(await chain.exists(userAta))) {
      throw badRequest("no_usdc_account", "This wallet has no USDC account yet. Add USDC to it first.");
    }

    const authority = await chain.subscriptionAuthority(walletAddress, mint);
    if (!authority) {
      const ix = await getInitSubscriptionAuthorityOverlayInstructionAsync({
        owner: wallet,
        payer: chain.sponsor,
        tokenMint: mint,
        tokenProgram: TOKEN_PROGRAM,
        userAta,
      });
      return respond(res, "authorize", [ix]);
    }

    const [allowances, linkedTo] = await Promise.all([
      chain.allowances(walletAddress, mint),
      chain.linkedSwishId(walletAddress),
    ]);
    if (linkedTo && linkedTo !== swishId) {
      throw conflict("wallet_linked_elsewhere", "This wallet is already linked to another Swish ID.");
    }
    const instructions = [];
    if (allowances.length === 0) {
      instructions.push(
        await allowanceInstruction(wallet, 0n, toBaseUnits(body.allowance, USDC_DECIMALS), authority.initId),
      );
    }
    if (!linkedTo) instructions.push(await linkWalletInstruction(wallet, chain.sponsor, publicKey));
    if (instructions.length === 0) {
      res.json({ done: true, swish_id: swishId, wallet: walletAddress });
      return;
    }
    return respond(res, "allow", instructions);
  });

  /** How much Swish can still pull from this wallet (for "Left now"). */
  router.post("/v1/setup/wallet/allowance", publishable, async (req, res) => {
    const body = walletRef.parse(req.body);
    const walletAddress = address(body.wallet);
    const allowances = await chain.allowances(walletAddress, deps.usdcMint);
    res.json({ wallet: walletAddress, left: fromBaseUnits(leftOf(allowances), USDC_DECIMALS), token: "USDC" });
  });

  /**
   * Adds to a linked wallet's limit: the new limit is what is left plus
   * `add`. The old allowance is revoked (its rent back to Swish) and one for
   * the new total created at the next nonce, in one transaction the wallet
   * signs once. Submit it like any setup step.
   */
  router.post("/v1/setup/wallet/limit", publishable, async (req, res) => {
    const body = limitBody.parse(req.body);
    const { swishId } = await passkeyFor(body.credential_id);
    const walletAddress = address(body.wallet);
    const wallet = createNoopSigner(walletAddress);
    const mint = deps.usdcMint;

    const [authority, allowances, linkedTo] = await Promise.all([
      chain.subscriptionAuthority(walletAddress, mint),
      chain.allowances(walletAddress, mint),
      chain.linkedSwishId(walletAddress),
    ]);
    if (!authority || linkedTo !== swishId) {
      throw badRequest("not_set_up", "Set this wallet up with this Swish ID first.");
    }
    const used = new Set(allowances.map((a) => a.nonce));
    let nonce = 0n;
    while (used.has(nonce)) nonce++;
    if (nonce >= MAX_ALLOWANCE_NONCE) throw conflict("too_many_allowances", "Revoke old allowances first.");

    const left = leftOf(allowances);
    const newLimit = left + toBaseUnits(body.add, USDC_DECIMALS);
    const instructions = allowances.map((a) =>
      getRevokeDelegationOverlayInstruction({ authority: wallet, delegationAccount: a.address, receiver: chain.sponsor.address }),
    );
    instructions.push(await allowanceInstruction(wallet, nonce, newLimit, authority.initId));
    return respond(res, "limit", instructions, {
      left_now: fromBaseUnits(left, USDC_DECIMALS),
      new_limit: fromBaseUnits(newLimit, USDC_DECIMALS),
    });
  });

  /** What is left across a wallet's current allowances (normally just one). */
  const leftOf = (allowances: Allowance[]) => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    return allowances
      .filter((a) => a.expiryTs === 0n || a.expiryTs >= now)
      .reduce((sum, a) => sum + a.amount, 0n);
  };

  async function allowanceInstruction(wallet: ReturnType<typeof createNoopSigner>, nonce: bigint, amount: bigint, initId: bigint) {
    return getCreateFixedDelegationOverlayInstructionAsync({
      delegator: wallet,
      payer: chain.sponsor,
      delegatee: await pullerPda(),
      tokenMint: deps.usdcMint,
      amount,
      expiryTs: 0n,
      nonce,
      expectedSubscriptionAuthorityInitId: initId,
    });
  }

  async function respond(
    res: import("express").Response,
    step: "authorize" | "allow" | "limit",
    instructions: Parameters<typeof chain.buildForWallet>[0],
    extra: Record<string, string> = {},
  ) {
    const tx = await chain.buildForWallet(instructions);
    res.json({
      done: false,
      step,
      ...extra,
      transaction: getBase64Decoder().decode(tx.wire),
      token: seal(tx.messageBytes),
    });
  }

  router.post("/v1/setup/wallet/submit", publishable, async (req, res) => {
    const body = submitBody.parse(req.body);
    let tx;
    try {
      tx = chain.decode(getBase64Encoder().encode(body.transaction) as Uint8Array);
    } catch {
      throw badRequest("invalid_transaction", "not a transaction");
    }
    // Only a transaction we built, unchanged, gets the sponsor's signature.
    if (!safeEqual(seal(new Uint8Array(tx.messageBytes)), body.token)) {
      throw badRequest("invalid_transaction", "this is not the transaction we prepared");
    }
    const missing = Object.entries(tx.signatures).filter(
      ([signer, sig]) => signer !== chain.sponsor.address && sig === null,
    );
    if (missing.length) throw badRequest("unsigned", "the wallet has not signed this transaction");
    const signature = await chain.sendWalletSigned(tx);
    res.json({ signature });
  });

  return router;
}

