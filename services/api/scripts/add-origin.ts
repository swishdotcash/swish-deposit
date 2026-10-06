/**
 * Lets an app's widget open on one more page address (by hand, until
 * business.swish.cash has settings):
 *
 *   npm run add-origin -- --key swishpub_… --origin https://app.acme.xyz
 */
import "dotenv/config";

import { parseArgs } from "node:util";

import { loadEnv } from "../src/config/env.js";
import { connect } from "../src/db.js";

const { values } = parseArgs({ options: { key: { type: "string" }, origin: { type: "string" } } });
const { key, origin } = values;
if (!key || !origin) throw new Error("usage: --key <publishable key> --origin <https://…>");
if (new URL(origin).origin !== origin) throw new Error(`${origin} is not an origin (scheme and host only, no path or trailing slash)`);

const db = connect(loadEnv().DATABASE_URL);
await db.query(
  `update apps set allowed_origins = array_append(allowed_origins, $2)
   where publishable_key = $1 and not ($2 = any(allowed_origins))`,
  [key, origin],
);
const { rows } = await db.query<{ name: string; allowed_origins: string[] }>(`select name, allowed_origins from apps where publishable_key = $1`, [key]);
if (!rows[0]) throw new Error("no app has that publishable key");
console.log(`${rows[0].name}: ${rows[0].allowed_origins.join(", ")}`);
await db.end();
