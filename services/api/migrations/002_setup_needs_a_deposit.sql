-- Swish pays rent and fees for setup, so setup only runs for a deposit your
-- server created (secret key): one wallet per deposit, a few transactions.
alter table deposits
  add column setup_wallet text,
  -- True when setting this wallet up created its accounts (Swish paid rent).
  add column setup_new_wallet boolean not null default false,
  add column setup_at timestamptz,
  add column setup_txs integer not null default 0;

create index deposits_app_new_wallets on deposits (app_id, setup_at) where setup_new_wallet;

-- A safety net, not a gate: new wallets Swish pays for, per app per day.
alter table apps add column daily_new_wallets integer not null default 2000;
