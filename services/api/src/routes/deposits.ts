import { randomUUID } from "node:crypto";

import { address, isAddress, type Address } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token";
import { Router, type Response } from "express";
import { z } from "zod";

import { fromBaseUnits, toBaseUnits } from "../amount.js";
import { currentApp, requirePublishableKey, requireSecretKey } from "../auth.js";
import { ChainError } from "../chain/client.js";
import { pullChallenge, pullInstruction, receiptPda, swishIdPda, uuidBytes } from "../chain/program.js";
import { PasskeyError, b64url, fromB64url, secp256r1Instruction, verifyAssertion } from "../chain/webauthn.js";
import { MIN_DEPOSIT, SIGNATURE_LIFETIME_SECONDS, USDC_DECIMALS, type AppRow, type Deps } from "../context.js";
import type { Db } from "../db.js";
import { HttpError, badRequest, notFound } from "../http.js";
import { hashKey, newClientSecret, safeEqual } from "../keys.js";
import { sendWebhook } from "../webhooks.js";

export interface DepositRow {
  id: string;
  app_id: string;
  mint: string;
  destination_owner: string;
  destination: string;
  amount: string;
  reference: string | null;
  client_secret_hash: string;
  status: "created" | "submitted" | "succeeded" | "failed";
  expires_at: Date | null;
  swish_id: string | null;
  wallet: string | null;
  signature: string | null;
  error: string | null;
  setup_wallet: string | null;
  setup_new_wallet: boolean;
  setup_txs: number;
  created_at: Date;
}

/** What apps (and their webhooks) see of a deposit. */
export function depositView(d: DepositRow) {
  return {
    id: d.id,
    status: d.status,
    amount: fromBaseUnits(d.amount, USDC_DECIMALS),
    token: "USDC",
    destination: d.destination_owner,
    reference: d.reference,
    signature: d.signature,
    error: d.error,
    /** Which of the user's wallets paid; null until the deposit is submitted. */
    wallet: d.wallet,
    created_at: new Date(d.created_at).toISOString(),
  };
}

const solanaAddress = z.string().refine(isAddress, "not a Solana address");
const uuid = z.string().uuid();

/** The most deposits one list call returns (demo only, see the route). */
const LIST_MAX = 1000;

