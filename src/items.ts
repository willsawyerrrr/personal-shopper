import { parse } from 'yaml'
import { ensureUser, type Sql } from './db.ts'
import { normalizeEmail } from './users/email.ts'

export interface ItemMapping {
  stockcode: number
  quantity: number
  /** The product's title on woolworths.com.au, looked up by the server. */
  listing?: string
}

export type ItemsConfig = Record<string, ItemMapping>

/** Parses the YAML an `items.yml` holds. */
export function parseItemsYaml(raw: string): ItemsConfig {
  const parsed = (parse(raw) as Record<string, ItemMapping & Record<string, unknown>> | null) ?? {}
  return Object.fromEntries(
    Object.entries(parsed).map(([word, { stockcode, quantity, listing }]) => [
      word,
      { stockcode, quantity, ...(listing ? { listing } : {}) },
    ]),
  )
}

/** Each user's spoken-term mappings, kept in Postgres. */
export class ItemStore {
  constructor(private readonly sql: Sql) {}

  /** The user's items in their stored order; none for a user without any. */
  async load(email: string): Promise<ItemsConfig> {
    const rows = await this.sql<
      { word: string; stockcode: number; quantity: number; listing: string | null }[]
    >`
      select i.word, i.stockcode, i.quantity, i.listing from items i
      join users u on u.id = i.user_id
      where u.email = ${normalizeEmail(email)}
      order by i.position`
    return Object.fromEntries(
      rows.map(({ word, stockcode, quantity, listing }) => [
        word,
        { stockcode, quantity, ...(listing ? { listing } : {}) },
      ]),
    )
  }

  /** Replaces the user's items with `items`, atomically. */
  async save(email: string, items: ItemsConfig): Promise<void> {
    const userId = await ensureUser(this.sql, email)
    const rows = Object.entries(items).map(([word, mapping], position) => ({
      user_id: userId,
      word,
      position,
      stockcode: mapping.stockcode,
      quantity: mapping.quantity,
      listing: mapping.listing ?? null,
    }))
    await this.sql.begin(async (tx) => {
      await tx`delete from items where user_id = ${userId}`
      if (rows.length > 0) {
        await tx`insert into items ${tx(rows)}`
      }
    })
  }
}

export function resolveItem(items: ItemsConfig, spokenTerm: string): ItemMapping | undefined {
  return items[normalizeWord(spokenTerm)]
}

export function normalizeWord(term: string): string {
  return term.trim().toLowerCase()
}
