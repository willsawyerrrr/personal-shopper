import { normalizeWord, type ItemCandidate, type ItemMapping, type ItemsConfig } from './items.ts'

export type EditResult =
  | { ok: true; items: ItemsConfig; word: string }
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

// Applies the editable fields in `fields` to the item for `word`, leaving every other entry in
// place and in order. Blank `url`, `stockcode` and `quantity` mean "unchanged". `url` takes
// precedence over `stockcode`. A changed stockcode drops the stored listing, which the caller
// looks up again. A present `name` sets (or, when blank, clears) the display name on every word
// sharing the item's stockcode and quantity. A present `alternatives` replaces the item's
// alternatives wholesale; an empty array clears them.
export function applyEdit(
  items: ItemsConfig,
  word: string,
  fields: Record<string, unknown>,
): EditResult {
  const existing = items[word]
  if (!existing) {
    return { ok: false, status: 404, error: `No item for "${word}".` }
  }
  const invalid = (error: string): EditResult => ({ ok: false, status: 400, error })
  const mapping: ItemMapping = { ...existing }

  let newWord = word
  if (fields.word !== undefined) {
    newWord = typeof fields.word === 'string' ? normalizeWord(fields.word) : ''
    if (!newWord) {
      return invalid('A trigger word is required.')
    }
    if (newWord !== word && items[newWord]) {
      return { ok: false, status: 409, error: `"${newWord}" is already used by another item.` }
    }
  }

  if (!blank(fields.url)) {
    const stockcode = typeof fields.url === 'string' ? parseStockcode(fields.url) : undefined
    if (!stockcode) {
      return invalid(
        'Could not find a stockcode in that URL — paste a link like /shop/productdetails/123456/product-name, or the stockcode itself.',
      )
    }
    if (stockcode !== mapping.stockcode) {
      delete mapping.listing
    }
    mapping.stockcode = stockcode
  } else if (!blank(fields.stockcode)) {
    const stockcode = positiveInteger(fields.stockcode)
    if (!stockcode) {
      return invalid('The stockcode must be a positive integer.')
    }
    if (stockcode !== mapping.stockcode) {
      delete mapping.listing
    }
    mapping.stockcode = stockcode
  }

  if (!blank(fields.quantity)) {
    const quantity = positiveInteger(fields.quantity)
    if (!quantity) {
      return invalid('The quantity must be a positive integer.')
    }
    mapping.quantity = quantity
  }

  if (fields.alternatives !== undefined) {
    const candidates = parseCandidates(fields.alternatives)
    if (!candidates.ok) {
      return invalid(candidates.error)
    }
    if (candidates.candidates.length) {
      mapping.alternatives = candidates.candidates
    } else {
      delete mapping.alternatives
    }
  }

  const named = fields.name === undefined ? undefined : parseName(fields.name)
  if (named && !named.ok) {
    return invalid(named.error)
  }
  const edited = Object.fromEntries(
    Object.entries(items).map(([key, value]) => {
      if (key === word) {
        return [newWord, named ? withName(mapping, named.name) : mapping]
      }
      const sibling =
        named && value.stockcode === existing.stockcode && value.quantity === existing.quantity
      return [key, sibling ? withName(value, named.name) : value]
    }),
  )
  return { ok: true, items: edited, word: newWord }
}

/** `mapping` with `name` set, or removed when undefined. */
export function withName(mapping: ItemMapping, name: string | undefined): ItemMapping {
  const { name: _previous, ...rest } = mapping
  return name ? { ...rest, name } : rest
}

export type CandidatesResult =
  { ok: true; candidates: ItemCandidate[] } | { ok: false; error: string }

/**
 * Validates an `alternatives` array: each entry needs a product `url` or `stockcode`, like
 * `POST /items`; `quantity` defaults to 1.
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
