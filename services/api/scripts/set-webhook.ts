/**
 * Sets where an app is told about its deposits (by hand, until
 * business.swish.cash has settings):
 *
 *   npm run set-webhook -- --key swishpub_… --url https://acme.xyz/hooks/swish
 */
import "dotenv/config";

import { parseArgs } from "node:util";

import { loadEnv } from "../src/config/env.js";
import { connect } from "../src/db.js";

const { values } = parseArgs({ options: { key: { type: "string" }, url: { type: "string" } } });
const { key, url } = values;
if (!key || !url) throw new Error("usage: --key <publishable key> --url <https://…>");
if (new URL(url).protocol !== "https:") throw new Error("the webhook address must be https");

const db = connect(loadEnv().DATABASE_URL);
const { rows } = await db.query<{ name: string; webhook_url: string }>(
  `update apps set webhook_url = $2 where publishable_key = $1 returning name, webhook_url`,
  [key, url],
);
if (!rows[0]) throw new Error("no app has that publishable key");
console.log(`${rows[0].name}: webhooks go to ${rows[0].webhook_url}`);
await db.end();
