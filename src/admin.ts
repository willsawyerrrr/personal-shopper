import { randomUUID } from 'node:crypto'
import formbody from '@fastify/formbody'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { PAGE_STYLES } from './admin-styles.ts'
import { UserRateLimiter } from './rate-limit.ts'
import { authenticate, logAuthFailure, requestPath, sessionCookie } from './auth.ts'
import type { AppConfig } from './config.ts'
import { applyEdit, parseCandidates, parseName, parseStockcode, parseWords } from './item-edit.ts'
import {
  alternativeRowsFromBody,
  alternativesFromBody,
  hasAlternativeFields,
} from './admin-items.ts'
import {
  renderAccountPage,
  renderAddItemPage,
  renderHouseholdPage,
  renderItemsPage,
} from './admin-pages.ts'
import { InviteLimitError, type HouseholdStore } from './households.ts'
import { normalizeWord, type Item, type ItemStore } from './items.ts'
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
      return { items }
    })

    admin.post<{
      Body: {
        word?: string
        words?: unknown
        url?: string
        quantity?: string | number
        name?: unknown
        alternatives?: unknown
      }
    }>('/items', async (request, reply) => {
      const { word, words: wordsField, url, quantity, name, alternatives } = request.body
      const items = await store.load(emailOf(request))
      const stockcode = parseStockcode(url ?? '')
      const candidates = parseCandidates(
        alternatives ?? alternativesFromBody(request.body as Record<string, unknown>),
      )
      // `words` (comma-separated or an array) lets a caller give an item more than one
      // trigger phrase up front; `word` stays as the single-word shorthand existing
      // clients (the iOS app, the extension) already send.
      const parsedWords =
        wordsField !== undefined
          ? (parseWords(wordsField) ?? [])
          : word?.trim()
            ? [normalizeWord(word)]
            : []
      const taken = parsedWords.find((candidateWord) =>
        items.some((item) => item.words.includes(candidateWord)),
      )
      const error = !parsedWords.length
        ? 'At least one trigger word is required.'
        : !stockcode
          ? 'Could not find a stockcode in that URL — paste a link like /shop/productdetails/123456/product-name, or the stockcode itself.'
          : !candidates.ok
            ? candidates.error
            : taken
              ? `"${taken}" is already used by another item.`
              : undefined
      const named = parseName(name)
      const problem = error ?? (named.ok ? undefined : named.error)
      if (problem || !stockcode || !named.ok || !candidates.ok) {
        if (wantsJson(request)) {
          return reply.code(400).send({ error: problem })
        }
        const wordsValue =
          typeof wordsField === 'string'
            ? wordsField
            : Array.isArray(wordsField)
              ? wordsField.join(', ')
              : word
        return reply
          .code(400)
          .type('text/html')
          .send(
            renderAddItemPage(
              {
                words: wordsValue,
                url,
                quantity: quantity === undefined ? undefined : String(quantity),
                name: typeof name === 'string' ? name : undefined,
                alternatives: alternativeRowsFromBody(request.body as Record<string, unknown>),
              },
              problem,
            ),
          )
      }
      const listing = await lookupListing(lookupFor?.(emailOf(request)), stockcode, request.log)
      const mappedQuantity = Math.max(1, Number(quantity) || 1)
      const item: Item = {
        id: randomUUID(),
        words: parsedWords,
        candidates: [{ stockcode, quantity: mappedQuantity }, ...candidates.candidates],
        ...(listing ? { listing } : {}),
        ...(named.name ? { name: named.name } : {}),
      }
      items.push(item)
      await store.save(emailOf(request), items)
      if (wantsJson(request)) {
        return reply.code(201).send(item)
      }
      return reply.redirect('/')
    })

    const removeItem = async (
      request: FastifyRequest<{ Params: { id: string } }>,
      reply: FastifyReply,
    ) => {
      const items = await store.load(emailOf(request))
      const remaining = items.filter((item) => item.id !== request.params.id)
      const removed = remaining.length !== items.length
      if (removed) {
        await store.save(emailOf(request), remaining)
      }
      if (wantsJson(request)) {
        return removed ? reply.code(204).send() : reply.code(404).send({ error: 'No such item.' })
      }
      return reply.redirect('/')
    }

    const editItem = async (
      request: FastifyRequest<{ Params: { id: string }; Body: Record<string, unknown> | null }>,
      reply: FastifyReply,
    ) => {
      const email = emailOf(request)
      const items = await store.load(email)
      const fields = { ...(request.body ?? {}) }
      if (hasAlternativeFields(fields)) {
        fields.alternatives = alternativesFromBody(fields)
      }
      const result = applyEdit(items, request.params.id, fields)
      if (!result.ok) {
        if (wantsJson(request)) {
          return reply.code(result.status).send({ error: result.error })
        }
        return reply
          .code(result.status)
          .type('text/html')
          .send(renderItemsPage(items, { key: request.params.id, values: fields }, result.error))
      }
      if (result.stockcodeChanged) {
        const listing = await lookupListing(
          lookupFor?.(email),
          result.item.candidates[0]?.stockcode as number,
          request.log,
        )
        if (listing) {
          result.item.listing = listing
        }
      }
      await store.save(email, result.items)
      if (wantsJson(request)) {
        return reply.send(result.item)
      }
      return reply.redirect('/')
    }

    const itemParams = {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    }
    type ItemRoute = { Params: { id: string } }
    type ItemEditRoute = ItemRoute & { Body: Record<string, unknown> | null }
    admin.patch<ItemEditRoute>('/items/:id', itemParams, editItem)
    admin.post<ItemEditRoute>('/items/:id/edit', itemParams, editItem)
    admin.post<ItemRoute>('/items/:id/delete', itemParams, removeItem)
    admin.delete<ItemRoute>('/items/:id', itemParams, removeItem)
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
