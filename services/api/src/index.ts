import "dotenv/config";

import { address } from "@solana/kit";

import { createApp } from "./app.js";
import { SolanaChain } from "./chain/client.js";
import { loadEnv } from "./config/env.js";
import { connect } from "./db.js";
import { sponsorFromSecret } from "./sponsor.js";

const env = loadEnv();
const sponsor = await sponsorFromSecret(env.SPONSOR_SECRET_KEY);
const app = createApp({
  db: connect(env.DATABASE_URL),
  chain: new SolanaChain(env.RPC_URL, sponsor),
  rpId: env.RP_ID,
  usdcMint: address(env.USDC_MINT),
  serverSecret: Buffer.from(env.SERVER_SECRET, "hex"),
  fetch,
});

// "::" so Railway's IPv6 private network reaches it too.
app.listen(env.PORT, "::", () => {
  console.log(`swish-deposit api on :${env.PORT} (${env.CLUSTER}, sponsor ${sponsor.address})`);
});
