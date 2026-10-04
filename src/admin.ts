import formbody from '@fastify/formbody'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { PAGE_STYLES } from './admin-styles.ts'
import { UserRateLimiter } from './rate-limit.ts'
import { authenticate, logAuthFailure, requestPath, sessionCookie } from './auth.ts'
import type { AppConfig } from './config.ts'
import { applyEdit, parseStockcode } from './item-edit.ts'
import { renderHousehold, type HouseholdView } from './admin-household.ts'
import { InviteLimitError, type HouseholdStore } from './households.ts'
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
  households: HouseholdStore,
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
      if (requestPath(request) === '/login') {
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
        return reply.redirect('/login')
      }
      reply.code(401).send('Authentication required')
    })

    admin.get('/login', async (_request, reply) => {
      reply.type('text/html').send(renderLoginPage())
    })

    admin.post('/logout', async (request, reply) => {
      const token = current.get(request)?.token
      if (token) {
        await tokens.revoke(token)
      }
      reply.header('set-cookie', sessionCookie('', 0, secureCookie)).redirect('/login')
    })

    admin.post<{ Params: { id: string } }>('/sessions/:id/revoke', async (request, reply) => {
      if ((await sessionsOf(request)).some((session) => session.id === request.params.id)) {
        await tokens.revokeById(request.params.id)
      }
      if (wantsJson(request)) {
        return reply.code(204).send()
      }
      if (request.params.id === current.get(request)?.id) {
        reply.header('set-cookie', sessionCookie('', 0, secureCookie))
        return reply.redirect('/login')
      }
      return reply.redirect('/')
    })

    admin.get('/', async (request, reply) => {
      const items = await store.load(emailOf(request))
      void backfillOf(request)
      const sessions = await sessionsOf(request)
      const passkey = passkeys && (await passkeys.has(emailOf(request)))
      const members = await households.members(emailOf(request))
      reply.type('text/html').send(
        renderPage(items, sessions, current.get(request)?.id, undefined, passkey, undefined, {
          members,
          you: emailOf(request),
        }),
      )
    })

    // Members of the household the user's items, Woolworths session and passkey are shared with.
    admin.get('/household', async (request) => ({
      members: (await households.members(emailOf(request))).map((email) => ({
        email,
        you: email === emailOf(request),
      })),
    }))

    // Responds to a household action: JSON for API clients, else the web page
    // (with `notice` or `error` shown), which is also where an invite code appears.
    const householdPage = async (
      request: FastifyRequest,
      reply: FastifyReply,
      status: number,
      extra: { error?: string; invite?: { code: string; expiresAt: number } },
    ) => {
      const email = emailOf(request)
      const sessions = await sessionsOf(request)
      const passkey = passkeys && (await passkeys.has(email))
      return reply
        .code(status)
        .type('text/html')
        .send(
          renderPage(
            await store.load(email),
            sessions,
            current.get(request)?.id,
            extra.error,
            passkey,
            undefined,
            { members: await households.members(email), you: email, invite: extra.invite },
          ),
        )
    }

    admin.post('/household/invites', async (request, reply) => {
      try {
        const invite = await households.invite(emailOf(request))
        if (wantsJson(request)) {
          return reply.code(201).send(invite)
        }
        return householdPage(request, reply, 201, { invite })
      } catch (error) {
        if (!(error instanceof InviteLimitError)) {
          throw error
        }
        const message = `Your household can have at most ${config.limits.maxInvitesPerHousehold} unexpired invites.`
        return wantsJson(request)
          ? reply.code(409).send({ error: message })
          : householdPage(request, reply, 409, { error: message })
      }
    })

    admin.post<{ Body: { code?: string } | null }>('/household/join', async (request, reply) => {
      const code = request.body?.code
      const result =
        typeof code === 'string' && code.trim()
          ? await households.join(emailOf(request), code)
          : 'invalid_invite'
      if (result === 'joined') {
        return wantsJson(request) ? reply.code(204).send() : reply.redirect('/')
      }
      const [status, error] =
        result === 'already_member'
          ? [409, 'You are already in that household.']
          : [400, 'That invite code is invalid, expired or already used.']
      return wantsJson(request)
        ? reply.code(status).send({ error })
        : householdPage(request, reply, status, { error })
    })

    admin.post('/household/leave', async (request, reply) => {
      const result = await households.leave(emailOf(request))
      if (result === 'left') {
        return wantsJson(request) ? reply.code(204).send() : reply.redirect('/')
      }
      const error = 'You are the only member of your household, so there is nothing to leave.'
      return wantsJson(request)
        ? reply.code(409).send({ error })
        : householdPage(request, reply, 409, { error })
    })

    admin.get('/items', async (request) => {
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
    }>('/items', async (request, reply) => {
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
      return reply.redirect('/')
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
      return reply.redirect('/')
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
          .send(
            renderPage(items, sessions, current.get(request)?.id, result.error, undefined, {
              word: normalizeWord(request.params.word),
              values: request.body ?? {},
            }),
          )
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
      return reply.redirect('/')
    }
    admin.patch<{ Params: { word: string }; Body: Record<string, unknown> | null }>(
      '/items/:word',
      editItem,
    )
    admin.post<{ Params: { word: string }; Body: Record<string, unknown> | null }>(
      '/items/:word/edit',
      editItem,
    )
    admin.post<{ Params: { word: string } }>('/items/:word/delete', removeItem)
    admin.delete<{ Params: { word: string } }>('/items/:word', removeItem)
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
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
    <h1>Personal Shopper</h1>
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
  edit?: { word: string; values: Record<string, unknown> },
  household?: HouseholdView,
): string {
  const rows = Object.entries(items)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([word, mapping], index) => {
      const path = `/items/${encodeURIComponent(word)}`
      const editing = edit?.word === word
      const field = (name: string, fallback: string | number): string => {
        const value = editing ? edit.values[name] : undefined
        return escapeHtml(typeof value === 'string' ? value : String(fallback))
      }
      const id = `edit-${index}`
      return `
        <form class="item" method="post" action="${path}/edit">
          <input type="checkbox" class="edit-toggle" id="${id}" aria-label="Edit ${escapeHtml(word)}"${editing ? ' checked' : ''}>
          <div class="cell phrase">
            <strong class="view">${escapeHtml(word)}</strong>
            <label class="edit"><span class="field-name">Trigger word</span>
              <input aria-label="Trigger word" name="word" required value="${field('word', word)}">
            </label>
            ${mapping.listing ? `<div class="listing">${escapeHtml(mapping.listing)}</div>` : ''}
          </div>
          <div class="cell product">
            <span class="view"><span class="view-name">Stockcode</span>${mapping.stockcode}</span>
            <label class="edit"><span class="field-name">Woolworths product URL or stockcode</span>
              <input aria-label="Woolworths product URL or stockcode" name="url" required value="${field('url', mapping.stockcode)}">
            </label>
          </div>
          <div class="cell qty">
            <span class="view"><span class="view-name">Quantity</span>${mapping.quantity}</span>
            <label class="edit"><span class="field-name">Quantity</span>
              <input aria-label="Quantity" name="quantity" type="number" min="1" value="${field('quantity', mapping.quantity)}">
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

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>personal-shopper — items</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="top-bar">
    <h1>Shopping list items</h1>
    <form method="post" action="/logout">
      <button type="submit" class="logout">Sign out</button>
    </form>
  </div>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <div class="card">
    <div class="items">
      <div class="item-head" aria-hidden="true"><span>Phrase</span><span>Product</span><span>Qty</span><span></span></div>
      ${rows || '<p class="hint">No items configured yet.</p>'}
    </div>
  </div>
  <div class="card">
    <h2>Add an item</h2>
    <p class="hint">Find the product on woolworths.com.au and paste its URL below.</p>
    <form class="add" method="post" action="/items">
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
  ${household ? renderHousehold(household) : ''}
  <div class="card">
    <h2>Signed-in sessions</h2>
    <table class="sessions">
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
