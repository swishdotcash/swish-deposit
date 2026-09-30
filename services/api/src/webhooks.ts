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

/** One attempt, no retries (yet). Never throws. */
export async function sendWebhook(deps: Deps, app: AppRow, deposit: DepositRow): Promise<void> {
  if (!app.webhook_url) return;
  if (deposit.status !== "succeeded" && deposit.status !== "failed") return;
  const body = JSON.stringify({ type: `deposit.${deposit.status}`, data: depositView(deposit) });
  const timestamp = Math.floor(Date.now() / 1000);
  try {
    const res = await deps.fetch(app.webhook_url, {
      method: "POST",
      headers: { "content-type": "application/json", "swish-signature": signWebhook(app.secret_key_hash, timestamp, body) },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      await deps.db.query("update deposits set webhook_delivered_at = now() where id = $1", [deposit.id]);
    } else {
      console.warn(`[webhook] ${app.id} ${deposit.id}: HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn(`[webhook] ${app.id} ${deposit.id}: ${(e as Error).message}`);
  }
}
