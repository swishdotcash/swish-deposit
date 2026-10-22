import { randomUUID } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import {
  SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND,
  SolanaError,
  generateKeyPairSigner,
  getAddressDecoder,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { Allowance, BeforeBroadcast, Chain, Source, TransactionStatus } from "../src/chain/client.js";
import { ChainError } from "../src/chain/client.js";
import { PROGRAM_ID, SECP256R1_PROGRAM, TOKEN_PROGRAM, paymentCommitment, swishIdPda, uuidBytes } from "../src/chain/program.js";
import { InvalidReceiptError, type DepositReceipt } from "../src/chain/receipt.js";
import { b64url, fromB64url } from "../src/chain/webauthn.js";
import type { Deps } from "../src/context.js";
import { migrate, type Db } from "../src/db.js";
import { hashKey, newPublishableKey, newSecretKey } from "../src/keys.js";
import { expectedPayment, reconcilePendingDeposits } from "../src/settlement.js";
import { deliverPendingWebhooks, signWebhook } from "../src/webhooks.js";
import type { DepositRow } from "../src/routes/deposits.js";
import { fakePasskey } from "./helpers.js";

const ORIGIN = "https://app.example.com";
const FRAME = "https://pay.example.com";
const addr = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const USDC = addr(9);
const USER_IN_APP = addr(20);

class FakeChain implements Chain {
  sent: Instruction[][] = [];
  source: Source | null = {
    wallet: addr(30),
    tokenAccount: addr(31),
    subscriptionAuthority: addr(32),
    delegation: addr(33),
  };
  fail: Error | null = null;
  existing = new Set<string>();
  built: Instruction[][] = [];
  authority: { initId: bigint } | null = null;
  walletAllowances: Allowance[] = [];
  linkedTo: Address | null = null;
  balance: bigint | null = 1_000_000_000n;
  constructor(readonly sponsor: KeyPairSigner, readonly appId: string) {}
  async clusterTag() {
    return new Uint8Array(32).fill(1);
  }
  async destinationFor(owner: Address, mint: Address) {
    return (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM }))[0];
  }
  async findSource(_swishId: Address, _mint: Address, _amount: bigint, only?: Address) {
    await this.beforeSource?.();
    return this.source && (!only || only === this.source.wallet) ? this.source : null;
  }
  async linkedWallets() {
    return this.source ? [this.source.wallet] : [];
  }
  async subscriptionAuthority() {
    return this.authority;
  }
  async allowances() {
    return this.walletAllowances;
  }
  async linkedSwishId() {
    return this.linkedTo;
  }
  limitHistory: { newest: string | null; amount: bigint | null } = { newest: null, amount: null };
  limitReads: [Address, string | undefined][] = [];
  limitFails = false;
  async limitSet(allowance: Address, after?: string) {
    this.limitReads.push([allowance, after]);
    if (this.limitFails) throw new Error("rpc down");
    return this.limitHistory;
  }
  async linkedWallet() {
    return this.linkedTo ? { swishId: this.linkedTo, rentPayer: this.sponsor.address } : null;
  }
  /** Receipts on chain, by deposit id bytes (hex). */
  receipts = new Map<string, DepositReceipt>();
  receiptError: Error | null = null;
  outcome: TransactionStatus = "pending";
  finalizedExpired = false;
  landBeforeError = false;
  receiptLag = false;
  beforeSend: (() => Promise<void>) | null = null;
  beforeSource: (() => Promise<void>) | null = null;
  async receipt(depositId: Uint8Array) {
    if (this.receiptError) throw this.receiptError;
    if (this.receiptLag) return null;
    return this.receipts.get(Buffer.from(depositId).toString("hex")) ?? null;
  }
  async transactionStatus() {
    return this.outcome;
  }
  async approvalExpired() {
    return this.finalizedExpired;
  }
  async tokenBalance() {
    return this.balance;
  }
  async exists(a: Address) {
    return this.existing.has(a);
  }
  async send(instructions: Instruction[], beforeBroadcast?: BeforeBroadcast) {
    await beforeBroadcast?.({ signature: this.fail instanceof ChainError ? this.fail.signature ?? "5ig" : "5ig", lastValidBlockHeight: 100n });
    await this.beforeSend?.();
    this.sent.push(instructions);
    if (!this.fail || this.landBeforeError) {
      const ix = instructions.at(-1)!;
      const data = Buffer.from(ix.data!);
      const depositId = data.subarray(8, 24);
      this.receipts.set(depositId.toString("hex"), {
        rentPayer: this.sponsor.address,
        wallet: this.source!.wallet,
        swishId: ix.accounts![3]!.address,
        commitment: paymentCommitment({
          clusterTag: await this.clusterTag(), programId: PROGRAM_ID, depositId,
          appId: uuidBytes(this.appId), mint: ix.accounts![11]!.address,
          destination: ix.accounts![10]!.address, amount: data.readBigUInt64LE(25),
        }),
      });
    }
    if (this.fail) throw this.fail;
    return "5ig";
  }
  async sendAs(): Promise<never> {
    throw new Error("not in these tests");
  }
  async buildForWallet(instructions: Instruction[]) {
    this.built.push(instructions);
    return { wire: new Uint8Array([1, 2, 3]), messageBytes: new Uint8Array([4, 5, 6]) };
  }
  decode() {
    // What a wallet hands back: our message, signed by it.
    return { messageBytes: new Uint8Array([4, 5, 6]), signatures: { [addr(40)]: new Uint8Array(64) } } as never;
  }
  walletSigned = 0;
  walletSignedError: Error | null = null;
  async sendWalletSigned() {
    this.walletSigned++;
    if (this.walletSignedError) throw this.walletSignedError;
    return "5etup";
  }
}

