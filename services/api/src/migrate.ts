import "dotenv/config";

import { connect, migrate } from "./db.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const pool = connect(url);
const applied = await migrate(pool);
console.log(applied.length ? `applied: ${applied.join(", ")}` : "nothing to apply");
await pool.end();
