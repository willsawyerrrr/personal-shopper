import { normalizeWord, type ItemMapping, type ItemsConfig } from './items.ts'
import { parseName, parseStockcode } from './item-edit.ts'

/** The trigger words that share one product and quantity. */
export interface ProductGroup {
  /** Stored (lower-case) words, in stored order. */
  words: string[]
  stockcode: number
  quantity: number
  /** The first listing any of the words has. */
  listing?: string
  /** The first custom name any of the words has. */
  name?: string
}

/** Identifies a group in URLs. */
export const groupKey = (group: Pick<ProductGroup, 'stockcode' | 'quantity'>): string =>
  `${group.stockcode}/${group.quantity}`

/** Groups items by stockcode and quantity, ordered by each group's first word's stored position. */
export function groupItems(items: ItemsConfig): ProductGroup[] {
  const groups = new Map<string, ProductGroup>()
  for (const [word, { stockcode, quantity, listing, name }] of Object.entries(items)) {
    const key = groupKey({ stockcode, quantity })
    const group = groups.get(key)
    if (group) {
      group.words.push(word)
      if (listing && !group.listing) {
        group.listing = listing
      }
      if (name && !group.name) {
        group.name = name
      }
    } else {
      groups.set(key, {
        words: [word],
        stockcode,
        quantity,
        ...(listing ? { listing } : {}),
        ...(name ? { name } : {}),
      })
    }
  }
  return [...groups.values()]
}

/** Upper-cases the first letter of each word, after whitespace or a hyphen. For display only. */
export function displayCase(word: string): string {
  return word.replace(
    /(^|[\s-])(\p{L})/gu,
    (_, before: string, letter: string) => before + letter.toUpperCase(),
  )
}

/** The group's custom name, else its Woolworths listing, else its first word display-cased. */
export const groupTitle = (group: ProductGroup): string =>
  group.name ?? group.listing ?? displayCase(group.words[0] ?? '')

/** The Woolworths listing, shown beneath a custom name; undefined when the title is the listing. */
export const groupSubtitle = (group: ProductGroup): string | undefined =>
  group.name ? group.listing : undefined

const titleCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })

/** Orders groups for display: by title, ignoring case and treating digit runs as numbers, then by stockcode and quantity. */
export const sortGroups = (groups: ProductGroup[]): ProductGroup[] =>
  [...groups].sort(
    (a, b) =>
      titleCollator.compare(groupTitle(a), groupTitle(b)) ||
      a.stockcode - b.stockcode ||
      a.quantity - b.quantity,
  )

/** Splits comma-separated or array input into distinct normalised words. */
export function parseWords(input: unknown): string[] | undefined {
  const parts = typeof input === 'string' ? input.split(',') : input
  if (!Array.isArray(parts) || parts.some((part) => typeof part !== 'string')) {
    return undefined
  }
  return [...new Set(parts.map((part: string) => normalizeWord(part)).filter(Boolean))]
}

export type GroupEditResult =
  | { ok: true; items: ItemsConfig; group: ProductGroup; stockcodeChanged: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string }

const blank = (value: unknown) => value === undefined || value === null || value === ''

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0
    ? number
    : undefined
}

/** The words of the group with `stockcode` and `quantity`. */
const membersOf = (items: ItemsConfig, stockcode: number, quantity: number): string[] =>
  Object.entries(items)
    .filter(([, item]) => item.stockcode === stockcode && item.quantity === quantity)
    .map(([word]) => word)

/**
 * Applies `fields` to the group with `stockcode` and `quantity`, leaving every other entry in
 * place and in order. `words` (an array or comma-separated string) replaces the group's whole
 * word set: removed words are deleted and new ones follow the group's last word. Blank `url`,
 * `stockcode` and `quantity` mean "unchanged"; `url` takes precedence over `stockcode`. A changed
 * stockcode drops the stored listing, which the caller looks up again. A present `name` replaces
 * the group's display name (blank clears it); otherwise the group keeps the name it has. Every
 * word of the group carries the name.
 */
export function applyGroupEdit(
  items: ItemsConfig,
  stockcode: number,
  quantity: number,
  fields: Record<string, unknown>,
): GroupEditResult {
  const members = membersOf(items, stockcode, quantity)
  if (members.length === 0) {
    return { ok: false, status: 404, error: 'No such item.' }
  }
  const invalid = (error: string): GroupEditResult => ({ ok: false, status: 400, error })

  let words = members
  if (fields.words !== undefined) {
    const parsed = parseWords(fields.words)
    if (!parsed?.length) {
      return invalid('At least one trigger word is required.')
    }
    words = parsed
    const taken = words.find((word) => items[word] && !members.includes(word))
    if (taken) {
      return { ok: false, status: 409, error: `"${taken}" is already used by another item.` }
    }
  }

  let newStockcode = stockcode
  if (!blank(fields.url)) {
    const parsed = typeof fields.url === 'string' ? parseStockcode(fields.url) : undefined
    if (!parsed) {
      return invalid(
        'Could not find a stockcode in that URL — paste a link like /shop/productdetails/123456/product-name, or the stockcode itself.',
      )
    }
    newStockcode = parsed
  } else if (!blank(fields.stockcode)) {
    const parsed = positiveInteger(fields.stockcode)
    if (!parsed) {
      return invalid('The stockcode must be a positive integer.')
    }
    newStockcode = parsed
  }

  let newQuantity = quantity
  if (!blank(fields.quantity)) {
    const parsed = positiveInteger(fields.quantity)
    if (!parsed) {
      return invalid('The quantity must be a positive integer.')
    }
    newQuantity = parsed
  }

  const named = fields.name === undefined ? undefined : parseName(fields.name)
  if (named && !named.ok) {
    return invalid(named.error)
  }
  const name = named ? named.name : groupItemsName(items, members)

  const stockcodeChanged = newStockcode !== stockcode
  const listing = stockcodeChanged ? undefined : groupItemsListing(items, members)
  const namedMapping: ItemMapping = {
    stockcode: newStockcode,
    quantity: newQuantity,
    ...(listing ? { listing } : {}),
    ...(name ? { name } : {}),
  }
  const last = members[members.length - 1]
  const entries: [string, ItemMapping][] = []
  for (const [word, item] of Object.entries(items)) {
    if (!members.includes(word)) {
      entries.push([word, item])
    } else if (words.includes(word)) {
      entries.push([word, namedMapping])
    }
    if (word === last) {
      entries.push(
        ...words
          .filter((added) => !members.includes(added))
          .map((added): [string, ItemMapping] => [added, namedMapping]),
      )
    }
  }
  const edited = Object.fromEntries(entries)
  const group = groupItems(edited).find(
    (candidate) => candidate.stockcode === newStockcode && candidate.quantity === newQuantity,
  ) as ProductGroup
  return { ok: true, items: edited, group, stockcodeChanged }
}

const groupItemsName = (items: ItemsConfig, members: string[]): string | undefined =>
  members.map((word) => items[word]?.name).find(Boolean)

const groupItemsListing = (items: ItemsConfig, members: string[]): string | undefined =>
  members.map((word) => items[word]?.listing).find(Boolean)

/** Removes every word of the group with `stockcode` and `quantity`; undefined when there is none. */
export function removeGroup(
  items: ItemsConfig,
  stockcode: number,
  quantity: number,
): ItemsConfig | undefined {
  const members = membersOf(items, stockcode, quantity)
  if (members.length === 0) {
    return undefined
  }
  return Object.fromEntries(Object.entries(items).filter(([word]) => !members.includes(word)))
}