interface World {
  pg: PGlite;
  deps: Deps;
  chain: FakeChain;
  webhooks: { url: string; body: string; signature: string }[];
  keys: { publishable: string; secret: string; secretHash: string };
  api: ReturnType<typeof createApp>;
}

async function world(): Promise<World> {
  const pg = new PGlite();
  const db: Db = {
    query: (sql, params) => pg.query(sql, params) as never,
    exec: (sql) => pg.exec(sql),
    transaction: (run) => pg.transaction((tx) => run({ query: (sql, params) => tx.query(sql, params) as never })),
  };
  await migrate(db);
  const publishable = newPublishableKey();
  const secret = newSecretKey();
  const appId = randomUUID();
  await db.query(
    `insert into apps (id, name, website, contact_email, allowed_origins, publishable_key, secret_key_hash, webhook_url)
     values ($1, 'Demo', 'https://example.com', 'ops@example.com', $2, $3, $4, 'https://example.com/hook')`,
    [appId, [ORIGIN], publishable, hashKey(secret)],
  );
  const chain = new FakeChain(await generateKeyPairSigner(), appId);
  const webhooks: World["webhooks"] = [];
  const deps: Deps = {
    db,
    chain,
    rpId: "localhost",
    usdcMint: USDC,
    serverSecret: Buffer.alloc(32, 7),
    frameOrigins: [FRAME],
    fetch: (async (url: string, init: RequestInit) => {
      webhooks.push({ url, body: String(init.body), signature: String((init.headers as Record<string, string>)["swish-signature"]) });
      return new Response(null, { status: 200 });
    }) as typeof fetch,
  };
  return { pg, deps, chain, webhooks, keys: { publishable, secret, secretHash: hashKey(secret) }, api: createApp(deps) };
}

let w: World;
beforeEach(async () => {
  w = await world();
});
afterEach(async () => {
  await w.pg.close();
});

const server = () => ({
  post: (path: string, body: object) => request(w.api).post(path).set("authorization", `Bearer ${w.keys.secret}`).send(body),
  get: (path: string) => request(w.api).get(path).set("authorization", `Bearer ${w.keys.secret}`),
});
const widget = (path: string, body: object, origin = ORIGIN) =>
  request(w.api).post(path).set("x-swish-key", w.keys.publishable).set("origin", origin).send(body);

async function createDeposit(amount = "12.5", reference?: string) {
  const res = await server().post("/v1/deposits", { amount, token: "USDC", destination: USER_IN_APP, reference });
  expect(res.status).toBe(201);
  return res.body as { id: string; client_secret: string };
}

async function addReceipt(id: string, commitment?: Uint8Array) {
  const d = (await w.deps.db.query<DepositRow>("select * from deposits where id = $1", [id])).rows[0]!;
  w.chain.receipts.set(Buffer.from(uuidBytes(id)).toString("hex"), {
    rentPayer: w.chain.sponsor.address,
    commitment: commitment ?? await expectedPayment(w.deps, d),
    wallet: addr(30), swishId: addr(34),
  });
}

async function setUpUser() {
  const pk = fakePasskey();
  const credentialId = b64url(new Uint8Array(16).fill(4));
  const res = await widget("/v1/setup/passkey", { credential_id: credentialId, public_key: b64url(pk.spki) });
  expect(res.status).toBe(201);
  expect(res.body.swish_id).toBe(await swishIdPda(pk.publicKey));
  return { pk, credentialId };
}

async function approve(d: { id: string; client_secret: string }, user: Awaited<ReturnType<typeof setUpUser>>, opts = {}) {
  const c = await widget(`/v1/deposits/${d.id}/challenge`, { client_secret: d.client_secret });
  expect(c.status).toBe(200);
  const a = user.pk.assert(fromB64url(c.body.challenge), opts);
  return widget(`/v1/deposits/${d.id}/submit`, {
    client_secret: d.client_secret,
    credential_id: user.credentialId,
    authenticator_data: b64url(a.authenticatorData),
    client_data_json: b64url(a.clientDataJson),
    signature: b64url(a.signature),
  });
}

describe("your server creates deposits", () => {
  it("needs the secret key", async () => {
    const res = await request(w.api).post("/v1/deposits").send({ amount: "1", token: "USDC", destination: USER_IN_APP });
    expect(res.status).toBe(401);
    const wrong = await request(w.api).post("/v1/deposits").set("authorization", "Bearer swishsec_nope").send({});
    expect(wrong.status).toBe(401);
  });

  it("returns the deposit and a client secret for the widget", async () => {
    const res = await server().post("/v1/deposits", { amount: "12.5", token: "USDC", destination: USER_IN_APP, reference: "order-1" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "created", amount: "12.5", token: "USDC", destination: USER_IN_APP, reference: "order-1" });
    expect(res.body.client_secret).toMatch(/^swishcs_/);
    const read = await server().get(`/v1/deposits/${res.body.id}`);
    expect(read.body).toMatchObject({ id: res.body.id, status: "created" });
    expect(read.body.client_secret).toBeUndefined();
  });

  it("refuses less than 1 USDC: below that the rent Swish pays is worth more than the deposit", async () => {
    for (const amount of ["0.999999", "0.000001", "0"]) {
      const res = await server().post("/v1/deposits", { amount, token: "USDC", destination: USER_IN_APP });
      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("at least 1 USDC");
    }
    expect((await createDeposit("1")).id).toBeDefined();
  });

  it("refuses bad input and duplicate references", async () => {
    for (const amount of ["0", "-1", "1.1234567", "abc"]) {
      const res = await server().post("/v1/deposits", { amount, token: "USDC", destination: USER_IN_APP });
      expect(res.status).toBe(400);
    }
    expect((await server().post("/v1/deposits", { amount: "1", token: "USDC", destination: "nope" })).status).toBe(400);
    await createDeposit("1", "same");
    expect((await server().post("/v1/deposits", { amount: "1", token: "USDC", destination: USER_IN_APP, reference: "same" })).status).toBe(409);
  });
});

