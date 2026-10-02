/**
 * Every deposit leaves a receipt on chain (~0.0012 SOL of rent Swish paid).
 * Once its deadline has passed, anyone may close it and the rent goes back
 * to whoever paid. This closes the receipts of finished deposits, a batch per
 * transaction. Only `succeeded` ones: a `submitted` deposit's receipt is how
 * we learn it landed.
 */
import { address } from "@solana/kit";

import { closeReceiptInstruction, uuidBytes } from "./chain/program.js";
import type { Deps } from "./context.js";

/** Receipts per transaction, and per run. */
const PER_TRANSACTION = 8;
const PER_RUN = 64;

export async function closeReceipts(deps: Pick<Deps, "db" | "chain">): Promise<{ closed: number; signatures: string[] }> {
  const { db, chain } = deps;
  const { rows } = await db.query<{ id: string }>(
    `select id from deposits
     where status = 'succeeded' and receipt_closed_at is null and expires_at < now()
     order by expires_at
     limit $1`,
    [PER_RUN],
  );
  const markClosed = (ids: string[]) =>
    ids.length
      ? db.query("update deposits set receipt_closed_at = now(), updated_at = now() where id = any($1::uuid[])", [ids])
      : Promise.resolve();

  const open: { id: string; rentPayer: string }[] = [];
  const gone: string[] = [];
  for (const { id } of rows) {
    const receipt = await chain.receipt(uuidBytes(id));
    if (receipt) open.push({ id, rentPayer: receipt.rentPayer });
    else gone.push(id); // someone else closed it already
  }
  await markClosed(gone);

  const signatures: string[] = [];
  let closed = 0;
  for (let i = 0; i < open.length; i += PER_TRANSACTION) {
    const batch = open.slice(i, i + PER_TRANSACTION);
    try {
      const instructions = await Promise.all(batch.map((r) => closeReceiptInstruction(uuidBytes(r.id), address(r.rentPayer))));
      signatures.push(await chain.send(instructions));
      await markClosed(batch.map((r) => r.id));
      closed += batch.length;
    } catch (e) {
      // Left open; the next run checks each one again.
      console.error("[receipts] close failed", (e as Error).message);
    }
  }
  return { closed, signatures };
}

/** Runs `closeReceipts` now and every `everyMs`, one run at a time. */
export function scheduleReceiptCleanup(deps: Pick<Deps, "db" | "chain">, everyMs = 10 * 60_000): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const { closed, signatures } = await closeReceipts(deps);
      if (closed) console.log(`[receipts] closed ${closed}, rent back to Swish:`, signatures.join(" "));
    } catch (e) {
      console.error("[receipts]", (e as Error).message);
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
