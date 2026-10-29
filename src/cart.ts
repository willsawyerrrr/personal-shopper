import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate, logAuthFailure } from './auth.ts'
import { UserRateLimiter } from './rate-limit.ts'
import type { AppConfig } from './config.ts'
import { resolveItem, type Item, type ItemCandidate, type ItemStore } from './items.ts'
import type { TokenStore } from './tokens.ts'
import type { CartClient, PriceLookup } from './woolworths/client.ts'
import { SessionRejectedError } from './woolworths/session.ts'

/** A candidate together with its looked-up price, when known. */
interface PricedCandidate extends ItemCandidate {
  price?: number | undefined
}

// At least one candidate: every item added to the cart has at least one.
type Candidates<T extends ItemCandidate> = readonly [T, ...T[]]

/**
 * The cheapest-per-unit candidate among those with a known price, or the
 * first (in the item's stored order) when none do, so pricing trouble never
 * blocks a cart-add.
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

function candidatesOf(item: Item): Candidates<ItemCandidate> | undefined {
  const [first, ...rest] = item.candidates
  return first ? [first, ...rest] : undefined
}

// Resolves which candidate to add: the item's only one when it has no others, without looking
// up a price, so an item with a single candidate never pays for one. A candidate whose price
// lookup fails is logged and treated as unknown rather than failing the cart-add.
async function chooseCandidate(
  item: Item,
  client: Partial<PriceLookup>,
  log: Pick<FastifyRequest['log'], 'warn'>,
): Promise<ItemCandidate | undefined> {
  const candidates = candidatesOf(item)
  if (!candidates) {
    return undefined
  }
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
 * user's items. When the item has more than one candidate, the cheapest per
 * unit is added. Authorised by a bearer token only, never the web session
 * cookie.
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
        const resolved = resolveItem(await store.load(email), item)
        const client = cartFor(email)
        const chosen = resolved && (await chooseCandidate(resolved, client, request.log))
        if (!chosen) {
          return reply.code(404).send({ error: `no mapping configured for "${item}"` })
        }
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