describe("the widget", () => {
  it("needs the publishable key, an allowed origin and the deposit's client secret", async () => {
    const d = await createDeposit();
    expect((await request(w.api).post(`/v1/deposits/${d.id}/challenge`).send({ client_secret: d.client_secret })).status).toBe(401);
    expect((await widget(`/v1/deposits/${d.id}/challenge`, { client_secret: d.client_secret }, "https://evil.example")).status).toBe(403);
    expect((await widget(`/v1/deposits/${d.id}/challenge`, { client_secret: "swishcs_wrong" })).status).toBe(404);
    const ok = await widget(`/v1/deposits/${d.id}/challenge`, { client_secret: d.client_secret });
    expect(ok.status).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(ok.body).toMatchObject({ rp_id: "localhost", amount: "12.5", token: "USDC", app: { name: "Demo" } });
  });

  it("is let in from the Swish frame only for a page the app registered", async () => {
    const d = await createDeposit();
    const fromFrame = (page?: string) => {
      const req = request(w.api).post(`/v1/deposits/${d.id}/challenge`).set("x-swish-key", w.keys.publishable).set("origin", FRAME);
      return (page ? req.set("x-swish-app-origin", page) : req).send({ client_secret: d.client_secret });
    };
    expect((await fromFrame()).status).toBe(403);
    expect((await fromFrame("https://evil.example")).status).toBe(403);
    const ok = await fromFrame(ORIGIN);
    expect(ok.status).toBe(200);
    expect(ok.headers["access-control-allow-origin"]).toBe(FRAME);
  });

  it("answers the browser's preflight", async () => {
    const res = await request(w.api).options("/v1/deposits/x/challenge").set("origin", ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-headers"]).toContain("X-Swish-Key");
  });
});

describe("one Face ID moves the money", () => {
  it("sends the signature check right before the pull, then reports success", async () => {
    const user = await setUpUser();
    const d = await createDeposit("12.5", "order-7");
    const res = await approve(d, user);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "succeeded", signature: "5ig", amount: "12.5" });

    const [ixs] = w.chain.sent;
    expect(ixs!.map((i) => i.programAddress)).toEqual([
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      SECP256R1_PROGRAM,
      PROGRAM_ID,
    ]);
    const pull = Buffer.from(ixs![2]!.data!);
    expect(pull.subarray(8, 24)).toEqual(Buffer.from(d.id.replace(/-/g, ""), "hex"));
    expect(pull.readBigUInt64LE(25)).toBe(12_500_000n);

    await vi.waitFor(() => expect(w.webhooks).toHaveLength(1));
    const hook = w.webhooks[0]!;
    expect(JSON.parse(hook.body)).toMatchObject({ type: "deposit.succeeded", data: { id: d.id, reference: "order-7" } });
    const t = Number(/t=(\d+)/.exec(hook.signature)![1]);
    expect(hook.signature).toBe(signWebhook(w.keys.secretHash, t, hook.body));
  });

  it("lists an app's deposits, newest first, by wallet and by status (demo only)", async () => {
    const user = await setUpUser();
    const paid = await createDeposit("12.5");
    const res = await approve(paid, user);
    const wallet = res.body.wallet as string;
    expect(wallet).toBeTruthy();
    const open = await createDeposit("3");

    const all = await server().get("/v1/deposits");
    expect(all.status).toBe(200);
    expect(all.body.data.map((d: { id: string }) => d.id)).toEqual([open.id, paid.id]);
    // What a wallet has put into the app: its deposits that landed.
    const theirs = await server().get(`/v1/deposits?wallet=${wallet}&status=succeeded`);
    expect(theirs.body.data).toHaveLength(1);
    expect(theirs.body.data[0]).toMatchObject({ id: paid.id, amount: "12.5", status: "succeeded", wallet });
    expect((await server().get(`/v1/deposits?wallet=${addr(99)}`)).body.data).toEqual([]);
    expect((await server().get("/v1/deposits?status=created")).body.data.map((d: { id: string }) => d.id)).toEqual([open.id]);
    expect((await server().get("/v1/deposits?limit=1")).body.data).toHaveLength(1);
    expect((await server().get("/v1/deposits?wallet=nope")).status).toBe(400);
    // The webhook names the wallet too.
    await vi.waitFor(() => expect(w.webhooks).toHaveLength(1));
    expect(JSON.parse(w.webhooks[0]!.body).data.wallet).toBe(wallet);
  });

  it("shows the wallets a deposit can come from, only against a Face ID approval of it", async () => {
    const user = await setUpUser();
    const d = await createDeposit("12.5");
    const c = await widget(`/v1/deposits/${d.id}/challenge`, { client_secret: d.client_secret });
    const a = user.pk.assert(fromB64url(c.body.challenge));
    const approval = {
      client_secret: d.client_secret,
      credential_id: user.credentialId,
      authenticator_data: b64url(a.authenticatorData),
      client_data_json: b64url(a.clientDataJson),
      signature: b64url(a.signature),
    };
    w.chain.walletAllowances = [{ address: addr(50), nonce: 0n, subscriptionAuthority: addr(51), amount: 37_500_000n, expiryTs: 0n }];
    const res = await widget(`/v1/deposits/${d.id}/sources`, approval);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: "USDC", wallets: [{ wallet: addr(30), balance: "1000", left: "37.5", enough: true }] });

    // A limit below the deposit is shown as not enough.
    w.chain.walletAllowances = [{ address: addr(50), nonce: 0n, subscriptionAuthority: addr(51), amount: 5_000_000n, expiryTs: 0n }];
    const low = await widget(`/v1/deposits/${d.id}/sources`, approval);
    expect(low.body.wallets[0]).toMatchObject({ left: "5", enough: false });

    // No approval, or another deposit's approval: nothing.
    const other = await createDeposit("12.5");
    const oc = await widget(`/v1/deposits/${other.id}/challenge`, { client_secret: other.client_secret });
    expect(oc.status).toBe(200);
    const wrong = await widget(`/v1/deposits/${other.id}/sources`, { ...approval, client_secret: other.client_secret });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("passkey_rejected");
    const none = await widget(`/v1/deposits/${d.id}/sources`, { client_secret: d.client_secret });
    expect(none.status).toBe(400);

    // Nothing moved, and the same approval still pays, from the wallet chosen.
    expect(w.chain.sent).toHaveLength(0);
    const refused = await widget(`/v1/deposits/${d.id}/submit`, { ...approval, wallet: addr(77) });
    expect(refused.status).toBe(402);
    const paid = await widget(`/v1/deposits/${d.id}/submit`, { ...approval, wallet: addr(30) });
    expect(paid.status).toBe(200);
    expect(paid.body).toMatchObject({ status: "succeeded", wallet: addr(30) });
  });

  it("works once", async () => {
    const user = await setUpUser();
    const d = await createDeposit();
    expect((await approve(d, user)).status).toBe(200);
    const again = await widget(`/v1/deposits/${d.id}/challenge`, { client_secret: d.client_secret });
    expect(again.status).toBe(409);
  });

  it("refuses a bad approval without spending anything, and lets the user try again", async () => {
    const user = await setUpUser();
    const d = await createDeposit();
    const bad = await approve(d, user, { flags: 0x01 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("passkey_rejected");
    expect(w.chain.sent).toHaveLength(0);
    expect((await server().get(`/v1/deposits/${d.id}`)).body.status).toBe("created");
    expect((await approve(d, user)).body.status).toBe("succeeded");
  });

  it("says so when no linked wallet can pay", async () => {
    const user = await setUpUser();
    w.chain.source = null;
    const res = await approve(await createDeposit(), user);
    expect(res.status).toBe(402);
    expect(w.chain.sent).toHaveLength(0);
  });

  it("points an unknown passkey to setup", async () => {
    const d = await createDeposit();
    const c = await widget(`/v1/deposits/${d.id}/challenge`, { client_secret: d.client_secret });
    const a = fakePasskey().assert(fromB64url(c.body.challenge));
    const res = await widget(`/v1/deposits/${d.id}/submit`, {
      client_secret: d.client_secret,
      credential_id: "unknown",
      authenticator_data: b64url(a.authenticatorData),
      client_data_json: b64url(a.clientDataJson),
      signature: b64url(a.signature),
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("no_swish_id");
  });

  it("marks a failed transaction failed and tells your server", async () => {
    const user = await setUpUser();
    w.chain.fail = new ChainError("transaction failed: InsufficientFunds", "sig-x");
    w.chain.outcome = "failed";
    const res = await approve(await createDeposit(), user);
    expect(res.body).toMatchObject({ status: "failed", signature: "sig-x" });
    await vi.waitFor(() => expect(w.webhooks).toHaveLength(1));
    expect(JSON.parse(w.webhooks[0]!.body).type).toBe("deposit.failed");
  });

  it("counts a timed-out send as done when the receipt is on chain", async () => {
    const user = await setUpUser();
    const d = await createDeposit();
    w.chain.fail = new ChainError("transaction not confirmed in time", "sig-y");
    w.chain.landBeforeError = true;
    expect((await approve(d, user)).body.status).toBe("succeeded");
  });

  it("persists the signed transaction and lifetime before broadcasting", async () => {
    const user = await setUpUser();
    const d = await createDeposit();
    w.chain.beforeSend = async () => {
      const row = (await w.deps.db.query("select signature, last_valid_block_height, status from deposits where id = $1", [d.id])).rows[0];
      expect(row).toMatchObject({ signature: "5ig", last_valid_block_height: "100", status: "submitted" });
    };
    expect((await approve(d, user)).body.status).toBe("succeeded");
  });

  it("does not overwrite the actual payer or broadcast after a worker settles during preparation", async () => {
    const user = await setUpUser();
    const d = await createDeposit();
    w.chain.beforeSource = async () => {
      await addReceipt(d.id);
      const receipt = w.chain.receipts.get(Buffer.from(uuidBytes(d.id)).toString("hex"))!;
      receipt.wallet = addr(99);
      receipt.swishId = addr(98);
      await reconcilePendingDeposits(w.deps);
    };
    const result = await approve(d, user);
    expect(result.body).toMatchObject({ status: "succeeded", wallet: addr(99) });
    expect(w.chain.sent).toHaveLength(0);
    await vi.waitFor(() => expect(w.webhooks).toHaveLength(1));
    expect(JSON.parse(w.webhooks[0]!.body).data.wallet).toBe(addr(99));
  });

  it.each([new ChainError("confirmation timed out", "sig-pending"), new Error("connection dropped after broadcast")])(
    "keeps an ambiguous send pending and credits late settlement after restart: %s", async (failure) => {
      const user = await setUpUser();
      const d = await createDeposit();
      w.chain.fail = failure;
      const pending = await approve(d, user);
      expect(pending.body.status).toBe("submitted");
      expect(pending.body.signature).toBeTruthy();
      expect(w.webhooks).toHaveLength(0);
      await addReceipt(d.id);
      // A background worker can complete this without another customer request.
      await reconcilePendingDeposits(w.deps);
      await deliverPendingWebhooks(w.deps);
      expect((await server().get(`/v1/deposits/${d.id}`)).body.status).toBe("succeeded");
      await vi.waitFor(() => expect(w.webhooks).toHaveLength(1));
      expect(JSON.parse(w.webhooks[0]!.body).type).toBe("deposit.succeeded");
    },
  );

  it("does not infer failure from a missing receipt, a processed status, or an RPC outage", async () => {
    const user = await setUpUser();
    const d = await createDeposit();
    w.chain.fail = new Error("RPC down");
    expect((await approve(d, user)).body.status).toBe("submitted");
    w.chain.receiptError = new Error("RPC still down");
    expect((await server().get(`/v1/deposits/${d.id}`)).body.status).toBe("submitted");
    expect(w.webhooks).toHaveLength(0);
    w.chain.receiptError = null;
    w.chain.outcome = "expired";
    expect((await server().get(`/v1/deposits/${d.id}`)).body.status).toBe("failed");
    await vi.waitFor(() => expect(w.webhooks).toHaveLength(1));
    expect(JSON.parse(w.webhooks[0]!.body).type).toBe("deposit.failed");
  });

  it("waits for the exact receipt even when the broadcast reports confirmation", async () => {
    const user = await setUpUser();
    const d = await createDeposit();
    w.chain.receiptLag = true;
    w.chain.outcome = "confirmed";
    expect((await approve(d, user)).body.status).toBe("submitted");
    expect(w.webhooks).toHaveLength(0);
    w.chain.receiptLag = false;
    expect((await server().get(`/v1/deposits/${d.id}`)).body.status).toBe("succeeded");
    await vi.waitFor(() => expect(w.webhooks).toHaveLength(1));
  });

  it("rejects a different payment that squatted the merchant deposit ID", async () => {
    const user = await setUpUser();
    const d = await createDeposit();
    await addReceipt(d.id, new Uint8Array(32).fill(99));
    w.chain.fail = new ChainError("receipt already exists", "sig-squatted");
    const result = await approve(d, user);
    expect(result.body).toMatchObject({ status: "failed", error: "on-chain receipt does not match the requested payment" });
    await vi.waitFor(() => expect(w.webhooks).toHaveLength(1));
    expect(JSON.parse(w.webhooks[0]!.body).type).toBe("deposit.failed");
  });

  it("never treats a spoofed or legacy receipt as proof of payment", async () => {
    const user = await setUpUser();
    w.chain.fail = new Error("send uncertain");
    w.chain.receiptError = new InvalidReceiptError("invalid receipt owner");
    const d = await createDeposit();
    expect((await approve(d, user)).body.status).toBe("submitted");
    expect(w.webhooks).toHaveLength(0);
  });

  it("refuses an approval that expired", async () => {
    {
      const user = await setUpUser();
      const d = await createDeposit();
      const c = await widget(`/v1/deposits/${d.id}/challenge`, { client_secret: d.client_secret });
      await w.deps.db.query("update deposits set expires_at = now() - interval '1 second' where id = $1", [d.id]);
      const a = user.pk.assert(fromB64url(c.body.challenge));
      const res = await widget(`/v1/deposits/${d.id}/submit`, {
        client_secret: d.client_secret,
        credential_id: user.credentialId,
        authenticator_data: b64url(a.authenticatorData),
        client_data_json: b64url(a.clientDataJson),
        signature: b64url(a.signature),
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("expired");
    }
  });
});

describe("setup", () => {
  /** The widget sets up for the deposit it holds. */
  const forDeposit = (d: { id: string; client_secret: string }) => ({ deposit_id: d.id, client_secret: d.client_secret });
  const prepare = (user: { credentialId: string }, d: { id: string; client_secret: string }, wallet = addr(40)) =>
    widget("/v1/setup/wallet/prepare", { credential_id: user.credentialId, wallet, allowance: "50", ...forDeposit(d) });

  it("registers a passkey once; the same id cannot be re-pointed at another key", async () => {
    const user = await setUpUser();
    const again = await widget("/v1/setup/passkey", { credential_id: user.credentialId, public_key: b64url(user.pk.spki) });
    expect(again.status).toBe(201);
    const hijack = await widget("/v1/setup/passkey", { credential_id: user.credentialId, public_key: b64url(fakePasskey().spki) });
    expect(hijack.status).toBe(409);
  });

  it("will not link a wallet that belongs to another Swish ID", async () => {
    const user = await setUpUser();
    w.chain.authority = { initId: 7n };
    w.chain.linkedTo = addr(41);
    const res = await prepare(user, await createDeposit());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("wallet_linked_elsewhere");
  });

  it("needs an open deposit from your server: the publishable key alone cannot make Swish pay", async () => {
    const user = await setUpUser();
    const bare = await widget("/v1/setup/wallet/prepare", { credential_id: user.credentialId, wallet: addr(40), allowance: "50" });
    expect(bare.status).toBe(400);
    const d = await createDeposit();
    const guessed = await prepare(user, { id: d.id, client_secret: "swishcs_guess" });
    expect(guessed.status).toBe(404);
    const made = await widget("/v1/setup/wallet/prepare", { credential_id: user.credentialId, wallet: addr(40), allowance: "50", deposit_id: randomUUID(), client_secret: "x" });
    expect(made.status).toBe(404);
    await w.deps.db.query("update deposits set status = 'succeeded' where id = $1", [d.id]);
    const done = await prepare(user, d);
    expect(done.status).toBe(409);
    expect(w.chain.built).toHaveLength(0);
  });

  it("needs the wallet to hold the deposit's amount before building anything", async () => {
    const user = await setUpUser();
    const d = await createDeposit("12.5");
    w.chain.balance = null;
    expect((await prepare(user, d)).body.error.code).toBe("no_usdc_account");
    w.chain.balance = 12_499_999n;
    const short = await prepare(user, d);
    expect(short.status).toBe(402);
    expect(short.body.error.code).toBe("not_enough_usdc");
    w.chain.balance = 12_500_000n;
    const ok = await prepare(user, d);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ done: false, step: "authorize" });
    expect(ok.body.token.startsWith(`${d.id}.`)).toBe(true);
  });

  it("sets up one wallet per deposit", async () => {
    const user = await setUpUser();
    const d = await createDeposit();
    expect((await prepare(user, d, addr(40))).status).toBe(200);
    expect((await prepare(user, d, addr(40))).status).toBe(200);
    const other = await prepare(user, d, addr(42));
    expect(other.status).toBe(409);
    expect(other.body.error.code).toBe("deposit_has_wallet");
  });

  it("caps the new wallets Swish pays for, per app per day; wallets already linked do not count", async () => {
    await w.deps.db.query("update apps set daily_new_wallets = 1");
    const user = await setUpUser();
    const first = await createDeposit();
    expect((await prepare(user, first, addr(40))).status).toBe(200);
    // the same deposit carrying on with its wallet is not a new one
    expect((await prepare(user, first, addr(40))).status).toBe(200);
    const capped = await prepare(user, await createDeposit(), addr(42));
    expect(capped.status).toBe(429);
    expect(capped.body.error.code).toBe("daily_new_wallet_limit");
    w.chain.authority = { initId: 7n };
    w.chain.linkedTo = await swishIdPda(user.pk.publicKey);
    expect((await prepare(user, await createDeposit(), addr(43))).status).toBe(200);
  });

  it("reserves the final daily slot only once across concurrent deposits", async () => {
    await w.deps.db.query("update apps set daily_new_wallets = 1");
    const user = await setUpUser();
    const deposits = await Promise.all([createDeposit(), createDeposit(), createDeposit()]);
    const results = await Promise.all(deposits.map((d, i) => prepare(user, d, addr(40 + i))));
    expect(results.map((r) => r.status).sort()).toEqual([200, 429, 429]);
    const reserved = await w.deps.db.query<{ n: number }>("select count(*)::int as n from deposits where setup_new_wallet");
    expect(reserved.rows[0]!.n).toBe(1);
    const winner = results.findIndex((r) => r.status === 200);
    expect((await prepare(user, deposits[winner]!, addr(40 + winner))).status).toBe(200);
  });

  it("dates a new-wallet reservation when sponsorship begins, not at an earlier linked-wallet setup", async () => {
    await w.deps.db.query("update apps set daily_new_wallets = 1");
    const user = await setUpUser();
    const d = await createDeposit();
    w.chain.linkedTo = await swishIdPda(user.pk.publicKey);
    expect((await prepare(user, d, addr(40))).status).toBe(200);
    await w.deps.db.query("update deposits set setup_at = now() - interval '2 days' where id = $1", [d.id]);
    w.chain.linkedTo = null;
    expect((await prepare(user, d, addr(40))).status).toBe(200);
    expect((await prepare(user, await createDeposit(), addr(41))).status).toBe(429);
  });

  it("adds to a limit: what is left plus the new amount, replacing the allowance at the next free nonce", async () => {
    const user = await setUpUser();
    const d = await createDeposit();
    const limit = () =>
      widget("/v1/setup/wallet/limit", { credential_id: user.credentialId, wallet: addr(40), add: "100", ...forDeposit(d) });
    const notYet = await limit();
    expect(notYet.status).toBe(400);

    w.chain.authority = { initId: 7n };
    w.chain.linkedTo = await swishIdPda(user.pk.publicKey);
    w.chain.walletAllowances = [{ address: addr(50), nonce: 0n, subscriptionAuthority: addr(51), amount: 37_500_000n, expiryTs: 0n }];
    const left = await widget("/v1/setup/wallet/allowance", { credential_id: user.credentialId, wallet: addr(40) });
    expect(left.body).toMatchObject({ left: "37.5", balance: "1000", token: "USDC" });
    const noDeposit = await widget("/v1/setup/wallet/limit", { credential_id: user.credentialId, wallet: addr(40), add: "100" });
    expect(noDeposit.status).toBe(400);
    const res = await limit();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ done: false, step: "limit", left_now: "37.5", new_limit: "137.5" });
    const [ixs] = w.chain.built;
    expect(ixs).toHaveLength(2);
    // revoke the old one (rent back to Swish), then create nonce 1 for 100
    expect(ixs![0]!.accounts!.map((a) => a.address)).toContain(addr(50));
    expect(ixs![0]!.accounts!.map((a) => a.address)).toContain(w.chain.sponsor.address);
    const create = Buffer.from(ixs![1]!.data!);
    expect(create.includes(Buffer.from(new BigUint64Array([137_500_000n]).buffer))).toBe(true);
    expect(create.includes(Buffer.from(new BigUint64Array([1n]).buffer))).toBe(true);

    // The limit it was created with comes from the chain, once; after that only what is new is read.
    const standing = () => widget("/v1/setup/wallet/allowance", { credential_id: user.credentialId, wallet: addr(40) });
    w.chain.limitHistory = { newest: "sigA", amount: 100_000_000n };
    expect((await standing()).body).toMatchObject({ left: "37.5", limit: "100" });
    w.chain.limitHistory = { newest: null, amount: null };
    expect((await standing()).body).toMatchObject({ left: "37.5", limit: "100" });
    // (the read above this block found no creation, so nothing was kept and the next one starts over)
    expect(w.chain.limitReads).toEqual([[addr(50), undefined], [addr(50), undefined], [addr(50), "sigA"]]);
    // A later deposit moves the mark, not the limit.
    w.chain.limitHistory = { newest: "sigB", amount: null };
    expect((await standing()).body.limit).toBe("100");
    expect((await standing()).body.limit).toBe("100");
    expect(w.chain.limitReads.at(-1)).toEqual([addr(50), "sigB"]);
    // The same address made again with another limit: the newer creation wins.
    w.chain.limitHistory = { newest: "sigC", amount: 60_000_000n };
    expect((await standing()).body.limit).toBe("60");
    // A slow or failing read leaves the limit out; what is left is still answered.
    w.chain.limitFails = true;
    const without = await standing();
    expect(without.body).toMatchObject({ left: "37.5", balance: "1000" });
    expect(without.body.limit).toBeUndefined();
    w.chain.limitFails = false;
    // Nothing left to pull from: no limit to speak of.
    w.chain.walletAllowances = [];
    expect((await standing()).body.limit).toBeUndefined();
  });

  it("unlinks a wallet with one signature: cancels its limit and the link, rent back, no deposit needed", async () => {
    const unlink = () => widget("/v1/setup/wallet/unlink", { wallet: addr(40) });
    const notLinked = await unlink();
    expect(notLinked.status).toBe(400);
    expect(notLinked.body.error.code).toBe("not_linked");

    w.chain.linkedTo = addr(41);
    w.chain.walletAllowances = [{ address: addr(50), nonce: 0n, subscriptionAuthority: addr(51), amount: 37_500_000n, expiryTs: 0n }];
    const res = await unlink();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ done: false, step: "unlink" });
    const [ixs] = w.chain.built;
    expect(ixs).toHaveLength(2);
    // the allowance is revoked first, its rent to Swish
    expect(ixs![0]!.accounts!.map((a) => a.address)).toEqual(expect.arrayContaining([addr(50), w.chain.sponsor.address]));
    // then our program unlinks: wallet signs, the Swish ID and the rent payer are named
    expect(ixs![1]!.programAddress).toBe(PROGRAM_ID);
    expect(ixs![1]!.accounts!.map((a) => a.address)).toEqual(
      expect.arrayContaining([addr(40), addr(41), w.chain.sponsor.address]),
    );

    // It is sent like a setup step, without counting against any deposit.
    const sent = await widget("/v1/setup/wallet/submit", { transaction: "AQID", token: res.body.token });
    expect(sent.status).toBe(200);
    expect(w.chain.walletSigned).toBe(1);
    const forged = await widget("/v1/setup/wallet/submit", { transaction: "AQID", token: "unlink.forged" });
    expect(forged.status).toBe(400);
    expect(w.chain.walletSigned).toBe(1);
  });

  it("only signs back a transaction it prepared", async () => {
    const res = await widget("/v1/setup/wallet/submit", { transaction: "AAAA", token: "x" });
    expect(res.status).toBe(400);
    const d = await createDeposit();
    const forged = await widget("/v1/setup/wallet/submit", { transaction: "AAAA", token: `${d.id}.forged` });
    expect(forged.status).toBe(400);
    expect(w.chain.walletSigned).toBe(0);
  });

  it("pays for a few setup transactions per deposit, only while it is open", async () => {
    const user = await setUpUser();
    const d = await createDeposit();
    const { token } = (await prepare(user, d)).body;
    const submit = () => widget("/v1/setup/wallet/submit", { transaction: "AAAA", token });
    for (let i = 0; i < 5; i++) expect((await submit()).status).toBe(200);
    const sixth = await submit();
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe("setup_limit");
    expect(w.chain.walletSigned).toBe(5);

    const d2 = await createDeposit();
    const t2 = (await prepare(user, d2)).body.token;
    await w.deps.db.query("update deposits set status = 'succeeded' where id = $1", [d2.id]);
    expect((await widget("/v1/setup/wallet/submit", { transaction: "AAAA", token: t2 })).status).toBe(429);
    expect(w.chain.walletSigned).toBe(5);
  });

  it("reports an expired wallet transaction and lets setup retry with a fresh one", async () => {
    const user = await setUpUser();
    const d = await createDeposit();
    const first = await prepare(user, d);
    const submit = (token: string) => widget("/v1/setup/wallet/submit", { transaction: "AAAA", token });
    w.chain.walletSignedError = Object.assign(new Error("Transaction simulation failed"), {
      cause: new SolanaError(SOLANA_ERROR__TRANSACTION_ERROR__BLOCKHASH_NOT_FOUND),
    });

    const expired = await submit(first.body.token);
    expect(expired.status).toBe(409);
    expect(expired.body.error).toMatchObject({ code: "transaction_expired" });
    expect(expired.body.error.message).toMatch(/wallet approval took too long/i);
    const counted = await w.deps.db.query<{ setup_txs: number }>("select setup_txs from deposits where id = $1", [d.id]);
    expect(counted.rows[0]?.setup_txs).toBe(0);

    w.chain.walletSignedError = null;
    const fresh = await prepare(user, d);
    expect(fresh.status).toBe(200);
    expect((await submit(fresh.body.token)).status).toBe(200);
  });

  it("limits setup calls per IP", async () => {
    let last;
    for (let i = 0; i < 21; i++) last = await widget("/v1/setup/wallet/allowance", { credential_id: "c", wallet: addr(40) });
    expect(last!.status).toBe(429);
    expect(last!.body.error.code).toBe("rate_limited");
    expect(last!.headers["retry-after"]).toBeDefined();
    // deposits themselves are not held back by it
    expect((await server().get(`/v1/deposits/${(await createDeposit()).id}`)).status).toBe(200);
  });
});