const listQuery = z.object({
  wallet: solanaAddress.optional(),
  status: z.enum(["created", "submitted", "succeeded", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(LIST_MAX).default(100),
});

const createBody = z.object({
  amount: z.string().refine((a) => {
    try {
      return toBaseUnits(a, USDC_DECIMALS) >= toBaseUnits(MIN_DEPOSIT, USDC_DECIMALS);
    } catch {
      return false;
    }
  }, `at least ${MIN_DEPOSIT} USDC, with at most 6 decimals, as a string, e.g. "12.50"`),
  token: z.literal("USDC"),
  /** The user's own address in your app: the deposit lands in its USDC account. */
  destination: solanaAddress,
  reference: z.string().min(1).max(200).optional(),
});

const widgetBody = z.object({ client_secret: z.string().min(1) });

/** A Face ID approval of this deposit, as the browser returned it. */
const approvalBody = widgetBody.extend({
  credential_id: z.string().min(1),
  authenticator_data: z.string().min(1),
  client_data_json: z.string().min(1),
  signature: z.string().min(1),
});

const submitBody = approvalBody.extend({
  /** Which of the user's linked wallets pays; any that can, when left out. */
  wallet: solanaAddress.optional(),
});

async function loadDeposit(db: Db, id: string, app: AppRow): Promise<DepositRow> {
  if (!uuid.safeParse(id).success) throw notFound("deposit");
  const { rows } = await db.query<DepositRow>("select * from deposits where id = $1 and app_id = $2", [id, app.id]);
  if (!rows[0]) throw notFound("deposit");
  return rows[0];
}

/** The widget proves it holds this deposit's client secret. */
export async function loadDepositForWidget(db: Db, id: string, clientSecret: string, app: AppRow): Promise<DepositRow> {
  const d = await loadDeposit(db, id, app);
  if (!safeEqual(d.client_secret_hash, hashKey(clientSecret))) throw notFound("deposit");
  return d;
}

export function depositsRouter(deps: Deps): Router {
  const router = Router();
  const { db, chain } = deps;
  const secret = requireSecretKey(deps);
  const publishable = requirePublishableKey(deps);

  const load = (id: string, app: AppRow) => loadDeposit(db, id, app);
  const loadForWidget = (id: string, clientSecret: string, res: Response) =>
    loadDepositForWidget(db, id, clientSecret, currentApp(res));

  async function update(id: string, fields: Partial<DepositRow>): Promise<DepositRow> {
    const keys = Object.keys(fields);
    const set = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const { rows } = await db.query<DepositRow>(
      `update deposits set ${set}, updated_at = now() where id = $1 returning *`,
      [id, ...keys.map((k) => fields[k as keyof DepositRow])],
    );
    return rows[0]!;
  }

  // ---- Your server (secret key) ----

  router.post("/v1/deposits", secret, async (req, res) => {
    const app = currentApp(res);
    const body = createBody.parse(req.body);
    const owner = address(body.destination);
    const destination = await chain.destinationFor(owner, deps.usdcMint);
    const id = randomUUID();
    const clientSecret = newClientSecret();
    try {
      const { rows } = await db.query<DepositRow>(
        `insert into deposits (id, app_id, mint, destination_owner, destination, amount, reference, client_secret_hash)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
        [
          id,
          app.id,
          deps.usdcMint,
          owner,
          destination,
          toBaseUnits(body.amount, USDC_DECIMALS).toString(),
          body.reference ?? null,
          hashKey(clientSecret),
        ],
      );
      res.status(201).json({ ...depositView(rows[0]!), client_secret: clientSecret });
    } catch (e) {
      if (String((e as { code?: string }).code) === "23505") {
        throw new HttpError(409, "duplicate_reference", "a deposit with this reference already exists");
      }
      throw e;
    }
  });

  /**
   * DEMO ONLY. Your app's deposits, newest first: all of them, or one
   * wallet's, or those in one status. Added so the demo page
   * (demo.swish.cash) can show a balance without a database of its own. Not
   * part of the documented API: no paging, and it may change or go. A real
   * app keeps its own ledger from the webhooks.
   */
  router.get("/v1/deposits", secret, async (req, res) => {
    const q = listQuery.parse(req.query);
    const { rows } = await db.query<DepositRow>(
      `select * from deposits
       where app_id = $1 and ($2::text is null or wallet = $2) and ($3::text is null or status = $3)
       order by created_at desc limit $4`,
      [currentApp(res).id, q.wallet ?? null, q.status ?? null, q.limit],
    );
    res.json({ data: rows.map(depositView) });
  });

  router.get("/v1/deposits/:id", secret, async (req, res) => {
    res.json(depositView(await reconcile(await load(String(req.params.id), currentApp(res)))));
  });

  // ---- The widget (publishable key + the deposit's client secret) ----

  /** What Face ID signs. Asking again replaces the previous one. */
  router.post("/v1/deposits/:id/challenge", publishable, async (req, res) => {
    const app = currentApp(res);
    const { client_secret } = widgetBody.parse(req.body);
    let d = await loadForWidget(String(req.params.id), client_secret, res);
    if (d.status !== "created") throw new HttpError(409, "not_open", `this deposit is ${d.status}`);
    const expiresAt = new Date(Math.floor(Date.now() / 1000 + SIGNATURE_LIFETIME_SECONDS) * 1000);
    d = await update(d.id, { expires_at: expiresAt });
    res.json({
      challenge: b64url(await challengeFor(d)),
      rp_id: deps.rpId,
      expires_at: expiresAt.toISOString(),
      amount: fromBaseUnits(d.amount, USDC_DECIMALS),
      token: "USDC",
      app: { name: app.name, website: app.website },
    });
  });

  /**
   * The wallets this deposit can come from, shown before any money moves.
   * Only someone holding a valid Face ID approval of this deposit gets them.
   */
  router.post("/v1/deposits/:id/sources", publishable, async (req, res) => {
    const body = approvalBody.parse(req.body);
    const d = await loadForWidget(String(req.params.id), body.client_secret, res);
    if (d.status !== "created") throw new HttpError(409, "not_open", `this deposit is ${d.status}`);
    if (!d.expires_at || new Date(d.expires_at).getTime() <= Date.now()) {
      throw new HttpError(409, "expired", "the approval expired; ask for a new challenge");
    }
    let swishId: Address;
    try {
      ({ swishId } = await approvedBy(d, body));
    } catch (e) {
      if (e instanceof PasskeyError) throw badRequest("passkey_rejected", e.message);
      throw e;
    }
    const amount = BigInt(d.amount);
    const mint = address(d.mint);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const wallets = await Promise.all(
      (await chain.linkedWallets(swishId)).map(async (wallet) => {
        const [balance, allowances] = await Promise.all([chain.tokenBalance(wallet, mint), chain.allowances(wallet, mint)]);
        const live = allowances.filter((a) => a.expiryTs === 0n || a.expiryTs >= now);
        return {
          wallet,
          balance: fromBaseUnits(balance ?? 0n, USDC_DECIMALS),
          left: fromBaseUnits(live.reduce((sum, a) => sum + a.amount, 0n), USDC_DECIMALS),
          enough: (balance ?? 0n) >= amount && live.some((a) => a.amount >= amount),
        };
      }),
    );
    res.json({ token: "USDC", wallets });
  });

  router.post("/v1/deposits/:id/submit", publishable, async (req, res) => {
    const app = currentApp(res);
    const body = submitBody.parse(req.body);
    const d = await loadForWidget(String(req.params.id), body.client_secret, res);

    // One submit at a time, and only while the approval is still valid.
    const { rows: claimed } = await db.query<DepositRow>(
      `update deposits set status = 'submitted', updated_at = now()
       where id = $1 and status = 'created' and expires_at > now() returning *`,
      [d.id],
    );
    if (!claimed[0]) {
      if (d.status !== "created") throw new HttpError(409, "not_open", `this deposit is ${d.status}`);
      throw new HttpError(409, "expired", "the approval expired; ask for a new challenge");
    }
    const deposit = claimed[0];

    let prepared;
    try {
      prepared = await prepareSubmit(deposit, body);
    } catch (e) {
      // Nothing was sent: the user can try again.
      await update(deposit.id, { status: "created" });
      if (e instanceof PasskeyError) throw badRequest("passkey_rejected", e.message);
      throw e;
    }

    let final: DepositRow;
    try {
      const signature = await chain.send(prepared.instructions);
      final = await update(deposit.id, {
        status: "succeeded",
        signature,
        swish_id: prepared.swishId,
        wallet: prepared.wallet,
      });
    } catch (e) {
      const signature = e instanceof ChainError ? (e.signature ?? null) : null;
      const settled = await chain.exists(await receiptPda(uuidBytes(deposit.id)));
      final = await update(deposit.id, {
        status: settled ? "succeeded" : "failed",
        signature,
        swish_id: prepared.swishId,
        wallet: prepared.wallet,
        error: settled ? null : (e as Error).message.slice(0, 500),
      });
    }
    void sendWebhook(deps, app, final);
    res.json(depositView(final));
  });

  async function challengeFor(d: DepositRow): Promise<Uint8Array> {
    return pullChallenge({
      clusterTag: await chain.clusterTag(),
      depositId: uuidBytes(d.id),
      appId: uuidBytes(d.app_id),
      mint: address(d.mint),
      destination: address(d.destination),
      amount: BigInt(d.amount),
      expiresAt: BigInt(Math.floor(new Date(d.expires_at!).getTime() / 1000)),
    });
  }

  /** Checks the approval is this deposit's, from a registered passkey. Throws PasskeyError. */
  async function approvedBy(d: DepositRow, body: z.infer<typeof approvalBody>) {
    const { rows } = await db.query<{ public_key: Uint8Array; swish_id: string }>(
      "select public_key, swish_id from passkeys where credential_id = $1",
      [body.credential_id],
    );
    const passkey = rows[0];
    if (!passkey) throw new HttpError(404, "no_swish_id", "No Swish passkey found. Set up once, then try again.");
    const publicKey = new Uint8Array(passkey.public_key);

    const { compactSignature, message } = verifyAssertion(
      publicKey,
      {
        authenticatorData: fromB64url(body.authenticator_data),
        clientDataJson: fromB64url(body.client_data_json),
        signature: fromB64url(body.signature),
      },
      { rpId: deps.rpId, challenge: await challengeFor(d) },
    );

    return { publicKey, compactSignature, message, swishId: await swishIdPda(publicKey) };
  }

  async function prepareSubmit(d: DepositRow, body: z.infer<typeof submitBody>) {
    const { publicKey, compactSignature, message, swishId } = await approvedBy(d, body);
    const amount = BigInt(d.amount);
    const mint = address(d.mint);
    const source = await chain.findSource(swishId, mint, amount, body.wallet ? address(body.wallet) : undefined);
    if (!source) {
      throw new HttpError(
        402,
        "no_funds",
        body.wallet
          ? "That wallet does not have enough USDC and allowance for this deposit"
          : "None of your linked wallets has enough USDC and allowance for this deposit",
      );
    }

    const instructions = [
      // The user's account in the app may not exist yet; Swish pays for it.
      await getCreateAssociatedTokenIdempotentInstructionAsync({
        payer: chain.sponsor,
        owner: address(d.destination_owner),
        mint,
      }),
      // The signature check must sit right before the pull.
      secp256r1Instruction(publicKey, compactSignature, message),
      await pullInstruction(
        {
          payer: chain.sponsor,
          appId: uuidBytes(d.app_id),
          swishId,
          wallet: source.wallet,
          depositId: uuidBytes(d.id),
          delegation: source.delegation,
          subscriptionAuthority: source.subscriptionAuthority,
          source: source.tokenAccount,
          receiver: address(d.destination) as Address,
          mint,
        },
        {
          depositId: uuidBytes(d.id),
          amount,
          expiresAt: BigInt(Math.floor(new Date(d.expires_at!).getTime() / 1000)),
          clientDataJson: fromB64url(body.client_data_json),
        },
      ),
    ];
    return { instructions, swishId, wallet: source.wallet };
  }

  /** A submit that timed out may still have landed: the receipt says so. */
  async function reconcile(d: DepositRow): Promise<DepositRow> {
    if (d.status !== "submitted") return d;
    if (await chain.exists(await receiptPda(uuidBytes(d.id)))) return update(d.id, { status: "succeeded" });
    return d;
  }

  return router;
}
