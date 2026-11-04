import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate, logAuthFailure } from './auth.ts'
import type { CartStore } from './cart-store.ts'
import { UserRateLimiter } from './rate-limit.ts'
import type { AppConfig } from './config.ts'
import { resolveItem, type ItemStore } from './items.ts'
import type { TokenStore } from './tokens.ts'

/**
 * Registers `POST /cart/items`, which adds one of the item mapped to a spoken
 * phrase to the Personal Shopper cart of the user the bearer token belongs to,
 * using that user's items. Products are chosen, and Woolworths contacted, only
 * at checkout. The response is `{item, stockcode, quantity, count}`: `count` is
 * the item's new count in the cart, and `stockcode` and `quantity` are the
 * item's first candidate's, which clients that predate the cart read as what was
 * added. Authorised by a bearer token only, never the web session cookie.
 */
export async function registerCart(
  app: FastifyInstance,
  config: AppConfig,
  tokens: TokenStore,
  store: ItemStore,
  cart: CartStore,
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
        const first = resolved?.candidates[0]
        const count = resolved && first && (await cart.add(email, resolved.id))
        if (!first || !count) {
          return reply.code(404).send({ error: `no mapping configured for "${item}"` })
        }
        request.log.info({ itemId: resolved.id, count }, 'added to cart')
        return { item, stockcode: first.stockcode, quantity: first.quantity, count }
      },
    )
  })
}
