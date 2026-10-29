import { parse } from 'yaml'
import { ensureHousehold, type Sql } from './db.ts'
import { normalizeEmail } from './users/email.ts'

/** A stockcode and quantity the cheapest-candidate comparison considers alongside the primary one. */
export interface ItemCandidate {
  stockcode: number
  quantity: number
}

export interface ItemMapping {
  stockcode: number
  quantity: number
  /** The product's title on woolworths.com.au, looked up by the server. */
  listing?: string
  /** The household's own name for the product, shared by all its words. */
  name?: string
  /** Other stockcode/quantity options for the same product; the cheapest per unit is added. */
  alternatives?: ItemCandidate[]
}

export type ItemsConfig = Record<string, ItemMapping>

/** Parses the YAML an `items.yml` holds. */
export function parseItemsYaml(raw: string): ItemsConfig {
  const parsed = (parse(raw) as Record<string, ItemMapping & Record<string, unknown>> | null) ?? {}
  return Object.fromEntries(
    Object.entries(parsed).map(([word, { stockcode, quantity, listing, alternatives }]) => [
      word,
      {
        stockcode,
        quantity,
        ...(listing ? { listing } : {}),
        ...(alternatives?.length ? { alternatives } : {}),
      },
    ]),
  )
}

/** Each household's spoken-term mappings, kept in Postgres and shared by its members. */
export class ItemStore {
  constructor(private readonly sql: Sql) {}

  /** The user's household's items in their stored order; none when it has none. */
  async load(email: string): Promise<ItemsConfig> {
    const rows = await this.sql<
      {
        word: string
        stockcode: number
        quantity: number
        listing: string | null
        name: string | null
        alternatives: ItemCandidate[]
      }[]
    >`
      select i.word, i.stockcode, i.quantity, i.listing, i.name, i.alternatives from items i
      join users u on u.household_id = i.household_id
      where u.email = ${normalizeEmail(email)}
      order by i.position`
    return Object.fromEntries(
      rows.map(({ word, stockcode, quantity, listing, name, alternatives }) => [
        word,
        {
          stockcode,
          quantity,
          ...(listing ? { listing } : {}),
          ...(name ? { name } : {}),
          ...(alternatives.length ? { alternatives } : {}),
        },
      ]),
    )
  }

  /** Replaces the user's household's items with `items`, atomically. */
  async save(email: string, items: ItemsConfig): Promise<void> {
    const householdId = await ensureHousehold(this.sql, email)
    const rows = Object.entries(items).map(([word, mapping], position) => ({
      household_id: householdId,
      word,
      position,
      stockcode: mapping.stockcode,
      quantity: mapping.quantity,
      listing: mapping.listing ?? null,
      name: mapping.name ?? null,
      alternatives: this.sql.json((mapping.alternatives ?? []) as never),
    }))
    await this.sql.begin(async (tx) => {
      await tx`delete from items where household_id = ${householdId}`
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
