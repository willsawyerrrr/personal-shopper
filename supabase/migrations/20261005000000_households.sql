-- Households. A household is a group of users sharing one set of items, one
-- Woolworths session and one passkey credential. Tokens stay per user. RLS is
-- enabled on every new table with no policies, as on the existing ones.

create table households (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

-- Each existing user starts in a household of their own.
alter table users add column household_id uuid;
update users set household_id = gen_random_uuid();
insert into households (id) select household_id from users;
alter table users
  alter column household_id set not null,
  add constraint users_household_id_fkey foreign key (household_id) references households (id);
create index users_household_id_idx on users (household_id);

alter table items drop constraint items_user_id_fkey;
update items set user_id = users.household_id from users where users.id = items.user_id;
alter table items rename column user_id to household_id;
alter table items
  add constraint items_household_id_fkey
  foreign key (household_id) references households (id) on delete cascade;

alter table woolworths_sessions drop constraint woolworths_sessions_user_id_fkey;
update woolworths_sessions set user_id = users.household_id
  from users where users.id = woolworths_sessions.user_id;
alter table woolworths_sessions rename column user_id to household_id;
alter table woolworths_sessions
  add constraint woolworths_sessions_household_id_fkey
  foreign key (household_id) references households (id) on delete cascade;

alter table passkey_credentials drop constraint passkey_credentials_user_id_fkey;
update passkey_credentials set user_id = users.household_id
  from users where users.id = passkey_credentials.user_id;
alter table passkey_credentials rename column user_id to household_id;
alter table passkey_credentials
  add constraint passkey_credentials_household_id_fkey
  foreign key (household_id) references households (id) on delete cascade;

-- Single-use codes that let someone join a household; only the SHA-256 of the
-- code is stored. Times are epoch milliseconds.
create table household_invites (
  code_hash text primary key,
  household_id uuid not null references households (id) on delete cascade,
  created_by uuid not null references users (id) on delete cascade,
  created_at bigint not null,
  expires_at bigint not null
);
create index household_invites_household_id_idx on household_invites (household_id);

alter table households enable row level security;
alter table household_invites enable row level security;
