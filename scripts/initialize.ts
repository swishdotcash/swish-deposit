/**
 * One-time `initialize` of a freshly deployed swish-deposit program.
 *
 * Must be signed by the program's CURRENT upgrade authority (the program
 * refuses anyone else). Sets:
 *   admin        who can pause, register apps and change the passkey site
 *   cluster_tag  sha256(the cluster's genesis hash), so a signature made on
 *                one cluster is useless on another
 *   rp_id_hash   sha256(the passkey site, e.g. "localhost" or "swish.cash")
 *
 *   npm run program:initialize -- --url devnet --keypair <path> --admin <address> --rp-id localhost
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Encoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";

const PROGRAM_ID = address("D2JKE48xP76LQkr1fn41LM8nxG74uKohAXy5SEoPaL3p");
const LOADER_UPGRADEABLE = address("BPFLoaderUpgradeab1e11111111111111111111111");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

const CLUSTERS: Record<string, { http: string; ws: string }> = {
  devnet: { http: "https://api.devnet.solana.com", ws: "wss://api.devnet.solana.com" },
  mainnet: { http: "https://api.mainnet-beta.solana.com", ws: "wss://api.mainnet-beta.solana.com" },
};

const sha256 = (data: Uint8Array | string) => new Uint8Array(createHash("sha256").update(data).digest());
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    keypair: { type: "string" },
    admin: { type: "string" },
    "rp-id": { type: "string" },
  },
});
const cluster = CLUSTERS[values.url ?? ""];
if (!cluster || !values.keypair || !values.admin || !values["rp-id"]) {
  throw new Error("usage: --url devnet|mainnet --keypair <path> --admin <address> --rp-id <site>");
}

const rpc = createSolanaRpc(cluster.http);
const rpcSubscriptions = createSolanaRpcSubscriptions(cluster.ws);

const keypairPath = values.keypair.replace(/^~/, homedir());
const authority = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(keypairPath, "utf8"))),
);
const admin = address(values.admin);

const genesisHash = await rpc.getGenesisHash().send();
const clusterTag = sha256(getBase58Encoder().encode(genesisHash));
const rpIdHash = sha256(values["rp-id"]);

const [config] = await getProgramDerivedAddress({ programAddress: PROGRAM_ID, seeds: ["config"] });
const [programData] = await getProgramDerivedAddress({
  programAddress: LOADER_UPGRADEABLE,
  seeds: [getAddressEncoder().encode(PROGRAM_ID)],
});

console.log({
  cluster: values.url,
  authority: authority.address,
  admin,
  genesisHash,
  clusterTag: hex(clusterTag),
  rpId: values["rp-id"],
  rpIdHash: hex(rpIdHash),
  config,
  programData,
});

if ((await rpc.getAccountInfo(config, { encoding: "base64" }).send()).value) {
  throw new Error(`already initialised: ${config}`);
}

// Anchor: sha256("global:initialize")[..8] ‖ admin ‖ cluster_tag ‖ rp_id_hash
const data = new Uint8Array(8 + 32 * 3);
data.set(sha256("global:initialize").subarray(0, 8), 0);
data.set(getAddressEncoder().encode(admin), 8);
data.set(clusterTag, 40);
data.set(rpIdHash, 72);

const instruction = {
  programAddress: PROGRAM_ID,
  accounts: [
    { address: authority.address, role: AccountRole.WRITABLE_SIGNER, signer: authority },
    { address: config, role: AccountRole.WRITABLE },
    { address: PROGRAM_ID, role: AccountRole.READONLY },
    { address: programData, role: AccountRole.READONLY },
    { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
  ],
  data,
};

const { value: blockhash } = await rpc.getLatestBlockhash().send();
const message = pipe(
  createTransactionMessage({ version: 0 }),
  (m) => setTransactionMessageFeePayerSigner(authority, m),
  (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
  (m) => appendTransactionMessageInstruction(instruction, m),
);
const transaction = await signTransactionMessageWithSigners(message);
await sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions })(transaction, { commitment: "confirmed" });
console.log("initialised:", getSignatureFromTransaction(transaction));
