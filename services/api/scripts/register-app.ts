/**
 * Registers an app (by hand, until business.swish.cash has sign-up):
 *
 *   npm run register-app -- --admin-keypair <path> --name "Acme" --website https://acme.xyz \
 *     --email ops@acme.xyz --origins https://app.acme.xyz[,https://…] [--webhook https://acme.xyz/hooks/swish]
 *
 * Prints the keys ONCE. The secret key is never stored; give it to the app.
 */
import "dotenv/config";

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

import { createKeyPairSignerFromBytes } from "@solana/kit";

import { SolanaChain } from "../src/chain/client.js";
import { loadEnv } from "../src/config/env.js";
import { connect } from "../src/db.js";
import { registerApp } from "../src/registerApp.js";
import { sponsorFromSecret } from "../src/sponsor.js";

const { values } = parseArgs({
  options: {
    "admin-keypair": { type: "string" },
    name: { type: "string" },
    website: { type: "string" },
    email: { type: "string" },
    origins: { type: "string" },
    webhook: { type: "string" },
  },
});
const { "admin-keypair": adminPath, name, website, email, origins } = values;
if (!adminPath || !name || !website || !email || !origins) {
  throw new Error("usage: --admin-keypair <path> --name <name> --website <url> --email <email> --origins <a,b> [--webhook <url>]");
}

const env = loadEnv();
const admin = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(adminPath.replace(/^~/, homedir()), "utf8"))),
);
const db = connect(env.DATABASE_URL);
const chain = new SolanaChain(env.RPC_URL, await sponsorFromSecret(env.SPONSOR_SECRET_KEY));
const app = await registerApp(db, chain, admin, {
  name,
  website,
  contactEmail: email,
  allowedOrigins: origins.split(",").map((o) => o.trim()),
  webhookUrl: values.webhook,
});
console.log(`app ${app.id} (on chain ${app.onChain}, tx ${app.signature})`);
console.log(`publishable key: ${app.publishableKey}`);
console.log(`secret key (shown once): ${app.secretKey}`);
await db.end();
