-- The limit an allowance was created with, for "96 of 100 left". The chain
-- account only keeps what is left; the limit is in the transaction that
-- created it. It is read from the allowance's history once and kept here,
-- with the newest signature already read, so later reads only look at what
-- came after.
create table wallet_limits (
  allowance text primary key,
  wallet text not null,
  amount numeric(20, 0) not null check (amount > 0),
  read_to text not null,
  updated_at timestamptz not null default now()
);
