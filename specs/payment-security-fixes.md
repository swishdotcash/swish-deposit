# Payment verification and settlement fixes

The seven review findings cover payment identity, widget trust, replay prevention,
uncertain broadcasts, static-server availability, webhook delivery and sponsor quotas.

## Implementation

- Store a commitment to the transfer details in each on-chain receipt. Validate the
  receipt owner, discriminator, size and commitment before reporting a payment.
- Retain receipts permanently as spent markers, including after their original
  approval expires. Disable receipt closing and stop scheduling rent cleanup.
  Previously closed receipts cannot be restored by this change; deploy with a
  fresh program ID or an explicit legacy-deposit cutover.
- Pin the hosted widget API to build configuration. Parent messages cannot select
  the endpoint receiving passkey assertions or wallet transactions.
- Save the signed transaction signature and block-height lifetime before broadcast.
  Reconcile submitted payments from verified receipts and confirmed transaction
  outcomes; transport errors and timeouts remain pending. Run reconciliation in a
  background worker as well as when the merchant reads a deposit.
- Treat undelivered terminal deposit rows as a durable webhook queue, with leases,
  retry backoff and the same delivery path for normal and reconciled outcomes.
- Serialize new-wallet reservations by locking the shared app row in a database
  transaction before counting its rolling daily reservations.
- Return HTTP 400 for invalid encoded request paths; keep the frame server alive.

## Security and compatibility

Existing API authentication and deposit-secret checks continue to gate requests.
Receipt commitments bind program, cluster, deposit ID, app, mint, destination and
amount. Approval deadlines are excluded so earlier approvals of the same payment
can settle correctly after a refresh. Receipts also record the actual wallet and
Swish ID that paid. A mismatch never credits a payment. Public API response fields
stay stable; submitted payments can now remain pending during RPC outages.
Webhook delivery is at least once; merchants must deduplicate terminal events by
deposit ID. Permanent receipts retain rent instead of refunding it to the sponsor.
The new receipt layout requires a matching contract and API release. Legacy
receipts without a commitment fail closed and require transaction-level review.

## Verification

Regression coverage exercises mismatched receipts and spoofed accounts, ambiguous
sends and late settlement, restart reconciliation and webhook retries, concurrent
quota reservations, parent-controlled API URLs, malformed request paths, and
multiple approvals sharing a deposit ID with different deadlines. The API,
frame, SDK and demo suites, all workspace typechecks, frontend builds, and the
Rust contract suite with the rebuilt SBF artifact pass locally. The quota test
uses PGlite; a separate multi-connection PostgreSQL load test was not run.
