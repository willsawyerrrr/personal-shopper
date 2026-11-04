import type { Sql } from './db.ts'
import { normalizeEmail } from './users/email.ts'

/** An item in a household's cart and how many of it the household wants. */
export interface CartEntry {
  itemId: string
  count: number
}

/** Each household's Personal Shopper cart, kept in Postgres. */
export class CartStore {
  constructor(private readonly sql: Sql) {}

  /**
   * Adds one of the item to the user's household's cart and returns the new
   * count; `undefined` when the item is not one of the household's.
   */
  async add(email: string, itemId: string): Promise<number | undefined> {
    const [row] = await this.sql<{ count: number }[]>`
      insert into cart_entries (household_id, item_id, count)
      select i.household_id, i.id, 1 from items i
      join users u on u.household_id = i.household_id
      where u.email = ${normalizeEmail(email)} and i.id = ${itemId}
      on conflict (household_id, item_id) do update set count = cart_entries.count + 1
      returning count`
    return row?.count
  }

  /** The user's household's cart entries, oldest first. */
  async list(email: string): Promise<CartEntry[]> {
    const rows = await this.sql<{ item_id: string; count: number }[]>`
      select c.item_id, c.count from cart_entries c
      join users u on u.household_id = c.household_id
      where u.email = ${normalizeEmail(email)}
      order by c.created_at, c.item_id`
    return rows.map(({ item_id, count }) => ({ itemId: item_id, count }))
  }

  /**
   * Removes `count` of the item from the user's household's cart, or all of
   * it when `count` is omitted, deleting the entry once none is left. Returns
   * whether the item was in the cart.
   */
  async remove(email: string, itemId: string, count?: number): Promise<boolean> {
    const normalized = normalizeEmail(email)
    return this.sql.begin(async (tx) => {
      const [current] = await tx<{ count: number }[]>`
        select c.count from cart_entries c
        join users u on u.household_id = c.household_id
        where u.email = ${normalized} and c.item_id = ${itemId}
        for update of c`
      if (!current) {
        return false
      }
      if (count === undefined || count >= current.count) {
        await tx`
          delete from cart_entries c using users u
          where u.household_id = c.household_id and u.email = ${normalized} and c.item_id = ${itemId}`
      } else {
        await tx`
          update cart_entries c set count = c.count - ${count} from users u
          where u.household_id = c.household_id and u.email = ${normalized} and c.item_id = ${itemId}`
      }
      return true
    })
  }

  /** Empties the user's household's cart. */
  async clear(email: string): Promise<void> {
    await this.sql`
      delete from cart_entries c using users u
      where u.household_id = c.household_id and u.email = ${normalizeEmail(email)}`
  }
}
