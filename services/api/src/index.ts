import "dotenv/config";

import { address } from "@solana/kit";

import { createApp } from "./app.js";
import { SolanaChain } from "./chain/client.js";
import { loadEnv } from "./config/env.js";
import { connect } from "./db.js";
import { ensureLookupTable } from "./lookup.js";
import { scheduleReceiptCleanup } from "./receipts.js";
import { sponsorFromSecret } from "./sponsor.js";

const env = loadEnv();
const sponsor = await sponsorFromSecret(env.SPONSOR_SECRET_KEY);
const db = connect(env.DATABASE_URL);
const chain = new SolanaChain(env.RPC_URL, sponsor);
const app = createApp({
  db,
  chain,
  rpId: env.RP_ID,
  usdcMint: address(env.USDC_MINT),
  serverSecret: Buffer.from(env.SERVER_SECRET, "hex"),
  frameOrigins: env.FRAME_ORIGINS,
  fetch,
});

// Without the table a deposit can outgrow a transaction; never fatal at boot.
await ensureLookupTable(db, chain, address(env.USDC_MINT)).catch((e) => console.error("[lookup table]", e));

scheduleReceiptCleanup({ db, chain });

// "::" so Railway's IPv6 private network reaches it too.
app.listen(env.PORT, "::", () => {
  console.log(`swish-deposit api on :${env.PORT} (${env.CLUSTER}, sponsor ${sponsor.address})`);
});
