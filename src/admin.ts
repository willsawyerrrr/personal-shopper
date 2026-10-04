import formbody from '@fastify/formbody'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate, logAuthFailure, requestPath, sessionCookie } from './auth.ts'
import type { AppConfig } from './config.ts'
import { normalizeWord, type ItemMapping, type ItemsConfig, type ItemStore } from './items.ts'
import { createListingBackfill, lookupListing } from './listings.ts'
import type { SessionSummary, TokenStore } from './tokens.ts'
import type { ProductLookup } from './woolworths/client.ts'

export async function registerAdmin(
  app: FastifyInstance,
  config: AppConfig,
  tokens: TokenStore,
  store: ItemStore,
  lookupFor?: (email: string) => ProductLookup,
): Promise<void> {
  const secureCookie = config.publicBaseUrl.startsWith('https:')
  const backfills = new Map<string, () => Promise<void>>()
  // One backfill per user, so a user's items are only ever filled in with
  // listings looked up through that user's own session.
  const backfillFor = (email: string): (() => Promise<void>) => {
    let backfill = backfills.get(email)
    if (!backfill) {
      backfill = createListingBackfill(store, email, lookupFor?.(email), app.log)
      backfills.set(email, backfill)
    }
    return backfill
  }
  app.addHook('onReady', async () => {
    for (const email of new Set([config.ownerEmail, ...(await tokens.emails())])) {
      void backfillFor(email)()
    }
  })

  await app.register(async (admin) => {
    await admin.register(formbody)

    // The token a request authenticated with, for marking and ending its own session.
    const current = new WeakMap<FastifyRequest, { token: string; id: string; email: string }>()

    // Set by the `onRequest` hook below for every authenticated request.
    const emailOf = (request: FastifyRequest): string =>
      (current.get(request) as { email: string }).email
    const backfillOf = (request: FastifyRequest): Promise<void> => backfillFor(emailOf(request))()
    // A user sees and revokes only their own sign-ins.
    const sessionsOf = async (request: FastifyRequest): Promise<SessionSummary[]> =>
      (await tokens.list()).filter((session) => session.email === emailOf(request))

    admin.addHook('onRequest', async (request, reply) => {
      if (requestPath(request) === '/admin/login') {
        return
      }
      const result = await authenticate(request, tokens, config.allowedEmails, true)
      if (result.ok) {
        current.set(request, {
          token: result.token,
          id: tokens.sessionId(result.record),
          email: result.record.email,
        })
        return
      }
      logAuthFailure(request, result.failure)
      if (wantsJson(request)) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
      if (request.method === 'GET') {
        return reply.redirect('/admin/login')
      }
      reply.code(401).send('Authentication required')
    })

    admin.get('/admin/login', async (_request, reply) => {
      reply.type('text/html').send(renderLoginPage())
    })

    admin.post('/admin/logout', async (request, reply) => {
      const token = current.get(request)?.token
      if (token) {
        await tokens.revoke(token)
      }
      reply.header('set-cookie', sessionCookie('', 0, secureCookie)).redirect('/admin/login')
    })

    admin.post<{ Params: { id: string } }>('/admin/sessions/:id/revoke', async (request, reply) => {
      if ((await sessionsOf(request)).some((session) => session.id === request.params.id)) {
        await tokens.revokeById(request.params.id)
      }
      if (wantsJson(request)) {
        return reply.code(204).send()
      }
      if (request.params.id === current.get(request)?.id) {
        reply.header('set-cookie', sessionCookie('', 0, secureCookie))
        return reply.redirect('/admin/login')
      }
      return reply.redirect('/admin')
    })

    admin.get('/admin', async (request, reply) => {
      const items = await store.load(emailOf(request))
      void backfillOf(request)
      const sessions = await sessionsOf(request)
      reply.type('text/html').send(renderPage(items, sessions, current.get(request)?.id))
    })

    admin.get('/admin/items', async (request) => {
      const items = await store.load(emailOf(request))
      void backfillOf(request)
      return {
        items: Object.entries(items)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([word, mapping]) => ({ word, ...mapping })),
      }
    })

    admin.post<{
      Body: { word?: string; url?: string; quantity?: string | number }
    }>('/admin/items', async (request, reply) => {
      const { word, url, quantity } = request.body
      const items = await store.load(emailOf(request))
      const stockcode = parseStockcode(url ?? '')
      const error = !word?.trim()
        ? 'A trigger word is required.'
        : !stockcode
          ? 'Could not find a stockcode in that URL — paste a link like /shop/productdetails/123456/product-name, or the stockcode itself.'
          : undefined
      if (error || !word || !stockcode) {
        if (wantsJson(request)) {
          return reply.code(400).send({ error })
        }
        const sessions = await sessionsOf(request)
        return reply
          .code(400)
          .type('text/html')
          .send(renderPage(items, sessions, current.get(request)?.id, error))
      }
      const listing = await lookupListing(lookupFor?.(emailOf(request)), stockcode, request.log)
      const mapping: ItemMapping = {
        stockcode,
        quantity: Math.max(1, Number(quantity) || 1),
        ...(listing ? { listing } : {}),
      }
      items[normalizeWord(word)] = mapping
      await store.save(emailOf(request), items)
      if (wantsJson(request)) {
        return reply.code(201).send({ word: normalizeWord(word), ...mapping })
      }
      return reply.redirect('/admin')
    })

    const removeItem = async (
      request: FastifyRequest<{ Params: { word: string } }>,
      reply: FastifyReply,
    ) => {
      const items = await store.load(emailOf(request))
      delete items[normalizeWord(request.params.word)]
      await store.save(emailOf(request), items)
      if (wantsJson(request)) {
        return reply.code(204).send()
      }
      return reply.redirect('/admin')
    }
    const editItem = async (
      request: FastifyRequest<{ Params: { word: string }; Body: Record<string, unknown> | null }>,
      reply: FastifyReply,
    ) => {
      const items = await store.load(emailOf(request))
      const result = applyEdit(items, normalizeWord(request.params.word), request.body ?? {})
      if (!result.ok) {
        if (wantsJson(request)) {
          return reply.code(result.status).send({ error: result.error })
        }
        const sessions = await sessionsOf(request)
        return reply
          .code(result.status)
          .type('text/html')
          .send(renderPage(items, sessions, current.get(request)?.id, result.error))
      }
      const edited = result.items[result.word]
      if (edited && edited.stockcode !== items[normalizeWord(request.params.word)]?.stockcode) {
        const listing = await lookupListing(
          lookupFor?.(emailOf(request)),
          edited.stockcode,
          request.log,
        )
        if (listing) {
          edited.listing = listing
        }
      }
      await store.save(emailOf(request), result.items)
      if (wantsJson(request)) {
        return reply.send({ word: result.word, ...result.items[result.word] })
      }
      return reply.redirect('/admin')
    }
    admin.patch<{ Params: { word: string }; Body: Record<string, unknown> | null }>(
      '/admin/items/:word',
      editItem,
    )
    admin.post<{ Params: { word: string }; Body: Record<string, unknown> | null }>(
      '/admin/items/:word/edit',
      editItem,
    )
    admin.post<{ Params: { word: string } }>('/admin/items/:word/delete', removeItem)
    admin.delete<{ Params: { word: string } }>('/admin/items/:word', removeItem)
  })
}

