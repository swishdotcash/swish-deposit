-- When Swish closed this deposit's on-chain receipt and got its rent back.
alter table deposits add column receipt_closed_at timestamptz;

create index deposits_receipts_to_close on deposits (expires_at)
  where status = 'succeeded' and receipt_closed_at is null;
