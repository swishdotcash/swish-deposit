import { randomUUID } from "node:crypto";

import { PGlite } from "@electric-sql/pglite";
import { generateKeyPairSigner, getAddressDecoder, type Address, type Instruction, type KeyPairSigner } from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { Allowance, Chain, Source } from "../src/chain/client.js";
import { ChainError } from "../src/chain/client.js";
import { PROGRAM_ID, SECP256R1_PROGRAM, TOKEN_PROGRAM, swishIdPda } from "../src/chain/program.js";
import { b64url, fromB64url } from "../src/chain/webauthn.js";
import type { Deps } from "../src/context.js";
import { migrate, type Db } from "../src/db.js";
import { hashKey, newPublishableKey, newSecretKey } from "../src/keys.js";
import { signWebhook } from "../src/webhooks.js";
import { fakePasskey } from "./helpers.js";

const ORIGIN = "https://app.example.com";
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
  constructor(readonly sponsor: KeyPairSigner) {}
  async clusterTag() {
    return new Uint8Array(32).fill(1);
  }
  async destinationFor(owner: Address, mint: Address) {
    return (await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM }))[0];
  }
  async findSource() {
    return this.source;
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
  async tokenBalance() {
    return this.balance;
  }
  async exists(a: Address) {
    return this.existing.has(a);
  }
  async send(instructions: Instruction[]) {
    this.sent.push(instructions);
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
  async sendWalletSigned() {
    this.walletSigned++;
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
  const db: Db = { query: (sql, params) => pg.query(sql, params) as never, exec: (sql) => pg.exec(sql) };
  await migrate(db);
  const publishable = newPublishableKey();
  const secret = newSecretKey();
  await db.query(
    `insert into apps (id, name, website, contact_email, allowed_origins, publishable_key, secret_key_hash, webhook_url)
     values ($1, 'Demo', 'https://example.com', 'ops@example.com', $2, $3, $4, 'https://example.com/hook')`,
    [randomUUID(), [ORIGIN], publishable, hashKey(secret)],
  );
  const chain = new FakeChain(await generateKeyPairSigner());
  const webhooks: World["webhooks"] = [];
  const deps: Deps = {
    db,
    chain,
    rpId: "localhost",
    usdcMint: USDC,
    serverSecret: Buffer.alloc(32, 7),
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

    expect(w.webhooks).toHaveLength(1);
    const hook = w.webhooks[0]!;
    expect(JSON.parse(hook.body)).toMatchObject({ type: "deposit.succeeded", data: { id: d.id, reference: "order-7" } });
    const t = Number(/t=(\d+)/.exec(hook.signature)![1]);
    expect(hook.signature).toBe(signWebhook(w.keys.secretHash, t, hook.body));
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
    const res = await approve(await createDeposit(), user);
    expect(res.body).toMatchObject({ status: "failed", signature: "sig-x" });
    expect(JSON.parse(w.webhooks[0]!.body).type).toBe("deposit.failed");
  });

  it("counts a timed-out send as done when the receipt is on chain", async () => {
    const user = await setUpUser();
    const d = await createDeposit();
    w.chain.fail = new ChainError("transaction not confirmed in time", "sig-y");
    const { receiptPda, uuidBytes } = await import("../src/chain/program.js");
    w.chain.existing.add(await receiptPda(uuidBytes(d.id)));
    expect((await approve(d, user)).body.status).toBe("succeeded");
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
    expect(left.body).toMatchObject({ left: "37.5", token: "USDC" });
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
