/**
 * Makes sure the sponsor has its lookup table for deposits (one per mint),
 * creating it once and remembering its address in the database.
 */
import { address, type Address } from "@solana/kit";

import type { SolanaChain } from "./chain/client.js";
import { depositAddresses } from "./chain/lookupTable.js";
import type { Db } from "./db.js";

/** A new table's addresses can be used from the slot after it was extended. */
const WARM_UP_TRIES = 10;

export async function ensureLookupTable(db: Db, chain: SolanaChain, mint: Address): Promise<Address> {
  const key = `lookup_table:${mint}`;
  const wanted = await depositAddresses(mint);
  const { rows } = await db.query<{ value: string }>("select value from settings where key = $1", [key]);
  if (rows[0] && (await chain.useLookupTable(address(rows[0].value), wanted))) return address(rows[0].value);

  const table = await chain.createLookupTable(wanted);
  await db.query(
    `insert into settings (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, table],
  );
  for (let i = 0; i < WARM_UP_TRIES; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await chain.useLookupTable(table, wanted)) {
      // One more slot, so the addresses are past their warm-up.
      await new Promise((r) => setTimeout(r, 1000));
      console.log(`[lookup table] created ${table}`);
      return table;
    }
  }
  throw new Error(`lookup table ${table} was created but cannot be read yet`);
}
