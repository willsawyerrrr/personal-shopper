import formbody from '@fastify/formbody'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { PAGE_STYLES } from './admin-styles.ts'
import { UserRateLimiter } from './rate-limit.ts'
import { authenticate, logAuthFailure, requestPath, sessionCookie } from './auth.ts'
import type { AppConfig } from './config.ts'
import { applyEdit, parseStockcode } from './item-edit.ts'
import { normalizeWord, type ItemMapping, type ItemsConfig, type ItemStore } from './items.ts'
import { createListingBackfill, lookupListing } from './listings.ts'
import type { CredentialStore } from './users/credentials.ts'
import type { SessionSummary, TokenStore } from './tokens.ts'
import type { ProductLookup } from './woolworths/client.ts'

export async function registerAdmin(
  app: FastifyInstance,
  config: AppConfig,
  tokens: TokenStore,
  store: ItemStore,
  lookupFor?: (email: string) => ProductLookup,
  passkeys?: CredentialStore,
  now: () => number = Date.now,
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
    const owner = config.ownerEmail ? [config.ownerEmail] : []
    for (const email of new Set([...owner, ...(await tokens.emails())])) {
      void backfillFor(email)()
    }
  })

  await app.register(async (admin) => {
    await admin.register(formbody)
    const userLimiter = new UserRateLimiter(config.limits.userRequestsPerMinute, now)

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
      const result = await authenticate(request, tokens, true)
      if (result.ok) {
        const limit = userLimiter.hit(result.record.email)
        if (!limit.ok) {
          return reply
            .code(429)
            .header('retry-after', limit.retryAfterSeconds)
            .send({ error: 'rate_limited' })
        }
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
      const passkey = passkeys && (await passkeys.has(emailOf(request)))
      reply
        .type('text/html')
        .send(renderPage(items, sessions, current.get(request)?.id, undefined, passkey))
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
      const full =
        !!word?.trim() &&
        !(normalizeWord(word) in items) &&
        Object.keys(items).length >= config.limits.maxItemsPerUser
      const error = !word?.trim()
        ? 'A trigger word is required.'
        : !stockcode
          ? 'Could not find a stockcode in that URL — paste a link like /shop/productdetails/123456/product-name, or the stockcode itself.'
          : full
            ? `You can have at most ${config.limits.maxItemsPerUser} items.`
            : undefined
      if (error || !word || !stockcode) {
        const status = error && full ? 409 : 400
        if (wantsJson(request)) {
          return reply.code(status).send({ error })
        }
        const sessions = await sessionsOf(request)
        return reply
          .code(status)
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
  passkey?: boolean,
): string {
  const rows = Object.entries(items)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([word, mapping]) => `
        <tr class="item">
          <td>
            <strong>${escapeHtml(word)}</strong>
            ${mapping.listing ? `<div class="listing">${escapeHtml(mapping.listing)}</div>` : ''}
          </td>
          <td>${mapping.stockcode}</td>
          <td>${mapping.quantity}</td>
        </tr>
        <tr class="item-edit">
          <td colspan="3">
            <details class="edit">
              <summary>Edit</summary>
              <form class="edit-panel" method="post" action="/admin/items/${encodeURIComponent(word)}/edit">
                <label class="grow">Trigger word
                  <input name="word" required value="${escapeHtml(word)}">
                </label>
                <label class="grow">Woolworths product URL or stockcode
                  <input name="url" required value="${mapping.stockcode}">
                </label>
                <label class="qty">Quantity
                  <input name="quantity" type="number" min="1" value="${mapping.quantity}">
                </label>
                <div class="actions">
                  <button type="submit">Save</button>
                  <button type="submit" class="danger" formaction="/admin/items/${encodeURIComponent(word)}/delete" formnovalidate>Remove</button>
                </div>
              </form>
            </details>
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
      <thead><tr><th>Phrase</th><th>Stockcode</th><th>Qty</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3">No items configured yet.</td></tr>'}</tbody>
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
  ${
    passkey === undefined
      ? ''
      : `<div class="card">
    <h2>Woolworths passkey</h2>
    <p class="hint">${passkey ? 'Registered. The server signs in to Woolworths with it when your session expires.' : 'Not registered. Register one from the Chrome extension.'}</p>
  </div>`
  }
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
