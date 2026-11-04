-- A household's Personal Shopper cart: the items it wants and how many of
-- each. Products are chosen from an item's candidates only at checkout.

create table cart_entries (
  household_id uuid not null references households (id) on delete cascade,
  item_id uuid not null references items (id) on delete cascade,
  count integer not null check (count > 0),
  created_at timestamptz not null default now(),
  primary key (household_id, item_id)
);
create index cart_entries_item_id_idx on cart_entries (item_id);

alter table cart_entries enable row level security;
