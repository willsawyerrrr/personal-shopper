import { normalizeWord, type Item, type ItemCandidate, type ItemsConfig } from './items.ts'

export type EditResult =
  | { ok: true; items: ItemsConfig; item: Item; stockcodeChanged: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string }

const blank = (value: unknown) => value === undefined || value === null || value === ''

export const MAX_NAME_LENGTH = 80

export type NameResult = { ok: true; name?: string } | { ok: false; error: string }

/** Validates a display name: trimmed, at most `MAX_NAME_LENGTH` characters; blank clears it. */
export function parseName(value: unknown): NameResult {
  if (blank(value)) {
    return { ok: true }
  }
  if (typeof value !== 'string') {
    return { ok: false, error: 'The name must be text.' }
  }
  const name = value.trim()
  if ([...name].length > MAX_NAME_LENGTH) {
    return { ok: false, error: `The name must be at most ${MAX_NAME_LENGTH} characters.` }
  }
  return name ? { ok: true, name } : { ok: true }
}

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0
    ? number
    : undefined
}

/** Splits comma-separated or array input into distinct normalised words. */
export function parseWords(input: unknown): string[] | undefined {
  const parts = typeof input === 'string' ? input.split(',') : input
  if (!Array.isArray(parts) || parts.some((part) => typeof part !== 'string')) {
    return undefined
  }
  return [...new Set(parts.map((part: string) => normalizeWord(part)).filter(Boolean))]
}

export type CandidatesResult =
  { ok: true; candidates: ItemCandidate[] } | { ok: false; error: string }

/**
 * Validates a `candidates`-shaped array: each entry needs a product `url` or
 * `stockcode`, like `POST /items`; `quantity` defaults to 1.
 */
export function parseCandidates(value: unknown): CandidatesResult {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'alternatives must be an array.' }
  }
  const candidates: ItemCandidate[] = []
  for (const entry of value) {
    const {
      url,
      stockcode: rawStockcode,
      quantity: rawQuantity,
    } = (entry ?? {}) as Record<string, unknown>
    const stockcode = typeof url === 'string' ? parseStockcode(url) : positiveInteger(rawStockcode)
    if (!stockcode) {
      return {
        ok: false,
        error:
          'Each alternative needs a product URL or stockcode, like /shop/productdetails/123456/product-name.',
      }
    }
    candidates.push({ stockcode, quantity: positiveInteger(rawQuantity) ?? 1 })
  }
  return { ok: true, candidates }
}

export function parseStockcode(input: string): number | undefined {
  const trimmed = input.trim()
  const fromPath = trimmed.match(/productdetails\/(\d+)/)
  if (fromPath?.[1]) {
    return Number(fromPath[1])
  }
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined
}

// Applies the editable fields in `fields` to the item with `id`, leaving every other item in
// place and in order. `words` (an array or comma-separated string) replaces the item's whole
// word set — at least one word is required, and none may already belong to another item. Blank
// `url`/`stockcode` and `quantity` mean "unchanged" for the item's first candidate. `url` takes
// precedence over `stockcode`. A changed first-candidate stockcode drops the stored listing,
// which the caller looks up again. A present `alternatives` replaces every candidate after the
// first wholesale (an empty array clears them). A present `name` sets (or, when blank, clears)
// the item's display name.
export function applyEdit(
  items: ItemsConfig,
  id: string,
  fields: Record<string, unknown>,
): EditResult {
  const index = items.findIndex((item) => item.id === id)
  if (index === -1) {
    return { ok: false, status: 404, error: 'No such item.' }
  }
  const existing = items[index] as Item
  const invalid = (error: string): EditResult => ({ ok: false, status: 400, error })

  let words = existing.words
  if (fields.words !== undefined) {
    const parsed = parseWords(fields.words)
    if (!parsed?.length) {
      return invalid('At least one trigger word is required.')
    }
    words = parsed
    const taken = words.find((word) =>
      items.some((other) => other.id !== id && other.words.includes(word)),
    )
    if (taken) {
      return { ok: false, status: 409, error: `"${taken}" is already used by another item.` }
    }
  }

  const first = existing.candidates[0]
  let primary = first
  let stockcodeChanged = false
  if (!blank(fields.url) || !blank(fields.stockcode)) {
    const stockcode = !blank(fields.url)
      ? typeof fields.url === 'string'
        ? parseStockcode(fields.url)
        : undefined
      : positiveInteger(fields.stockcode)
    if (!stockcode) {
      return invalid(
        'Could not find a stockcode in that URL — paste a link like /shop/productdetails/123456/product-name, or the stockcode itself.',
      )
    }
    const quantity = blank(fields.quantity)
      ? (first?.quantity ?? 1)
      : positiveInteger(fields.quantity)
    if (!quantity) {
      return invalid('The quantity must be a positive integer.')
    }
    stockcodeChanged = stockcode !== first?.stockcode
    primary = { stockcode, quantity }
  } else if (!blank(fields.quantity)) {
    const quantity = positiveInteger(fields.quantity)
    if (!quantity) {
      return invalid('The quantity must be a positive integer.')
    }
    primary = first ? { ...first, quantity } : undefined
  }

  let rest = existing.candidates.slice(1)
  if (fields.alternatives !== undefined) {
    const parsed = parseCandidates(fields.alternatives)
    if (!parsed.ok) {
      return invalid(parsed.error)
    }
    rest = parsed.candidates
  }
  const candidates = primary ? [primary, ...rest] : rest
  if (candidates.length === 0) {
    return invalid('At least one product is required.')
  }

  const named = fields.name === undefined ? undefined : parseName(fields.name)
  if (named && !named.ok) {
    return invalid(named.error)
  }

  const updated: Item = { ...existing, words, candidates }
  if (named) {
    if (named.name) {
      updated.name = named.name
    } else {
      delete updated.name
    }
  }
  if (stockcodeChanged) {
    delete updated.listing
  }
  const edited = [...items]
  edited[index] = updated
  return { ok: true, items: edited, item: updated, stockcodeChanged }
}
