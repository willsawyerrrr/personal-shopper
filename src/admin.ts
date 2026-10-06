import formbody from '@fastify/formbody'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { PAGE_STYLES } from './admin-styles.ts'
import { UserRateLimiter } from './rate-limit.ts'
import { authenticate, logAuthFailure, requestPath, sessionCookie } from './auth.ts'
import type { AppConfig } from './config.ts'
import { applyEdit, parseStockcode } from './item-edit.ts'
import { applyGroupEdit, groupKey, removeGroup } from './products.ts'
import {
  renderAccountPage,
  renderAddItemPage,
  renderHouseholdPage,
  renderItemsPage,
} from './admin-pages.ts'
import { InviteLimitError, type HouseholdStore } from './households.ts'
import { normalizeWord, type ItemMapping, type ItemStore } from './items.ts'
import { createListingBackfill, lookupListing } from './listings.ts'
import { PASSKEY_RATE_LIMIT, removePasskey, type PasskeyOptions } from './passkey.ts'
import type { SessionSummary, TokenStore } from './tokens.ts'
import type { ProductLookup } from './woolworths/client.ts'

export async function registerAdmin(
  app: FastifyInstance,
  config: AppConfig,
  tokens: TokenStore,
  store: ItemStore,
  households: HouseholdStore,
  lookupFor?: (email: string) => ProductLookup,
  passkeys?: PasskeyOptions,
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
      return reply.redirect('/account')
    })

    admin.get('/', async (request, reply) => {
      const items = await store.load(emailOf(request))
      void backfillOf(request)
      reply.type('text/html').send(renderItemsPage(items))
    })

    admin.get('/items/new', async (_request, reply) => {
      reply.type('text/html').send(renderAddItemPage())
    })

    admin.get('/account', async (request, reply) => {
      const email = emailOf(request)
      const { passkey } = request.query as { passkey?: string }
      reply
        .type('text/html')
        .send(
          renderAccountPage(
            await sessionsOf(request),
            current.get(request)?.id,
            passkeys && (await passkeys.credentials.has(email)),
            passkey === 'removed' ? 'Passkey removed.' : undefined,
          ),
        )
    })

    if (passkeys) {
      const options = passkeys
      admin.post(
        '/account/passkey/remove',
        { config: { rateLimit: PASSKEY_RATE_LIMIT } },
        async (request, reply) => {
          await removePasskey(emailOf(request), options)
          request.log.info('woolworths passkey removed')
          return reply.redirect('/account?passkey=removed')
        },
      )
    }

    // The household web page lives at `/household/manage`: `GET /household` is the JSON member list.
    admin.get('/household/manage', async (request, reply) => {
      reply.type('text/html').send(await householdPage(request, {}))
    })

    // Members of the household the user's items, Woolworths session and passkey are shared with.
    admin.get('/household', async (request) => ({
      members: (await households.members(emailOf(request))).map((email) => ({
        email,
        you: email === emailOf(request),
      })),
    }))

    const householdPage = async (
      request: FastifyRequest,
      extra: { error?: string; invite?: { code: string; expiresAt: number } },
    ): Promise<string> => {
      const email = emailOf(request)
      return renderHouseholdPage(
        { members: await households.members(email), you: email, invite: extra.invite },
        extra.error,
      )
    }

    // Responds to a household action from the web page: the page, with `error` or the new
    // invite code shown.
    const householdReply = async (
      request: FastifyRequest,
      reply: FastifyReply,
      status: number,
      extra: { error?: string; invite?: { code: string; expiresAt: number } },
    ) =>
      reply
        .code(status)
        .type('text/html')
        .send(await householdPage(request, extra))

    admin.post('/household/invites', async (request, reply) => {
      try {
        const invite = await households.invite(emailOf(request))
        if (wantsJson(request)) {
          return reply.code(201).send(invite)
        }
        return householdReply(request, reply, 201, { invite })
      } catch (error) {
        if (!(error instanceof InviteLimitError)) {
          throw error
        }
        const message = `Your household can have at most ${config.limits.maxInvitesPerHousehold} unexpired invites.`
        return wantsJson(request)
          ? reply.code(409).send({ error: message })
          : householdReply(request, reply, 409, { error: message })
      }
    })

    admin.post<{ Body: { code?: string } | null }>('/household/join', async (request, reply) => {
      const code = request.body?.code
      const result =
        typeof code === 'string' && code.trim()
          ? await households.join(emailOf(request), code)
          : 'invalid_invite'
      if (result === 'joined') {
        return wantsJson(request) ? reply.code(204).send() : reply.redirect('/household/manage')
      }
      const [status, error] =
        result === 'already_member'
          ? [409, 'You are already in that household.']
          : [400, 'That invite code is invalid, expired or already used.']
      return wantsJson(request)
        ? reply.code(status).send({ error })
        : householdReply(request, reply, status, { error })
    })

    admin.post('/household/leave', async (request, reply) => {
      const result = await households.leave(emailOf(request))
      if (result === 'left') {
        return wantsJson(request) ? reply.code(204).send() : reply.redirect('/household/manage')
      }
      const error = 'You are the only member of your household, so there is nothing to leave.'
      return wantsJson(request)
        ? reply.code(409).send({ error })
        : householdReply(request, reply, 409, { error })
    })

    admin.get('/items', async (request) => {
      const items = await store.load(emailOf(request))
      void backfillOf(request)
      return {
        items: Object.entries(items).map(([word, mapping]) => ({ word, ...mapping })),
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
        return reply
          .code(400)
          .type('text/html')
          .send(
            renderAddItemPage(
              { word, url, quantity: quantity === undefined ? undefined : String(quantity) },
              error,
            ),
          )
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
        return reply.code(result.status).send({ error: result.error })
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
      return reply.send({ word: result.word, ...result.items[result.word] })
    }
    admin.patch<{ Params: { word: string }; Body: Record<string, unknown> | null }>(
      '/items/:word',
      editItem,
    )
    admin.post<{ Params: { word: string } }>('/items/:word/delete', removeItem)
    admin.delete<{ Params: { word: string } }>('/items/:word', removeItem)

    // A product is the group of items sharing a stockcode and quantity.
    type ProductRoute = { Params: { stockcode: string; quantity: string } }
    const productOf = (request: FastifyRequest<ProductRoute>): [number, number] => [
      Number(request.params.stockcode),
      Number(request.params.quantity),
    ]
    const editProduct = async (
      request: FastifyRequest<ProductRoute & { Body: Record<string, unknown> | null }>,
      reply: FastifyReply,
    ) => {
      const [stockcode, quantity] = productOf(request)
      const email = emailOf(request)
      const items = await store.load(email)
      const fields = request.body ?? {}
      const result = applyGroupEdit(items, stockcode, quantity, fields)
      if (!result.ok) {
        if (wantsJson(request)) {
          return reply.code(result.status).send({ error: result.error })
        }
        return reply
          .code(result.status)
          .type('text/html')
          .send(
            renderItemsPage(
              items,
              { key: groupKey({ stockcode, quantity }), values: fields },
              result.error,
            ),
          )
      }
      if (result.stockcodeChanged) {
        const listing = await lookupListing(lookupFor?.(email), result.group.stockcode, request.log)
        if (listing) {
          for (const word of result.group.words) {
            ;(result.items[word] as ItemMapping).listing = listing
          }
          result.group.listing = listing
        }
      }
      await store.save(email, result.items)
      if (wantsJson(request)) {
        return reply.send(result.group)
      }
      return reply.redirect('/')
    }
    const removeProduct = async (request: FastifyRequest<ProductRoute>, reply: FastifyReply) => {
      const [stockcode, quantity] = productOf(request)
      const remaining = removeGroup(await store.load(emailOf(request)), stockcode, quantity)
      if (remaining) {
        await store.save(emailOf(request), remaining)
      }
      if (wantsJson(request)) {
        return remaining ? reply.code(204).send() : reply.code(404).send({ error: 'No such item.' })
      }
      return reply.redirect('/')
    }
    const productParams = {
      schema: {
        params: {
          type: 'object',
          properties: {
            stockcode: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
            quantity: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' },
          },
        },
      },
    }
    type ProductEdit = ProductRoute & { Body: Record<string, unknown> | null }
    admin.patch<ProductEdit>('/products/:stockcode/:quantity', productParams, editProduct)
    admin.post<ProductEdit>('/products/:stockcode/:quantity/edit', productParams, editProduct)
    admin.post<ProductRoute>('/products/:stockcode/:quantity/delete', productParams, removeProduct)
    admin.delete<ProductRoute>('/products/:stockcode/:quantity', productParams, removeProduct)
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
  <h1>Personal Shopper</h1>
  <a class="button" href="/auth/google/login">Sign in with Google</a>
</body>
</html>`
}
