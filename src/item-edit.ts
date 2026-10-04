import { normalizeWord, type ItemMapping, type ItemsConfig } from './items.ts'

export type EditResult =
  | { ok: true; items: ItemsConfig; word: string }
  | { ok: false; status: 400 | 404 | 409; error: string }

const blank = (value: unknown) => value === undefined || value === null || value === ''

function positiveInteger(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) && number > 0
    ? number
    : undefined
}

// Applies the editable fields in `fields` to the item for `word`, leaving every other entry in
// place and in order. Blank `url`, `stockcode` and `quantity` mean "unchanged". `url` takes
// precedence over `stockcode`. A changed stockcode drops the stored listing, which the caller
// looks up again.
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

  const edited = Object.fromEntries(
    Object.entries(items).map(([key, value]) => (key === word ? [newWord, mapping] : [key, value])),
  )
  return { ok: true, items: edited, word: newWord }
}

export function parseStockcode(input: string): number | undefined {
  const trimmed = input.trim()
  const fromPath = trimmed.match(/productdetails\/(\d+)/)
  if (fromPath?.[1]) {
    return Number(fromPath[1])
  }
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined
}
