import { address } from "@solana/kit";

import { PROGRAM_ID, paymentCommitment, uuidBytes } from "./chain/program.js";
import { InvalidReceiptError } from "./chain/receipt.js";
import type { Deps } from "./context.js";
import type { DepositRow } from "./routes/deposits.js";
import { deliverPendingWebhooks } from "./webhooks.js";

export async function expectedPayment(deps: Pick<Deps, "chain">, d: DepositRow): Promise<Uint8Array> {
  return paymentCommitment({
    clusterTag: await deps.chain.clusterTag(), programId: PROGRAM_ID,
    depositId: uuidBytes(d.id), appId: uuidBytes(d.app_id), mint: address(d.mint),
    destination: address(d.destination), amount: BigInt(d.amount),
  });
}

/** Only validated chain evidence can turn a submitted payment into a result. */
export async function reconcileDeposit(deps: Deps, d: DepositRow): Promise<DepositRow> {
  if (d.status !== "submitted") return d;
  let status: "succeeded" | "failed" | undefined;
  let error: string | null = null;
  let wallet = d.wallet;
  let swishId = d.swish_id;
  try {
    const receipt = await deps.chain.receipt(uuidBytes(d.id));
    if (receipt) {
      if (Buffer.from(receipt.commitment).equals(Buffer.from(await expectedPayment(deps, d)))) {
        status = "succeeded";
        wallet = receipt.wallet;
        swishId = receipt.swishId;
      } else {
        status = "failed";
        error = "on-chain receipt does not match the requested payment";
      }
    } else if (d.signature) {
      const outcome = await deps.chain.transactionStatus(d.signature, d.last_valid_block_height === null ? null : BigInt(d.last_valid_block_height));
      if (outcome === "failed" || outcome === "expired") {
        // Re-read after checking status/expiry, covering a late landing between
        // the first account read and the transaction-status read.
        if (await deps.chain.receipt(uuidBytes(d.id))) return reconcileDeposit(deps, d);
        status = "failed";
        error = outcome === "failed" ? "transaction failed on chain" : "transaction expired without settlement";
      }
      // Confirmed success without a visible receipt is still uncertain.
    } else if (d.expires_at && await deps.chain.approvalExpired(BigInt(Math.floor(new Date(d.expires_at).getTime() / 1000)))) {
      if (await deps.chain.receipt(uuidBytes(d.id))) return reconcileDeposit(deps, d);
      status = "failed";
      error = "approval expired before settlement";
    }
  } catch (e) {
    console.warn(`[settlement] ${d.id}: ${e instanceof InvalidReceiptError ? e.message : "chain evidence unavailable"}`);
    // A spoofed or legacy account is not payment evidence. Leave it pending
    // for investigation; a prefunded system account may still be initialized
    // by an in-flight valid pull. Neither it nor an RPC outage proves failure.
    return d;
  }
  if (!status) return d;
  const { rows } = await deps.db.query<DepositRow>(
    `update deposits set status = $2, error = $3, wallet = $4, swish_id = $5, updated_at = now()
     where id = $1 and status = 'submitted' returning *`,
    [d.id, status, error, wallet, swishId],
  );
  // The terminal row itself is the durable webhook job, committed atomically
  // with its outcome. A restart cannot lose the notification.
  return rows[0] ?? (await deps.db.query<DepositRow>("select * from deposits where id = $1", [d.id])).rows[0]!;
}

export async function reconcilePendingDeposits(deps: Deps): Promise<void> {
  const { rows } = await deps.db.query<DepositRow>(
    "select * from deposits where status = 'submitted' order by updated_at limit 100",
  );
  for (const d of rows) {
    await reconcileDeposit(deps, d);
    // Rotate unresolved jobs so one outage cannot starve newer deposits.
    await deps.db.query("update deposits set updated_at = now() where id = $1 and status = 'submitted'", [d.id]);
  }
}

/** A restart resumes both settlement and undelivered terminal notifications. */
export function scheduleSettlement(deps: Deps, everyMs = 5_000): () => void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await reconcilePendingDeposits(deps);
      await deliverPendingWebhooks(deps);
    } catch (e) {
      console.error("[settlement]", e);
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(run, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
