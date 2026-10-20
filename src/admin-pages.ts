import { PAGE_STYLES } from './admin-styles.ts'
import { renderHousehold, type HouseholdView } from './admin-household.ts'
import { renderItemRows, type ItemEdit } from './admin-items.ts'
import { escapeHtml, formatTime } from './html.ts'
import type { ItemsConfig } from './items.ts'
import type { SessionSummary } from './tokens.ts'

const PAGES = {
  items: { path: '/', label: 'Items', title: 'Shopping list items' },
  add: { path: '/items/new', label: 'Add item', title: 'Add an item' },
  household: { path: '/household/manage', label: 'Household', title: 'Household' },
  account: { path: '/account', label: 'Account', title: 'Account' },
} as const

type PageId = keyof typeof PAGES

/** The signed-in page chrome: navigation marking `page`, the heading, any `error` or `notice`, then `body`. */
function renderLayout(page: PageId, body: string, error?: string, notice?: string): string {
  const { title } = PAGES[page]
  const links = Object.entries(PAGES)
    .map(
      ([id, { path, label }]) =>
        `<li><a href="${path}"${id === page ? ' aria-current="page"' : ''}>${label}</a></li>`,
    )
    .join('')
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>personal-shopper — ${escapeHtml(title.toLowerCase())}</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <header class="top-bar">
    <nav aria-label="Main"><ul>${links}</ul></nav>
    <form method="post" action="/logout">
      <button type="submit" class="logout">Sign out</button>
    </form>
  </header>
  <h1>${escapeHtml(title)}</h1>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  ${notice ? `<p class="notice" role="status">${escapeHtml(notice)}</p>` : ''}
  ${body}
</body>
</html>`
}

export function renderItemsPage(items: ItemsConfig, edit?: ItemEdit, error?: string): string {
  const rows = renderItemRows(items, edit)
  return renderLayout(
    'items',
    `<section>
    <div class="items">
      <div class="item-head" aria-hidden="true"><span>Product</span><span>Stockcode</span><span>Qty</span><span></span></div>
      ${rows || '<p class="hint">No items configured yet.</p>'}
    </div>
  </section>`,
    error,
  )
}

export function renderAddItemPage(
  values: {
    word?: string | undefined
    url?: string | undefined
    quantity?: string | undefined
    name?: string | undefined
  } = {},
  error?: string,
): string {
  const field = (value: string | undefined): string => escapeHtml(value ?? '')
  return renderLayout(
    'add',
    `<section>
    <p class="hint">Find the product on woolworths.com.au and paste its URL below.</p>
    <form class="add" method="post" action="/items">
      <label>Trigger word (what you'll say to Siri)
        <input name="word" required placeholder="milk" value="${field(values.word)}">
      </label>
      <label>Woolworths product URL or stockcode
        <input name="url" required placeholder="https://www.woolworths.com.au/shop/productdetails/888137/..." value="${field(values.url)}">
      </label>
      <label>Quantity
        <input name="quantity" type="number" min="1" value="${field(values.quantity ?? '1')}">
      </label>
      <label>Name (optional)
        <input name="name" maxlength="80" value="${field(values.name)}">
      </label>
      <button type="submit">Add item</button>
    </form>
  </section>`,
    error,
  )
}

export function renderHouseholdPage(household: HouseholdView, error?: string): string {
  return renderLayout('household', renderHousehold(household), error)
}

/**
 * `passkey` is undefined when passkeys are disabled, which hides their section;
 * `notice` is a confirmation shown above the page.
 */
export function renderAccountPage(
  sessions: SessionSummary[],
  currentId: string | undefined,
  passkey: boolean | undefined,
  notice?: string,
): string {
  const sessionRows = sessions
    .map(
      (session) => `
        <tr>
          <td>${escapeHtml(session.client)}${session.id === currentId ? ' (this session)' : ''}</td>
          <td>${escapeHtml(session.email)}</td>
          <td>${formatTime(session.lastUsedAt)}</td>
          <td>${formatTime(session.expiresAt)}</td>
          <td>
            <form method="post" action="/sessions/${session.id}/revoke">
              <button type="submit">Revoke</button>
            </form>
          </td>
        </tr>`,
    )
    .join('')
  return renderLayout(
    'account',
    `${
      passkey === undefined
        ? ''
        : `<section>
    <h2>Woolworths passkey</h2>
    <p class="hint">${passkey ? 'Registered. The server signs in to Woolworths with it when your session expires.' : 'Not registered.'}</p>
    <button type="button" class="secondary" data-open-extension-options>${passkey ? 'Replace passkey' : 'Register passkey'}</button>
    <p class="hint extension-present">Opens the Chrome extension's settings, where you press Register passkey.</p>
    <p class="hint extension-absent">Install the Chrome extension to ${passkey ? 'replace' : 'register'} a passkey.</p>${
      passkey
        ? `
    <form method="post" action="/account/passkey/remove">
      <button type="submit" class="secondary danger">Remove passkey</button>
    </form>`
        : ''
    }
  </section>`
    }
  <section>
    <h2>Signed-in sessions</h2>
    <table class="sessions">
      <thead><tr><th>Client</th><th>Account</th><th>Last used</th><th>Expires</th><th></th></tr></thead>
      <tbody>${sessionRows}</tbody>
    </table>
  </section>`,
    undefined,
    notice,
  )
}
