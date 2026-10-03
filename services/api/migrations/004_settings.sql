-- Small facts the API keeps about its own on-chain setup, e.g. the address
-- lookup table it made for deposits ("lookup_table:<mint>").
create table settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
