-- A household item is now first-class: `items` (id, optional display name
-- and looked-up listing), `item_words` (the trigger phrases that refer to
-- it) and `item_candidates` (its stockcode/quantity options — an unordered
-- set; the cheapest per unit is added to the cart, with no primary/
-- alternative distinction). Backfills from the existing word-keyed `items`
-- table: every distinct (stockcode, quantity, alternatives) combination
-- shared by a set of words becomes one item, those words become its
-- `item_words`, and its stockcode/quantity plus each of its alternatives
-- become its `item_candidates`.

create table items_new (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  position integer not null,
  name text,
  listing text
);
create index items_new_household_id_idx on items_new (household_id);

create table item_words (
  item_id uuid not null references items_new (id) on delete cascade,
  household_id uuid not null references households (id) on delete cascade,
  word text not null,
  position integer not null,
  primary key (household_id, word)
);
create index item_words_item_id_idx on item_words (item_id);

create table item_candidates (
  item_id uuid not null references items_new (id) on delete cascade,
  stockcode integer not null,
  quantity integer not null,
  position integer not null,
  primary key (item_id, stockcode, quantity)
);
create index item_candidates_item_id_idx on item_candidates (item_id);

-- One row per distinct (household, stockcode, quantity, alternatives)
-- combination in the old table: this is the new item. `listing`/`name` take
-- the first non-null value in word order, matching the old grouping-by-
-- product behaviour.
create temporary table item_groups as
select
  gen_random_uuid() as id,
  household_id,
  stockcode,
  quantity,
  alternatives,
  min(position) as position,
  (array_agg(listing order by position) filter (where listing is not null))[1] as listing,
  (array_agg(name order by position) filter (where name is not null))[1] as name
from items
group by household_id, stockcode, quantity, alternatives;

insert into items_new (id, household_id, position, name, listing)
select id, household_id, position, name, listing from item_groups;

insert into item_words (item_id, household_id, word, position)
select g.id, i.household_id, i.word, i.position
from items i
join item_groups g
  on g.household_id = i.household_id
 and g.stockcode = i.stockcode
 and g.quantity = i.quantity
 and g.alternatives = i.alternatives;

-- The old primary stockcode/quantity becomes candidate 0, each alternative
-- the following candidates, in their stored order.
insert into item_candidates (item_id, stockcode, quantity, position)
select g.id, g.stockcode, g.quantity, 0
from item_groups g
union all
select g.id, (alt ->> 'stockcode')::integer, (alt ->> 'quantity')::integer, idx::integer
from item_groups g
cross join lateral jsonb_array_elements(g.alternatives) with ordinality as t (alt, idx)
where jsonb_array_length(g.alternatives) > 0;

drop table item_groups;
drop table items;
alter table items_new rename to items;
alter index items_new_household_id_idx rename to items_household_id_idx;

alter table items enable row level security;
alter table item_words enable row level security;
alter table item_candidates enable row level security;
