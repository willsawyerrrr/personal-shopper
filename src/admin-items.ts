import { escapeHtml } from './html.ts'
import type { ItemsConfig } from './items.ts'
import { displayCase, groupItems, groupKey, groupTitle, sortGroups } from './products.ts'

export interface ItemEdit {
  key: string
  values: Record<string, unknown>
}

/** One editable form per product; `edit` re-opens the product with `key` showing `values`. */
export function renderItemRows(items: ItemsConfig, edit?: ItemEdit): string {
  return sortGroups(groupItems(items))
    .map((group, index) => {
      const key = groupKey(group)
      const path = `/products/${key}`
      const editing = edit?.key === key
      const field = (name: string, fallback: string | number): string => {
        const value = editing ? edit.values[name] : undefined
        return escapeHtml(typeof value === 'string' ? value : String(fallback))
      }
      const title = groupTitle(group)
      const words = group.words.map(displayCase)
      const id = `edit-${index}`
      return `
        <form class="item" method="post" action="${path}/edit">
          <input type="checkbox" class="edit-toggle" id="${id}" aria-label="Edit ${escapeHtml(title)}"${editing ? ' checked' : ''}>
          <div class="cell phrase">
            <strong class="view">${escapeHtml(title)}</strong>
            <div class="view words">${words.map((word) => `<div>${escapeHtml(word)}</div>`).join('')}</div>
            <label class="edit"><span class="field-name">Trigger words, separated by commas</span>
              <input aria-label="Trigger words, separated by commas" name="words" required value="${field('words', words.join(', '))}">
            </label>
          </div>
          <div class="cell product">
            <span class="view"><span class="view-name">Stockcode</span>${group.stockcode}</span>
            <label class="edit"><span class="field-name">Woolworths product URL or stockcode</span>
              <input aria-label="Woolworths product URL or stockcode" name="url" required value="${field('url', group.stockcode)}">
            </label>
          </div>
          <div class="cell qty">
            <span class="view"><span class="view-name">Quantity</span>${group.quantity}</span>
            <label class="edit"><span class="field-name">Quantity</span>
              <input aria-label="Quantity" name="quantity" type="number" min="1" value="${field('quantity', group.quantity)}">
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