describe("durable settlement notifications", () => {
  it("recognizes the same exact payment made with an earlier approval deadline", async () => {
    const d = await createDeposit();
    await widget(`/v1/deposits/${d.id}/challenge`, { client_secret: d.client_secret });
    await addReceipt(d.id);
    await w.deps.db.query(
      "update deposits set status = 'submitted', expires_at = expires_at + interval '30 seconds' where id = $1", [d.id],
    );
    expect((await server().get(`/v1/deposits/${d.id}`)).body.status).toBe("succeeded");
  });

  it("uses finalized chain expiry to resolve a restart before signing or broadcasting", async () => {
    const d = await createDeposit();
    await w.deps.db.query(
      "update deposits set status = 'submitted', expires_at = now() - interval '5 minutes' where id = $1", [d.id],
    );
    expect((await server().get(`/v1/deposits/${d.id}`)).body.status).toBe("submitted");
    expect(w.webhooks).toHaveLength(0);
    w.chain.finalizedExpired = true;
    expect((await server().get(`/v1/deposits/${d.id}`)).body.status).toBe("failed");
    expect(w.chain.sent).toHaveLength(0);
  });

  it("delivers a success discovered by GET, exactly once after acknowledgement", async () => {
    const d = await createDeposit();
    await w.deps.db.query("update deposits set status = 'submitted' where id = $1", [d.id]);
    await addReceipt(d.id);
    expect((await server().get(`/v1/deposits/${d.id}`)).body.status).toBe("succeeded");
    await vi.waitFor(() => expect(w.webhooks).toHaveLength(1));
    await server().get(`/v1/deposits/${d.id}`);
    await deliverPendingWebhooks(w.deps);
    expect(w.webhooks).toHaveLength(1);
  });

  it("retries persisted terminal events after HTTP failure and a worker restart", async () => {
    const user = await setUpUser();
    const d = await createDeposit();
    w.deps.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
    expect((await approve(d, user)).body.status).toBe("succeeded");
    // Delivery runs after the response; wait for the failed attempt to be recorded.
    const pending = "select webhook_delivered_at, webhook_attempts, webhook_lease_until from deposits where id = $1";
    await vi.waitFor(async () =>
      expect((await w.deps.db.query(pending, [d.id])).rows[0]).toMatchObject({ webhook_delivered_at: null, webhook_attempts: 1, webhook_lease_until: null }),
    );
    await w.deps.db.query("update deposits set webhook_next_attempt_at = now() - interval '1 second' where id = $1", [d.id]);
    w.deps.fetch = (async (_url, init) => {
      w.webhooks.push({ url: "retry", body: String(init?.body), signature: "" });
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await Promise.all([deliverPendingWebhooks(w.deps), deliverPendingWebhooks(w.deps)]);
    expect(w.webhooks).toHaveLength(1);
    expect(JSON.parse(w.webhooks[0]!.body)).toMatchObject({ type: "deposit.succeeded", data: { id: d.id } });
  });

  it("recovers a lease abandoned by a crashed worker", async () => {
    const d = await createDeposit();
    await w.deps.db.query(
      "update deposits set status = 'succeeded', webhook_lease_until = now() - interval '1 second' where id = $1", [d.id],
    );
    await deliverPendingWebhooks(w.deps);
    expect(w.webhooks).toHaveLength(1);
  });

  it("backs off between failed webhooks and gives up after the last attempt", async () => {
    const d = await createDeposit();
    await w.deps.db.query("update deposits set status = 'succeeded', webhook_attempts = 3 where id = $1", [d.id]);
    w.deps.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
    await deliverPendingWebhooks(w.deps);
    const { rows } = await w.deps.db.query<{ delay: number }>(
      "select extract(epoch from webhook_next_attempt_at - now())::float as delay from deposits where id = $1", [d.id],
    );
    expect(rows[0]!.delay).toBeGreaterThan(230); // 30 s · 2³ after the 4th attempt
    expect(rows[0]!.delay).toBeLessThanOrEqual(240);

    await w.deps.db.query(
      "update deposits set webhook_attempts = 30, webhook_next_attempt_at = now() - interval '1 second' where id = $1", [d.id],
    );
    await deliverPendingWebhooks(w.deps);
    expect((await w.deps.db.query("select webhook_attempts from deposits where id = $1", [d.id])).rows[0]).toMatchObject({ webhook_attempts: 30 });
  });
});
