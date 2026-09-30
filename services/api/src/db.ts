import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";

/** What the API needs from Postgres. `pg.Pool` and PGlite (tests) both fit. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec?(sql: string): Promise<unknown>;
}

export function connect(url: string): pg.Pool {
  // numeric(20,0) comes back as a string by default; keep it that way (u64).
  return new pg.Pool({ connectionString: url, max: 5 });
}

const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url));

/** Applies every migration not applied yet, in file-name order. */
export async function migrate(db: Db): Promise<string[]> {
  await db.query(
    "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
  );
  const done = new Set(
    (await db.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name),
  );
  const applied: string[] = [];
  for (const name of (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    const sql = await readFile(MIGRATIONS + name, "utf8");
    // Multi-statement SQL: PGlite has exec(); pg runs it as one simple query.
    if (db.exec) await db.exec(sql);
    else await db.query(sql);
    await db.query("insert into schema_migrations (name) values ($1)", [name]);
    applied.push(name);
  }
  return applied;
}