// API clients (the iOS app, the extension) opt in with `Accept: application/json` and get
// JSON bodies and status codes instead of the browser flow's redirects.
function wantsJson(request: FastifyRequest): boolean {
  return request.headers.accept?.includes('application/json') ?? false
}

type EditResult =
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
function applyEdit(items: ItemsConfig, word: string, fields: Record<string, unknown>): EditResult {
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

function parseStockcode(input: string): number | undefined {
  const trimmed = input.trim()
  const fromPath = trimmed.match(/productdetails\/(\d+)/)
  if (fromPath?.[1]) {
    return Number(fromPath[1])
  }
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined
}

const PAGE_STYLES = `
  :root {
    --color-bg: #f6f7f5;
    --color-surface: #ffffff;
    --color-border: #dde1db;
    --color-text: #1f2a24;
    --color-text-muted: #667066;
    --color-accent: #1f7a4d;
    --color-accent-hover: #17603c;
    --color-danger: #b3261e;
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    max-width: 640px;
    margin: 2.5rem auto;
    padding: 0 1rem;
    background: var(--color-bg);
    color: var(--color-text);
  }
  h1 { font-size: 1.3rem; font-weight: 600; margin: 0 0 1.25rem; }
  h2 { font-size: 1rem; font-weight: 600; margin: 0 0 0.5rem; }
  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.5rem;
  }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid var(--color-border); font-size: 0.9rem; }
  th { color: var(--color-text-muted); font-weight: 500; }
  label { display: block; margin-bottom: 0.85rem; font-size: 0.8rem; font-weight: 500; color: var(--color-text-muted); }
  input {
    width: 100%;
    margin-top: 0.3rem;
    padding: 0.5rem 0.6rem;
    font-size: 0.9rem;
    font-family: inherit;
    color: var(--color-text);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }
  input:focus {
    outline: none;
    border-color: var(--color-accent);
    box-shadow: 0 0 0 3px rgb(31 122 77 / 15%);
  }
  button {
    padding: 0.5rem 1rem;
    font-size: 0.9rem;
    font-weight: 600;
    font-family: inherit;
    color: #fff;
    background: var(--color-accent);
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
  }
  button:hover { background: var(--color-accent-hover); }
  table button {
    padding: 0.3rem 0.6rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--color-danger);
    background: transparent;
    border: 1px solid var(--color-border);
  }
  table button:hover { background: var(--color-bg); }
  details.edit { margin-bottom: 0.4rem; }
  details.edit summary {
    cursor: pointer;
    font-size: 0.8rem;
    color: var(--color-accent);
  }
  details.edit form { min-width: 14rem; margin-top: 0.6rem; }
  .listing { color: var(--color-text-muted); font-size: 0.8rem; margin-top: 0.15rem; }
  .error { color: var(--color-danger); margin: 0 0 1rem; font-size: 0.9rem; }
  .hint { color: var(--color-text-muted); font-size: 0.85rem; margin: 0 0 1rem; }
  .top-bar { display: flex; align-items: center; justify-content: space-between; }
  .logout {
    padding: 0.3rem 0.7rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--color-text-muted);
    background: transparent;
    border: 1px solid var(--color-border);
  }
  .logout:hover { background: var(--color-surface); }
`

function renderLoginPage(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>personal-shopper — sign in</title>
  <style>
    ${PAGE_STYLES}
    body { max-width: 360px; margin-top: 6rem; }
    .button {
      display: inline-block;
      padding: 0.5rem 1rem;
      font-size: 0.9rem;
      font-weight: 600;
      color: #fff;
      background: var(--color-accent);
      border-radius: var(--radius);
      text-decoration: none;
    }
    .button:hover { background: var(--color-accent-hover); }
  </style>
</head>
<body>
  <div class="card">
    <h1>Personal Shopper admin</h1>
    <a class="button" href="/auth/google/login">Sign in with Google</a>
  </div>
</body>
</html>`
}

function renderPage(
  items: ItemsConfig,
  sessions: SessionSummary[],
  currentId: string | undefined,
  error?: string,
): string {
  const rows = Object.entries(items)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([word, mapping]) => `
        <tr>
          <td>
            <strong>${escapeHtml(word)}</strong>
            ${mapping.listing ? `<div class="listing">${escapeHtml(mapping.listing)}</div>` : ''}
          </td>
          <td>${mapping.stockcode}</td>
          <td>${mapping.quantity}</td>
          <td>
            <details class="edit">
              <summary>Edit</summary>
              <form method="post" action="/admin/items/${encodeURIComponent(word)}/edit">
                <label>Trigger word
                  <input name="word" required value="${escapeHtml(word)}">
                </label>
                <label>Woolworths product URL or stockcode
                  <input name="url" required value="${mapping.stockcode}">
                </label>
                <label>Quantity
                  <input name="quantity" type="number" min="1" value="${mapping.quantity}">
                </label>
                <button type="submit">Save</button>
              </form>
            </details>
            <form method="post" action="/admin/items/${encodeURIComponent(word)}/delete">
              <button type="submit">Remove</button>
            </form>
          </td>
        </tr>`,
    )
    .join('')

  const sessionRows = sessions
    .map(
      (session) => `
        <tr>
          <td>${escapeHtml(session.client)}${session.id === currentId ? ' (this session)' : ''}</td>
          <td>${escapeHtml(session.email)}</td>
          <td>${formatTime(session.lastUsedAt)}</td>
          <td>${formatTime(session.expiresAt)}</td>
          <td>
            <form method="post" action="/admin/sessions/${session.id}/revoke">
              <button type="submit">Revoke</button>
            </form>
          </td>
        </tr>`,
    )
    .join('')

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>personal-shopper — items</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="top-bar">
    <h1>Shopping list items</h1>
    <form method="post" action="/admin/logout">
      <button type="submit" class="logout">Sign out</button>
    </form>
  </div>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <div class="card">
    <table>
      <thead><tr><th>Phrase</th><th>Stockcode</th><th>Qty</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">No items configured yet.</td></tr>'}</tbody>
    </table>
  </div>
  <div class="card">
    <h2>Add an item</h2>
    <p class="hint">Find the product on woolworths.com.au and paste its URL below.</p>
    <form class="add" method="post" action="/admin/items">
      <label>Trigger word (what you'll say to Siri)
        <input name="word" required placeholder="milk">
      </label>
      <label>Woolworths product URL or stockcode
        <input name="url" required placeholder="https://www.woolworths.com.au/shop/productdetails/888137/...">
      </label>
      <label>Quantity
        <input name="quantity" type="number" min="1" value="1">
      </label>
      <button type="submit">Add item</button>
    </form>
  </div>
  <div class="card">
    <h2>Signed-in sessions</h2>
    <table>
      <thead><tr><th>Client</th><th>Account</th><th>Last used</th><th>Expires</th><th></th></tr></thead>
      <tbody>${sessionRows}</tbody>
    </table>
  </div>
</body>
</html>`
}

function formatTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
