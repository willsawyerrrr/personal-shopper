-- Per-user data. The server connects with a privileged role and is the only
-- client: row level security is enabled on every table with no policies, so
-- the anon and authenticated roles can read and write nothing.

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  created_at timestamptz not null default now()
);

-- Bearer tokens and admin sessions; only the SHA-256 of the token is stored.
-- Times are epoch milliseconds.
create table tokens (
  hash text primary key,
  user_id uuid not null references users (id) on delete cascade,
  client text not null check (client in ('web', 'ios', 'extension')),
  created_at bigint not null,
  last_used_at bigint not null,
  expires_at bigint not null
);
create index tokens_user_id_idx on tokens (user_id);

create table items (
  user_id uuid not null references users (id) on delete cascade,
  word text not null,
  position integer not null,
  stockcode integer not null,
  quantity integer not null,
  listing text,
  primary key (user_id, word)
);

-- A user's Woolworths cookie jar.
create table woolworths_sessions (
  user_id uuid primary key references users (id) on delete cascade,
  cookies jsonb not null,
  captured_at timestamptz not null
);

-- AES-256-GCM encrypted by the server (IV, auth tag, ciphertext); the key is
-- never stored here.
create table passkey_credentials (
  user_id uuid primary key references users (id) on delete cascade,
  encrypted bytea not null,
  updated_at timestamptz not null default now()
);

alter table users enable row level security;
alter table tokens enable row level security;
alter table items enable row level security;
alter table woolworths_sessions enable row level security;
alter table passkey_credentials enable row level security;
