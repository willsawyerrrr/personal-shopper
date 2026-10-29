import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate, logAuthFailure } from './auth.ts'
import { UserRateLimiter } from './rate-limit.ts'
import type { AppConfig } from './config.ts'
import { resolveItem, type ItemCandidate, type ItemMapping, type ItemStore } from './items.ts'
import type { TokenStore } from './tokens.ts'
import type { CartClient, PriceLookup } from './woolworths/client.ts'
import { SessionRejectedError } from './woolworths/session.ts'

/** A candidate together with its looked-up price, when known. */
interface PricedCandidate extends ItemCandidate {
  price?: number | undefined
}

// At least one candidate: the mapping's own, optionally followed by its alternatives.
type Candidates<T extends ItemCandidate> = readonly [T, ...T[]]

/**
 * The cheapest-per-unit candidate among those with a known price, or the first
 * (the mapping's own stockcode/quantity) when none do, so pricing trouble
 * never blocks a cart-add.
 */
export function pickCheapest(candidates: Candidates<PricedCandidate>): ItemCandidate {
  let best: PricedCandidate | undefined
  for (const candidate of candidates) {
    if (candidate.price === undefined) {
      continue
    }
    const unitPrice = candidate.price / candidate.quantity
    if (!best || unitPrice < (best.price as number) / best.quantity) {
      best = candidate
    }
  }
  return best ?? candidates[0]
}

// The mapping's own stockcode/quantity, then its alternatives, in that order so `pickCheapest`
// can fall back to index 0.
function candidatesOf(mapping: ItemMapping): Candidates<ItemCandidate> {
  return [
    { stockcode: mapping.stockcode, quantity: mapping.quantity },
    ...(mapping.alternatives ?? []),
  ]
}

// Resolves which candidate to add: the mapping's own when it has no alternatives, without
// looking up a price, so an item with no alternatives never pays for one. A candidate whose
// price lookup fails is logged and treated as unknown rather than failing the cart-add.
async function chooseCandidate(
  mapping: ItemMapping,
  client: Partial<PriceLookup>,
  log: Pick<FastifyRequest['log'], 'warn'>,
): Promise<ItemCandidate> {
  const candidates = candidatesOf(mapping)
  if (candidates.length === 1) {
    return candidates[0]
  }
  const [priced0, ...pricedRest] = await Promise.all(
    candidates.map(async (candidate): Promise<PricedCandidate> => {
      try {
        return { ...candidate, price: await client.price?.(candidate.stockcode) }
      } catch (error) {
        log.warn({ stockcode: candidate.stockcode, error }, 'price lookup failed')
        return candidate
      }
    }),
  )
  return pickCheapest([priced0 as PricedCandidate, ...pricedRest])
}

/**
 * Registers `POST /cart/items`, which adds the product mapped to a spoken
 * phrase to the cart of the user the bearer token belongs to, using that
 * user's items. When the mapping has alternatives, the cheapest per unit is
 * added instead of the mapping's own stockcode/quantity. Authorised by a
 * bearer token only, never the web session cookie.
 */
export async function registerCart(
  app: FastifyInstance,
  config: AppConfig,
  tokens: TokenStore,
  store: ItemStore,
  cartFor: (email: string) => CartClient & Partial<PriceLookup>,
  now: () => number = Date.now,
): Promise<void> {
  await app.register(async (routes) => {
    const userLimiter = new UserRateLimiter(config.limits.userRequestsPerMinute, now)
    const emails = new WeakMap<FastifyRequest, string>()

    routes.addHook('onRequest', async (request, reply) => {
      const result = await authenticate(request, tokens, false)
      if (!result.ok) {
        logAuthFailure(request, result.failure)
        return reply.code(401).send({ error: 'unauthorized' })
      }
      const limit = userLimiter.hit(result.record.email)
      if (!limit.ok) {
        return reply
          .code(429)
          .header('retry-after', limit.retryAfterSeconds)
          .send({ error: 'rate_limited' })
      }
      emails.set(request, result.record.email)
    })

    routes.post<{ Body: { item?: unknown } | undefined }>(
      '/cart/items',
      { config: { rateLimit: { max: config.limits.ipRequestsPerMinute, timeWindow: '1 minute' } } },
      async (request, reply) => {
        const item = request.body?.item
        if (typeof item !== 'string' || item.trim() === '') {
          return reply.code(400).send({ error: 'item is required' })
        }
        const email = emails.get(request) as string
        const mapping = resolveItem(await store.load(email), item)
        if (!mapping) {
          return reply.code(404).send({ error: `no mapping configured for "${item}"` })
        }
        const client = cartFor(email)
        const chosen = await chooseCandidate(mapping, client, request.log)
        try {
          await client.addToCart(chosen.stockcode, chosen.quantity)
        } catch (error) {
          if (error instanceof SessionRejectedError) {
            request.log.warn({ stockcode: chosen.stockcode }, 'woolworths session rejected')
            return reply.code(502).send({ error: error.message })
          }
          throw error
        }
        request.log.info({ stockcode: chosen.stockcode }, 'added to cart')
        return { item, stockcode: chosen.stockcode, quantity: chosen.quantity }
      },
    )
  })
}
