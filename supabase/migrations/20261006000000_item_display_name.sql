-- A household's own display name for a product. Every word of a product
-- (stockcode and quantity) carries the same name; null means unnamed.

alter table items add column name text;
