import { escapeHtml } from './html.ts'
import {
  displayCase,
  itemSubtitle,
  itemTitle,
  sortItems,
  type Item,
  type ItemCandidate,
  type ItemsConfig,
} from './items.ts'

export interface ItemEdit {
  key: string
  values: Record<string, unknown>
}

/** Alternative rows a web form shows: one `altUrl`/`altQuantity` pair per slot. */
export const MAX_ALTERNATIVES = 3

export interface AlternativeRow {
  url?: string
  quantity?: string
}

const toStrings = (value: unknown): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value.map(String) : [String(value)]

/** The alternative rows a submitted form holds, padded to `MAX_ALTERNATIVES`. */
export function alternativeRowsFromBody(body: Record<string, unknown>): AlternativeRow[] {
  const urls = toStrings(body.altUrl)
  const quantities = toStrings(body.altQuantity)
  return Array.from({ length: MAX_ALTERNATIVES }, (_, index) => ({
    ...(urls[index] !== undefined ? { url: urls[index] } : {}),
    ...(quantities[index] !== undefined ? { quantity: quantities[index] } : {}),
  }))
}

/** `candidates` turned into the rows a web form pre-fills, padded to `MAX_ALTERNATIVES`. */
export function alternativeRowsFromCandidates(candidates: ItemCandidate[] = []): AlternativeRow[] {
  return Array.from({ length: MAX_ALTERNATIVES }, (_, index) => {
    const candidate = candidates[index]
    return candidate
      ? { url: String(candidate.stockcode), quantity: String(candidate.quantity) }
      : {}
  })
}

/** Whether `body` carries the alternative-row fields a web form always submits. */
export const hasAlternativeFields = (body: Record<string, unknown>): boolean =>
  body.altUrl !== undefined || body.altQuantity !== undefined

/** The non-blank rows in `body`, shaped for `parseCandidates`. */
export function alternativesFromBody(body: Record<string, unknown>): unknown[] {
  return alternativeRowsFromBody(body)
    .filter((row) => row.url?.trim())
    .map((row) => ({ url: row.url, quantity: row.quantity }))
}

/** The `altUrl`/`altQuantity` label-and-input pairs for an item edit form. */
function renderAlternativeFields(rows: AlternativeRow[]): string {
  return rows
    .map(
      (row, index) => `
            <label class="edit"><span class="field-name">Alternative ${index + 1} URL or stockcode</span>
              <input aria-label="Alternative ${index + 1} URL or stockcode" name="altUrl" placeholder="https://www.woolworths.com.au/shop/productdetails/..." value="${escapeHtml(row.url ?? '')}">
            </label>
            <label class="edit"><span class="field-name">Alternative ${index + 1} quantity</span>
              <input aria-label="Alternative ${index + 1} quantity" name="altQuantity" type="number" min="1" value="${escapeHtml(row.quantity ?? '1')}">
            </label>`,
    )
    .join('')
}

/** One editable form per item; `edit` re-opens the item with `key` showing `values`. */
export function renderItemRows(items: ItemsConfig, edit?: ItemEdit): string {
  return sortItems(items)
    .map((item: Item, index) => {
      const path = `/items/${item.id}`
      const editing = edit?.key === item.id
      const field = (name: string, fallback: string | number): string => {
        const value = editing ? edit.values[name] : undefined
        return escapeHtml(typeof value === 'string' ? value : String(fallback))
      }
      const title = itemTitle(item)
      const subtitle = itemSubtitle(item)
      const words = item.words.map(displayCase)
      const id = `edit-${index}`
      const [primary, ...rest] = item.candidates
      const alternativeRows = editing
        ? alternativeRowsFromBody(edit.values)
        : alternativeRowsFromCandidates(rest)
      return `
        <form class="item" method="post" action="${path}/edit">
          <input type="checkbox" class="edit-toggle" id="${id}" aria-label="Edit ${escapeHtml(title)}"${editing ? ' checked' : ''}>
          <div class="cell phrase">
            <strong class="view">${escapeHtml(title)}</strong>
            ${subtitle ? `<div class="view words">${escapeHtml(subtitle)}</div>` : ''}
            <div class="view words">${words.map((word) => `<div>${escapeHtml(word)}</div>`).join('')}</div>
            <label class="edit"><span class="field-name">Name</span>
              <input aria-label="Name" name="name" maxlength="80" placeholder="${escapeHtml(item.listing ?? '')}" value="${field('name', item.name ?? '')}">
            </label>
            <label class="edit"><span class="field-name">Trigger words, separated by commas</span>
              <input aria-label="Trigger words, separated by commas" name="words" required value="${field('words', words.join(', '))}">
            </label>
            ${renderAlternativeFields(alternativeRows)}
          </div>
          <div class="cell product">
            <span class="view"><span class="view-name">Stockcode</span>${primary?.stockcode ?? ''}</span>
            <label class="edit"><span class="field-name">Woolworths product URL or stockcode</span>
              <input aria-label="Woolworths product URL or stockcode" name="url" required value="${field('url', primary?.stockcode ?? '')}">
            </label>
          </div>
          <div class="cell qty">
            <span class="view"><span class="view-name">Quantity</span>${primary?.quantity ?? ''}</span>
            <label class="edit"><span class="field-name">Quantity</span>
              <input aria-label="Quantity" name="quantity" type="number" min="1" value="${field('quantity', primary?.quantity ?? 1)}">
            </label>
          </div>
          <div class="cell actions">
            <label class="view button-label" for="${id}">Edit</label>
            <button type="submit" class="edit">Save</button>
            ${editing ? '<a class="edit button-link" href="/">Cancel</a>' : '<button type="reset" class="edit secondary">Cancel</button>'}
            <button type="submit" class="edit danger" formaction="${path}/delete" formnovalidate>Remove</button>
          </div>
        </form>`
    })
    .join('')
}
