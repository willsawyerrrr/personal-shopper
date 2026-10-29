import { randomUUID } from 'node:crypto'
import { parse } from 'yaml'
import { ensureHousehold, type Sql } from './db.ts'
import { normalizeEmail } from './users/email.ts'

/** A stockcode and quantity option for an item; the cheapest per unit is added to the cart. */
export interface ItemCandidate {
  stockcode: number
  quantity: number
}

/** A household item: the thing multiple trigger phrases can refer to. */
export interface Item {
  id: string
  /** The household's own name for the item. */
  name?: string
  /** The product's title on woolworths.com.au, looked up by the server for its first candidate. */
  listing?: string
  /** The spoken trigger phrases that refer to this item, in stored order. */
  words: string[]
  /** This item's stockcode/quantity options, an unordered set, in stored order. */
  candidates: ItemCandidate[]
}

export type ItemsConfig = Item[]

interface LegacyMapping {
  stockcode: number
  quantity: number
  listing?: string
  alternatives?: ItemCandidate[]
}

/**
 * Parses the YAML an `items.yml` holds (the legacy single-user, word-keyed
 * format) into items: words sharing an identical stockcode, quantity and
 * alternatives set become one item.
 */
export function parseItemsYaml(raw: string): ItemsConfig {
  const parsed =
    (parse(raw) as Record<string, LegacyMapping & Record<string, unknown>> | null) ?? {}
  const groups = new Map<string, Item>()
  for (const [word, { stockcode, quantity, listing, alternatives }] of Object.entries(parsed)) {
    const candidates: ItemCandidate[] = [{ stockcode, quantity }, ...(alternatives ?? [])]
    const key = JSON.stringify(candidates)
    const existing = groups.get(key)
    if (existing) {
      existing.words.push(normalizeWord(word))
      if (listing && !existing.listing) {
        existing.listing = listing
      }
    } else {
      groups.set(key, {
        id: randomUUID(),
        words: [normalizeWord(word)],
        candidates,
        ...(listing ? { listing } : {}),
      })
    }
  }
  return [...groups.values()]
}

function groupBy<T extends { item_id: string }>(rows: T[]): Map<string, Omit<T, 'item_id'>[]> {
  const grouped = new Map<string, Omit<T, 'item_id'>[]>()
  for (const { item_id, ...rest } of rows) {
    const list = grouped.get(item_id)
    if (list) {
      list.push(rest)
    } else {
      grouped.set(item_id, [rest])
    }
  }
  return grouped
}

/** Each household's items, with their trigger words and candidate products, kept in Postgres. */
export class ItemStore {
  constructor(private readonly sql: Sql) {}

  /** The user's household's items in their stored order; none when it has none. */
  async load(email: string): Promise<ItemsConfig> {
    const normalized = normalizeEmail(email)
    const items = await this.sql<{ id: string; name: string | null; listing: string | null }[]>`
      select i.id, i.name, i.listing from items i
      join users u on u.household_id = i.household_id
      where u.email = ${normalized}
      order by i.position`
    if (items.length === 0) {
      return []
    }
    const ids = items.map((item) => item.id)
    const words = await this.sql<{ item_id: string; word: string }[]>`
      select item_id, word from item_words where item_id in ${this.sql(ids)} order by position`
    const candidates = await this.sql<{ item_id: string; stockcode: number; quantity: number }[]>`
      select item_id, stockcode, quantity from item_candidates
      where item_id in ${this.sql(ids)} order by position`
    const wordsByItem = groupBy(words)
    const candidatesByItem = groupBy(candidates)
    return items.map(({ id, name, listing }) => ({
      id,
      ...(name ? { name } : {}),
      ...(listing ? { listing } : {}),
      words: (wordsByItem.get(id) ?? []).map(({ word }) => word),
      candidates: candidatesByItem.get(id) ?? [],
    }))
  }

  /** Replaces the user's household's items with `items`, atomically. */
  async save(email: string, items: ItemsConfig): Promise<void> {
    const householdId = await ensureHousehold(this.sql, email)
    const itemRows = items.map((item, position) => ({
      id: item.id,
      household_id: householdId,
      position,
      name: item.name ?? null,
      listing: item.listing ?? null,
    }))
    const wordRows = items.flatMap((item) =>
      item.words.map((word, position) => ({
        item_id: item.id,
        household_id: householdId,
        word,
        position,
      })),
    )
    const candidateRows = items.flatMap((item) =>
      item.candidates.map((candidate, position) => ({
        item_id: item.id,
        stockcode: candidate.stockcode,
        quantity: candidate.quantity,
        position,
      })),
    )
    await this.sql.begin(async (tx) => {
      await tx`delete from items where household_id = ${householdId}`
      if (itemRows.length > 0) {
        await tx`insert into items ${tx(itemRows)}`
      }
      if (wordRows.length > 0) {
        await tx`insert into item_words ${tx(wordRows)}`
      }
      if (candidateRows.length > 0) {
        await tx`insert into item_candidates ${tx(candidateRows)}`
      }
    })
  }
}

/** The item one of whose words is `spokenTerm`, case- and whitespace-insensitively. */
export function resolveItem(items: ItemsConfig, spokenTerm: string): Item | undefined {
  const word = normalizeWord(spokenTerm)
  return items.find((item) => item.words.includes(word))
}

export function normalizeWord(term: string): string {
  return term.trim().toLowerCase()
}

/** Upper-cases the first letter of each word, after whitespace or a hyphen. For display only. */
export function displayCase(word: string): string {
  return word.replace(
    /(^|[\s-])(\p{L})/gu,
    (_, before: string, letter: string) => before + letter.toUpperCase(),
  )
}

/** The item's custom name, else its listing, else its first word display-cased. */
export const itemTitle = (item: Item): string =>
  item.name ?? item.listing ?? displayCase(item.words[0] ?? '')

/** The listing, shown beneath a custom name; undefined when the title is the listing. */
export const itemSubtitle = (item: Item): string | undefined =>
  item.name ? item.listing : undefined

const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** Orders items for display: by title, ignoring case and treating digit runs as numbers. */
export const sortItems = (items: ItemsConfig): ItemsConfig =>
  [...items].sort(
    (a, b) =>
      titleCollator.compare(itemTitle(a), itemTitle(b)) ||
      (a.candidates[0]?.stockcode ?? 0) - (b.candidates[0]?.stockcode ?? 0) ||
      (a.candidates[0]?.quantity ?? 0) - (b.candidates[0]?.quantity ?? 0),
  )
