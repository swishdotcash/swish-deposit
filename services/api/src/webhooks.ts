import { createHmac } from "node:crypto";

import type { AppRow, Deps } from "./context.js";
import { depositView, type DepositRow } from "./routes/deposits.js";

const TIMEOUT_MS = 10_000;

/**
 * `Swish-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`.
 * The key is sha256(your secret key) as hex — your server computes it from
 * the secret it already holds; we never store the secret itself.
 */
export function signWebhook(secretKeyHash: string, timestamp: number, body: string): string {
  const v1 = createHmac("sha256", secretKeyHash).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/** Claim one durable job. Delivery is at least once; deduplicate by deposit ID. */
export async function sendWebhook(deps: Deps, app: AppRow, deposit: DepositRow): Promise<void> {
  if (!app.webhook_url) return;
  if (deposit.status !== "succeeded" && deposit.status !== "failed") return;
  let attempt: number | undefined;
  try {
    const { rows } = await deps.db.query<DepositRow & { webhook_attempts: number; webhook_lease_until: Date }>(
      `update deposits set webhook_lease_until = now() + interval '30 seconds', webhook_attempts = webhook_attempts + 1
       where id = $1 and status in ('succeeded', 'failed') and webhook_delivered_at is null
         and webhook_next_attempt_at <= now() and (webhook_lease_until is null or webhook_lease_until < now())
       returning *`,
      [deposit.id],
    );
    const job = rows[0];
    if (!job) return;
    attempt = job.webhook_attempts;
    const body = JSON.stringify({ type: `deposit.${job.status}`, data: depositView(job) });
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await deps.fetch(app.webhook_url, {
      method: "POST",
      headers: { "content-type": "application/json", "swish-signature": signWebhook(app.secret_key_hash, timestamp, body) },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      await deps.db.query(
        "update deposits set webhook_delivered_at = now(), webhook_lease_until = null where id = $1 and webhook_attempts = $2",
        [job.id, attempt],
      );
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn(`[webhook] ${app.id} ${deposit.id}: ${(e as Error).message}`);
    // Keep the row pending even when the process exits during this update.
    // An abandoned lease becomes claimable automatically.
    await deps.db.query(
      `update deposits set webhook_next_attempt_at = now() + interval '30 seconds', webhook_lease_until = null
       where id = $1 and webhook_delivered_at is null and webhook_attempts = $2`,
      [deposit.id, attempt ?? -1],
    ).catch(() => {});
  }
}

export async function deliverPendingWebhooks(deps: Deps): Promise<void> {
  const { rows } = await deps.db.query<DepositRow>(
    `select d.* from deposits d join apps a on a.id = d.app_id
     where d.status in ('succeeded', 'failed') and d.webhook_delivered_at is null and a.webhook_url is not null
       and d.webhook_next_attempt_at <= now() and (d.webhook_lease_until is null or d.webhook_lease_until < now())
     order by d.webhook_next_attempt_at, d.id limit 100`,
  );
  for (const deposit of rows) {
    const app = (await deps.db.query<AppRow>("select * from apps where id = $1", [deposit.app_id])).rows[0];
    if (app) await sendWebhook(deps, app, deposit);
  }
}
