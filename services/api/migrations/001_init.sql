-- Apps (integrators). `id` is also the on-chain App id: its 16 bytes.
create table apps (
  id uuid primary key,
  name text not null,
  website text not null,
  contact_email text not null,
  -- Sites the widget may run on (exact origins, e.g. https://app.example.com).
  allowed_origins text[] not null default '{}',
  publishable_key text not null unique,
  -- sha256 of the secret key; the key itself is shown once and never stored.
  secret_key_hash text not null unique,
  webhook_url text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Browsers reveal a passkey's public key only when it is created, so this
-- maps the credential id a Face ID returns to the key and its Swish ID. An
-- index only: the program checks every signature against the key on chain.
create table passkeys (
  credential_id text primary key,
  public_key bytea not null check (length(public_key) = 33),
  swish_id text not null,
  created_at timestamptz not null default now()
);

-- `id` is also the program's one-time deposit id: its 16 bytes.
create table deposits (
  id uuid primary key,
  app_id uuid not null references apps(id),
  mint text not null,
  -- The user's own address in the app, and its token account (where it lands).
  destination_owner text not null,
  destination text not null,
  -- Base units (USDC: 6 decimals).
  amount numeric(20, 0) not null check (amount > 0),
  reference text,
  -- sha256 of the client secret the widget uses for this deposit.
  client_secret_hash text not null unique,
  status text not null default 'created'
    check (status in ('created', 'submitted', 'succeeded', 'failed')),
  -- Set when the widget asks for the challenge; the passkey signs it.
  expires_at timestamptz,
  swish_id text,
  wallet text,
  signature text,
  error text,
  webhook_delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index deposits_app_created on deposits (app_id, created_at desc);
create unique index deposits_app_reference on deposits (app_id, reference) where reference is not null;
