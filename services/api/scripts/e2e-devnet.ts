/**
 * The whole flow on DEVNET, through the real API and the real program, with
 * the passkey emulated (a P-256 key signing exactly as a browser does, for
 * rpId "localhost"). Nothing here touches mainnet.
 *
 *   npx tsx scripts/e2e-devnet.ts --admin-keypair <path to the devnet admin>
 *
 * The admin (it registers the test app) also funds a throwaway sponsor with
 * 0.3 SOL. Everything else is created fresh: a test token standing in for
 * USDC, a user wallet (as Phantom would be), the user's account in the app.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

import { PGlite } from "@electric-sql/pglite";
import {
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  generateKeyPairSigner,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  getTransactionEncoder,
  lamports,
  partiallySignTransaction,
  type Address,
} from "@solana/kit";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  TOKEN_PROGRAM_ADDRESS,
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
} from "@solana-program/token";

import { createApp } from "../src/app.js";
import { SolanaChain } from "../src/chain/client.js";
import { b64url, fromB64url } from "../src/chain/webauthn.js";
import { migrate, type Db } from "../src/db.js";
import { registerApp } from "../src/registerApp.js";
import { fakePasskey } from "../test/helpers.js";

const RPC = "https://api.devnet.solana.com";
const ORIGIN = "http://localhost:3000";
const units = (n: number) => BigInt(Math.round(n * 1_000_000));

const { values } = parseArgs({ options: { "admin-keypair": { type: "string" } } });
if (!values["admin-keypair"]) throw new Error("--admin-keypair <path>");
const admin = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(values["admin-keypair"].replace(/^~/, homedir()), "utf8"))),
);
const rpc = createSolanaRpc(RPC);
const step = (s: string) => console.log(`\n▸ ${s}`);
const tx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

// ---- Throwaway keys ----
const sponsor = await generateKeyPairSigner();
const mint = await generateKeyPairSigner();
const userWallet = await generateKeyPairSigner();
const userInApp = await generateKeyPairSigner();
const chain = new SolanaChain(RPC, sponsor);

step(`fund a throwaway sponsor ${sponsor.address} with 0.3 SOL from the admin`);
console.log("  ", tx(await chain.sendAs(admin, [getTransferSolInstruction({ source: admin, destination: sponsor.address, amount: lamports(300_000_000n) })])));

step(`a test token standing in for USDC (${mint.address}), 100 to the user's wallet ${userWallet.address}`);
const [userAta] = await findAssociatedTokenPda({ owner: userWallet.address, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
const mintSpace = BigInt(getMintSize());
console.log(
  "  ",
  tx(
    await chain.send([
      getCreateAccountInstruction({
        payer: sponsor,
        newAccount: mint,
        lamports: await rpc.getMinimumBalanceForRentExemption(mintSpace).send(),
        space: mintSpace,
        programAddress: TOKEN_PROGRAM_ADDRESS,
      }),
      getInitializeMint2Instruction({ mint: mint.address, decimals: 6, mintAuthority: sponsor.address }),
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: sponsor, owner: userWallet.address, mint: mint.address }),
      getMintToInstruction({ mint: mint.address, token: userAta, mintAuthority: sponsor, amount: units(100) }),
    ]),
  ),
);

// ---- The API, in this process, with an in-memory database ----
const pg = new PGlite();
const db: Db = { query: (sql, params) => pg.query(sql, params) as never, exec: (sql) => pg.exec(sql) };
await migrate(db);
const webhooks: string[] = [];
const server = createApp({
  db,
  chain,
  rpId: "localhost",
  usdcMint: mint.address,
  serverSecret: randomBytes(32),
  fetch: (async (_url: string, init: RequestInit) => {
    webhooks.push(String(init.body));
    return new Response(null, { status: 200 });
  }) as typeof fetch,
}).listen(0);
const base = `http://localhost:${(server.address() as AddressInfo).port}`;

step("register a test app (the admin signs on chain)");
const app = await registerApp(db, chain, admin, {
  name: "E2E test app",
  website: "https://example.com",
  contactEmail: "e2e@example.com",
  allowedOrigins: [ORIGIN],
  webhookUrl: "https://example.com/hook",
});
console.log(`   app ${app.id} → on chain ${app.onChain}\n  `, tx(app.signature));

async function call(path: string, body: object, as: "server" | "widget") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (as === "server") headers.authorization = `Bearer ${app.secretKey}`;
  else Object.assign(headers, { "x-swish-key": app.publishableKey, origin: ORIGIN });
  const res = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path} → ${res.status} ${JSON.stringify(json)}`);
  return json;
}

// ---- Setup: passkey + wallet ----
const passkey = fakePasskey();
const credentialId = b64url(randomBytes(16));
step("setup 1/2: register the passkey (the user's Swish ID)");
console.log("   swish id", (await call("/v1/setup/passkey", { credential_id: credentialId, public_key: b64url(passkey.spki) }, "widget")).swish_id);

step("setup 2/2: link the wallet with a 50 USDC allowance (the wallet signs; Swish pays)");
for (;;) {
  const next = await call("/v1/setup/wallet/prepare", { credential_id: credentialId, wallet: userWallet.address, allowance: "50" }, "widget");
  if (next.done) break;
  const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(String(next.transaction)));
  const signed = await partiallySignTransaction([userWallet.keyPair], unsigned);
  const wire = getBase64Decoder().decode(getTransactionEncoder().encode(signed));
  const { signature } = await call("/v1/setup/wallet/submit", { transaction: wire, token: next.token }, "widget");
  console.log(`   ${next.step}:`, tx(String(signature)));
}

// ---- A deposit: one Face ID ----
async function balance(owner: Address) {
  const [ata] = await findAssociatedTokenPda({ owner, mint: mint.address, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  try {
    return (await fetchToken(rpc, ata)).data.amount;
  } catch {
    return 0n;
  }
}

step("the app's server creates a 12.5 deposit into the user's own account in the app");
const deposit = await call("/v1/deposits", { amount: "12.5", token: "USDC", destination: userInApp.address, reference: "e2e-1" }, "server");
console.log(`   deposit ${deposit.id}`);

step("the widget gets the challenge; Face ID (emulated) signs it; we submit");
const challenge = await call(`/v1/deposits/${deposit.id}/challenge`, { client_secret: deposit.client_secret }, "widget");
const assertion = passkey.assert(fromB64url(String(challenge.challenge)));
const result = await call(
  `/v1/deposits/${deposit.id}/submit`,
  {
    client_secret: deposit.client_secret,
    credential_id: credentialId,
    authenticator_data: b64url(assertion.authenticatorData),
    client_data_json: b64url(assertion.clientDataJson),
    signature: b64url(assertion.signature),
  },
  "widget",
);
console.log(`   ${result.status}:`, tx(String(result.signature)));

step("check the chain");
const [walletLeft, landed] = await Promise.all([balance(userWallet.address), balance(userInApp.address)]);
console.log(`   user's wallet: ${Number(walletLeft) / 1e6} (was 100) · user's account in the app: ${Number(landed) / 1e6}`);
console.log(`   webhook: ${webhooks[0]}`);

step("the same deposit cannot run twice");
try {
  await call(`/v1/deposits/${deposit.id}/challenge`, { client_secret: deposit.client_secret }, "widget");
  console.log("   ✗ UNEXPECTED: a second challenge was issued");
  process.exitCode = 1;
} catch (e) {
  console.log(`   ✓ refused: ${(e as Error).message}`);
}

const ok = result.status === "succeeded" && walletLeft === units(87.5) && landed === units(12.5);
console.log(ok ? "\n✅ end to end on devnet: one Face ID moved 12.5 into the user's own account" : "\n❌ something is off (see above)");
if (!ok) process.exitCode = 1;
server.close();
