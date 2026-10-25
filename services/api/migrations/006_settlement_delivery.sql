-- A signed transaction's identity and lifetime must be durable before broadcast.
alter table deposits add column last_valid_block_height numeric(20, 0);

-- Terminal deposit rows form a durable notification queue. A crashed worker's
-- lease expires; failures retry. Consumers deduplicate by deposit ID.
alter table deposits
  add column webhook_attempts integer not null default 0,
  add column webhook_next_attempt_at timestamptz not null default now(),
  add column webhook_lease_until timestamptz;

create index deposits_pending_webhooks on deposits (webhook_next_attempt_at)
  where status in ('succeeded', 'failed') and webhook_delivered_at is null;
create index deposits_pending_settlement on deposits (updated_at)
  where status = 'submitted';
