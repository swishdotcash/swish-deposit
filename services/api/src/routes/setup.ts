/**
 * One-time setup, from the widget: register the user's passkey (their Swish
 * ID), then link each wallet with a USDC allowance.
 *
 * Swish pays the rent and fees, so linking a wallet or changing its limit
 * only happens for an open deposit your server created (secret key) that the
 * widget holds: one wallet per deposit, holding at least its amount, a few
 * paid transactions, and a daily cap on new wallets per app. The publishable
 * key alone can only register a passkey (a database row) and read a limit.
 *
 * A wallet signs what we build; we check it came back unchanged, then add
 * the sponsor's signature (Swish pays every fee and rent). A first-time
 * wallet signs twice: the Foundation authority first (its id is the slot it
 * lands in, so nothing can be built on it before), then the allowance and
 * the link together. Call `prepare` until it answers `done`.
 */
import { createHmac } from "node:crypto";

import {
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  address,
  createNoopSigner,
  type Address,
  getBase64Decoder,
  getBase64Encoder,
  isAddress,
  isSolanaError,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import {
  getCreateFixedDelegationOverlayInstructionAsync,
  getInitSubscriptionAuthorityOverlayInstructionAsync,
  getRevokeDelegationOverlayInstruction,
} from "@solana/subscriptions";
import { Router } from "express";
import { z } from "zod";

import { fromBaseUnits, toBaseUnits } from "../amount.js";
import { currentApp, requirePublishableKey } from "../auth.js";
import { MAX_ALLOWANCE_NONCE, type Allowance } from "../chain/client.js";
import { linkWalletInstruction, pullerPda, swishIdPda, TOKEN_PROGRAM, unlinkWalletInstruction } from "../chain/program.js";
import { PasskeyError, compressPublicKey, fromB64url } from "../chain/webauthn.js";
import {
  SETUP_CALLS_PER_IP_PER_MINUTE,
  SETUP_TRANSACTIONS_PER_DEPOSIT,
  USDC_DECIMALS,
  type AppRow,
  type Deps,
} from "../context.js";
import { HttpError, badRequest, conflict } from "../http.js";
import { safeEqual } from "../keys.js";
import { perIpLimit } from "../rateLimit.js";
import { loadDepositForWidget, type DepositRow } from "./deposits.js";

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

/** How long reading a limit from the chain may hold up a wallet's standing. It carries on and is kept for next time. */
const LIMIT_WAIT_MS = 500;

/** The open deposit this setup is for, as the widget holds it. */
const forDeposit = {
  deposit_id: z.string().min(1),
  client_secret: z.string().min(1),
};

const walletBody = walletRef.extend({
  ...forDeposit,
  /** The most Swish may ever pull from this wallet, e.g. "500". */
  allowance: positiveAmount,
});

const limitBody = walletRef.extend({
  ...forDeposit,
  /** Added on top of what is left, e.g. "100". */
  add: positiveAmount,
});

const unlinkBody = z.object({ wallet: z.string().refine(isAddress, "not a Solana address") });

/** Seals an unlink: it belongs to no deposit and costs Swish nothing net. */
const UNLINK = "unlink";

const submitBody = z.object({
  /** The transaction from `prepare`, signed by the wallet, base64. */
  transaction: z.string().min(1),
  token: z.string().min(1),
});

/** RPC wraps an expired blockhash error inside a simulation error. */
function blockhashExpired(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    if (isSolanaError(current, SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND)) return true;
    seen.add(current);
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

export function setupRouter(deps: Deps): Router {
  const router = Router();
  const { db, chain } = deps;
  const publishable = requirePublishableKey(deps);
  router.use("/v1/setup", perIpLimit(SETUP_CALLS_PER_IP_PER_MINUTE));

  /** Ties a prepared transaction to its deposit: `<deposit id>.<mac>`. */
  const seal = (depositId: string, messageBytes: Uint8Array) =>
    `${depositId}.${createHmac("sha256", deps.serverSecret).update(depositId).update(messageBytes).digest("base64url")}`;

  async function openDeposit(body: { deposit_id: string; client_secret: string }, app: AppRow) {
    const d = await loadDepositForWidget(db, body.deposit_id, body.client_secret, app);
    if (d.status !== "created") throw conflict("not_open", `this deposit is ${d.status}`);
    return d;
  }

  /** The wallet must hold what this deposit asks, before Swish spends on it. */
  async function requireFunds(wallet: Address, d: DepositRow) {
    const balance = await chain.tokenBalance(wallet, deps.usdcMint);
    if (balance === null) {
      throw badRequest("no_usdc_account", "This wallet has no USDC account yet. Add USDC to it first.");
    }
    if (balance < BigInt(d.amount)) {
      throw new HttpError(
        402,
        "not_enough_usdc",
        `This wallet holds less than the ${fromBaseUnits(d.amount, USDC_DECIMALS)} USDC this deposit needs.`,
      );
    }
  }

  /**
   * One wallet per deposit. A wallet Swish has not linked yet counts against
   * the app's daily cap on new wallets, once.
   */
  async function bindWallet(d: DepositRow, app: AppRow, wallet: Address, isNew: boolean) {
    if (!db.transaction) throw new Error("setup reservations require database transactions");
    const rows = await db.transaction(async (tx) => {
      // Lock a shared row, then count in a NEW statement (fresh READ COMMITTED
      // snapshot). Locks on individual deposits cannot serialize an app quota.
      const { rows: apps } = await tx.query<AppRow>("select * from apps where id = $1 for update", [app.id]);
      const locked = apps[0];
      if (!locked?.active) throw conflict("app_inactive", "This app is not active.");
      const result = await tx.query<DepositRow>(
        `update deposits set
           setup_wallet = $2,
           setup_at = case when $3::boolean and not setup_new_wallet then now() else coalesce(setup_at, now()) end,
           setup_new_wallet = setup_new_wallet or $3::boolean,
           updated_at = now()
         where id = $1 and status = 'created'
           and (setup_wallet is null or setup_wallet = $2)
           and (not $3::boolean or setup_new_wallet or (
             select count(*) from deposits
             where app_id = $4 and setup_new_wallet and setup_at > now() - interval '1 day'
           ) < $5)
         returning *`,
        [d.id, wallet, isNew, app.id, locked.daily_new_wallets],
      );
      return result.rows;
    });
    if (rows[0]) return;
    const { rows: current } = await db.query<DepositRow>("select * from deposits where id = $1", [d.id]);
    const c = current[0]!;
    if (c.status !== "created") throw conflict("not_open", `this deposit is ${c.status}`);
    if (c.setup_wallet && c.setup_wallet !== wallet) {
      throw conflict("deposit_has_wallet", "This deposit is already setting up another wallet.");
    }
    throw new HttpError(429, "daily_new_wallet_limit", "Too many new wallets for this app today. Try again tomorrow.");
  }

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
    const app = currentApp(res);
    const deposit = await openDeposit(body, app);
    const { publicKey, swishId } = await passkeyFor(body.credential_id);
    const walletAddress = address(body.wallet);
    const wallet = createNoopSigner(walletAddress);
    const mint = deps.usdcMint;

    await requireFunds(walletAddress, deposit);
    const [authority, linkedTo] = await Promise.all([
      chain.subscriptionAuthority(walletAddress, mint),
      chain.linkedSwishId(walletAddress),
    ]);
    if (linkedTo && linkedTo !== swishId) {
      throw conflict("wallet_linked_elsewhere", "This wallet is already linked to another Swish ID.");
    }
    await bindWallet(deposit, app, walletAddress, !linkedTo);

    if (!authority) {
      const [userAta] = await findAssociatedTokenPda({ owner: walletAddress, mint, tokenProgram: TOKEN_PROGRAM });
      const ix = await getInitSubscriptionAuthorityOverlayInstructionAsync({
        owner: wallet,
        payer: chain.sponsor,
        tokenMint: mint,
        tokenProgram: TOKEN_PROGRAM,
        userAta,
      });
      return respond(res, deposit.id, "authorize", [ix]);
    }

    const allowances = await chain.allowances(walletAddress, mint);
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
    return respond(res, deposit.id, "allow", instructions);
  });

  /** How much Swish can still pull from this wallet (for "Left now"). */
  router.post("/v1/setup/wallet/allowance", publishable, async (req, res) => {
    const body = walletRef.parse(req.body);
    const walletAddress = address(body.wallet);
    const [allowances, balance] = await Promise.all([
      chain.allowances(walletAddress, deps.usdcMint),
      chain.tokenBalance(walletAddress, deps.usdcMint),
    ]);
    const left = leftOf(allowances);
    const limit = await limitOf(walletAddress, allowances, left);
    res.json({
      wallet: walletAddress,
      left: fromBaseUnits(left, USDC_DECIMALS),
      // The limit as last set. Left out when it could not be read in time.
      ...(limit === null ? {} : { limit: fromBaseUnits(limit, USDC_DECIMALS) }),
      balance: fromBaseUnits(balance ?? 0n, USDC_DECIMALS),
      token: "USDC",
    });
  });

  /**
   * Unlinks a wallet from its Swish ID and cancels what is left of its
   * limit, in one transaction the wallet signs. Submit it like a setup step.
   * No deposit needed: the rent that comes back to Swish is worth more than
   * the fee, and only a wallet that is linked has anything to unlink.
   */
  router.post("/v1/setup/wallet/unlink", publishable, async (req, res) => {
    const body = unlinkBody.parse(req.body);
    const walletAddress = address(body.wallet);
    const wallet = createNoopSigner(walletAddress);
    const [link, allowances] = await Promise.all([
      chain.linkedWallet(walletAddress),
      chain.allowances(walletAddress, deps.usdcMint),
    ]);
    if (!link) throw badRequest("not_linked", "This wallet is not linked to Swish.");
    const instructions = allowances.map((a) =>
      getRevokeDelegationOverlayInstruction({ authority: wallet, delegationAccount: a.address, receiver: chain.sponsor.address }),
    );
    instructions.push(await unlinkWalletInstruction(wallet, link.swishId, link.rentPayer));
    return respond(res, UNLINK, "unlink", instructions);
  });

  /**
   * Adds to a linked wallet's limit: the new limit is what is left plus
   * `add`. The old allowance is revoked (its rent back to Swish) and one for
   * the new total created at the next nonce, in one transaction the wallet
   * signs once. Submit it like any setup step.
   */
  router.post("/v1/setup/wallet/limit", publishable, async (req, res) => {
    const body = limitBody.parse(req.body);
    const app = currentApp(res);
    const deposit = await openDeposit(body, app);
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
    await requireFunds(walletAddress, deposit);
    await bindWallet(deposit, app, walletAddress, false);
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
    return respond(res, deposit.id, "limit", instructions, {
      left_now: fromBaseUnits(left, USDC_DECIMALS),
      new_limit: fromBaseUnits(newLimit, USDC_DECIMALS),
    });
  });

  const current = (allowances: Allowance[]) => {
    const now = BigInt(Math.floor(Date.now() / 1000));
    return allowances.filter((a) => a.expiryTs === 0n || a.expiryTs >= now);
  };

  /** What is left across a wallet's current allowances (normally just one). */
  const leftOf = (allowances: Allowance[]) => current(allowances).reduce((sum, a) => sum + a.amount, 0n);

  /**
   * The limit the wallet's allowance was created with, for "96 of 100 left".
   * The chain is the source: the allowance's history is read once, kept, and
   * after that only what is new is looked at. For display only, so it never
   * holds the answer up or fails it: null when it is not known in time.
   */
  async function limitOf(wallet: Address, allowances: Allowance[], left: bigint): Promise<bigint | null> {
    const [only, ...others] = current(allowances);
    if (!only || others.length || left === 0n) return null;
    const allowance = only.address;
    const quiet = () => ({ rows: [] });
    const { rows } = await db
      .query<{ amount: string; read_to: string }>("select amount, read_to from wallet_limits where allowance = $1", [allowance])
      .catch(quiet);
    const kept = rows[0];
    const read = chain
      .limitSet(allowance, kept?.read_to)
      .then(async ({ newest, amount }) => {
        if (amount !== null && newest) {
          await db
            .query(
              `insert into wallet_limits (allowance, wallet, amount, read_to) values ($1, $2, $3, $4)
               on conflict (allowance) do update
               set wallet = excluded.wallet, amount = excluded.amount, read_to = excluded.read_to, updated_at = now()`,
              [allowance, wallet, amount.toString(), newest],
            )
            .catch(quiet);
          return amount;
        }
        if (kept && newest) {
          await db
            .query("update wallet_limits set read_to = $2, updated_at = now() where allowance = $1", [allowance, newest])
            .catch(quiet);
        }
        return kept ? BigInt(kept.amount) : null;
      })
      .catch(() => null);
    const limit = await Promise.race([read, new Promise<null>((resolve) => setTimeout(() => resolve(null), LIMIT_WAIT_MS))]);
    return limit !== null && limit >= left ? limit : null;
  }

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
    depositId: string,
    step: "authorize" | "allow" | "limit" | "unlink",
    instructions: Parameters<typeof chain.buildForWallet>[0],
    extra: Record<string, string> = {},
  ) {
    const tx = await chain.buildForWallet(instructions);
    res.json({
      done: false,
      step,
      ...extra,
      transaction: getBase64Decoder().decode(tx.wire),
      token: seal(depositId, tx.messageBytes),
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
    const depositId = body.token.split(".")[0]!;
    if (!safeEqual(seal(depositId, new Uint8Array(tx.messageBytes)), body.token)) {
      throw badRequest("invalid_transaction", "this is not the transaction we prepared");
    }
    const missing = Object.entries(tx.signatures).filter(
      ([signer, sig]) => signer !== chain.sponsor.address && sig === null,
    );
    if (missing.length) throw badRequest("unsigned", "the wallet has not signed this transaction");
    if (depositId !== UNLINK) {
      // Swish pays a fee per transaction: a few per deposit, while it is open.
      const { rows: counted } = await db.query(
        `update deposits set setup_txs = setup_txs + 1, updated_at = now()
         where id = $1 and status = 'created' and setup_txs < $2 returning id`,
        [depositId, SETUP_TRANSACTIONS_PER_DEPOSIT],
      );
      if (!counted[0]) {
        throw new HttpError(429, "setup_limit", "Too many setup transactions for this deposit. Start a new deposit.");
      }
    }
    let signature: string;
    try {
      signature = await chain.sendWalletSigned(tx);
    } catch (e) {
      if (!blockhashExpired(e)) throw e;
      // An expired transaction never reached the chain, so it did not use
      // one of the setup transactions this deposit may ask Swish to pay for.
      if (depositId !== UNLINK) {
        await db.query("update deposits set setup_txs = greatest(setup_txs - 1, 0) where id = $1", [depositId]);
      }
      throw new HttpError(409, "transaction_expired", "The wallet approval took too long. Try again and sign within one minute.");
    }
    res.json({ signature });
  });

  return router;
}
