import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate, logAuthFailure } from './auth.ts'
import type { AppConfig } from './config.ts'
import { resolveItem, type ItemStore } from './items.ts'
import type { TokenStore } from './tokens.ts'
import type { CartClient } from './woolworths/client.ts'
import { SessionRejectedError } from './woolworths/session.ts'

const CART_RATE_LIMIT_MAX = 30

/**
 * Registers `POST /cart/items`, which adds the product mapped to a spoken
 * phrase to the cart of the user the bearer token belongs to, using that
 * user's items. Authorised by a bearer token only, never the web session
 * cookie.
 */
export async function registerCart(
  app: FastifyInstance,
  config: AppConfig,
  tokens: TokenStore,
  store: ItemStore,
  cartFor: (email: string) => CartClient,
): Promise<void> {
  await app.register(async (routes) => {
    const emails = new WeakMap<FastifyRequest, string>()

    routes.addHook('onRequest', async (request, reply) => {
      const result = await authenticate(request, tokens, config.allowedEmails, false)
      if (!result.ok) {
        logAuthFailure(request, result.failure)
        return reply.code(401).send({ error: 'unauthorized' })
      }
      emails.set(request, result.record.email)
    })

    routes.post<{ Body: { item?: unknown } | undefined }>(
      '/cart/items',
      { config: { rateLimit: { max: CART_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
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
        try {
          await cartFor(email).addToCart(mapping.stockcode, mapping.quantity)
        } catch (error) {
          if (error instanceof SessionRejectedError) {
            request.log.warn({ stockcode: mapping.stockcode }, 'woolworths session rejected')
            return reply.code(502).send({ error: error.message })
          }
          throw error
        }
        request.log.info({ stockcode: mapping.stockcode }, 'added to cart')
        return { item, stockcode: mapping.stockcode, quantity: mapping.quantity }
      },
    )
  })
}
