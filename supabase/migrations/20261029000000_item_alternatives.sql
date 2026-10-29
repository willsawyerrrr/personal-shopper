-- Other stockcode/quantity options for the same product; the server picks
-- the cheapest per unit at cart-add time. Empty when there are none.

alter table items add column alternatives jsonb not null default '[]'::jsonb;
