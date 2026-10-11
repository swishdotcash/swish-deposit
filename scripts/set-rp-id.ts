/**
 * Changes the passkey site the program accepts (`set_rp_id_hash`), e.g. from
 * "localhost" to "swish.cash". Passkeys made for the old site stop approving
 * deposits at once. Must be signed by the program's admin.
 *
 *   npm run program:set-rp-id -- --url devnet --rp-id swish.cash                    (shows what is set now, changes nothing)
 *   npm run program:set-rp-id -- --url devnet --rp-id swish.cash --keypair <path>   (changes it)
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

import {
  AccountRole,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getAddressDecoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { programId } from "./program-config.js";

const PROGRAM_ID = programId();

const CLUSTERS: Record<string, { http: string; ws: string }> = {
  devnet: { http: "https://api.devnet.solana.com", ws: "wss://api.devnet.solana.com" },
  mainnet: { http: "https://api.mainnet-beta.solana.com", ws: "wss://api.mainnet-beta.solana.com" },
};

const sha256 = (data: Uint8Array | string) => new Uint8Array(createHash("sha256").update(data).digest());
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const { values } = parseArgs({
  options: { url: { type: "string" }, keypair: { type: "string" }, "rp-id": { type: "string" } },
});
const cluster = CLUSTERS[values.url ?? ""];
if (!cluster || !values["rp-id"]) {
  throw new Error("usage: --url devnet|mainnet --rp-id <site> [--keypair <admin keypair path>]");
}

const rpc = createSolanaRpc(cluster.http);
const [config] = await getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: ["config"] });
const account = (await rpc.getAccountInfo(config, { encoding: "base64" }).send()).value;
if (!account) throw new Error(`the program is not initialised on ${values.url}: ${config}`);

// Config: 8 (Anchor) ‖ admin ‖ pending_admin ‖ cluster_tag ‖ rp_id_hash ‖ …
const state = new Uint8Array(Buffer.from(account.data[0], "base64"));
const admin = getAddressDecoder().decode(state.subarray(8, 40));
const current = hex(state.subarray(104, 136));
const wanted = sha256(values["rp-id"]);
const known = ["localhost", "swish.cash"].find((site) => hex(sha256(site)) === current);

console.log({
  cluster: values.url,
  config,
  admin,
  now: known ? `${known} (${current})` : current,
  wanted: `${values["rp-id"]} (${hex(wanted)})`,
});

if (current === hex(wanted)) {
  console.log(`already set to ${values["rp-id"]}: nothing to do`);
  process.exit(0);
}
if (!values.keypair) {
  console.log("no --keypair given: nothing was changed");
  process.exit(0);
}

const signer = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(values.keypair.replace(/^~/, homedir()), "utf8"))),
);
if (signer.address !== admin) throw new Error(`${signer.address} is not the admin (${admin})`);

// Anchor: sha256("global:set_rp_id_hash")[..8] ‖ rp_id_hash
const data = new Uint8Array(8 + 32);
data.set(sha256("global:set_rp_id_hash").subarray(0, 8), 0);
data.set(wanted, 8);

const { value: blockhash } = await rpc.getLatestBlockhash().send();
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(signer, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
  (m) =>
    appendTransactionMessageInstruction(
      {
        programAddress: PROGRAM_ID,
        accounts: [
          { address: signer.address, role: AccountRole.READONLY_SIGNER, signer },
          { address: config, role: AccountRole.WRITABLE },
        ],
        data,
      },
      m,
    ),
);
const transaction = await signTransactionMessageWithSigners(message);
await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions: createSolanaRpcSubscriptions(cluster.ws) })(transaction, {
  commitment: "confirmed",
});
console.log(`passkey site is now ${values["rp-id"]}:`, getSignatureFromTransaction(transaction));
