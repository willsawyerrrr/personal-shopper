import rateLimit from '@fastify/rate-limit'
import Fastify, { type FastifyInstance } from 'fastify'
import { registerAdmin } from './admin.ts'
import type { AppConfig } from './config.ts'
import { loadItems, resolveItem } from './items.ts'
import type { CartClient } from './woolworths/client.ts'

const WEBHOOK_RATE_LIMIT_MAX = 30

export function buildApp(config: AppConfig, cart: CartClient): FastifyInstance {
  const app = Fastify({ logger: true, trustProxy: config.trustProxy })

  // Routes opt in via `config.rateLimit`; the app is internet-reachable, so
  // the two that accept the shared secret are throttled per client IP.
  void app.register(rateLimit, { global: false })

  // Registered as plugins so they load after the rate limiter and pick up
  // its per-route config.
  void app.register(async (routes) => {
    routes.get('/healthz', async () => ({ status: 'ok' }))

    routes.post<{ Body: { item: string } }>('/items', {
      config: { rateLimit: { max: WEBHOOK_RATE_LIMIT_MAX, timeWindow: '1 minute' } },
      preHandler: async (request, reply) => {
        if (request.headers.authorization !== `Bearer ${config.sharedSecret}`) {
          return reply.code(401).send({ error: 'unauthorized' })
        }
      },
      handler: async (request, reply) => {
        const { item } = request.body
        const items = await loadItems(config.itemsPath)
        const mapping = resolveItem(items, item)
        if (!mapping) {
          return reply.code(404).send({ error: `no mapping configured for "${item}"` })
        }
        await cart.addToCart(mapping.stockcode, mapping.quantity)
        return reply.send({ item, stockcode: mapping.stockcode, quantity: mapping.quantity })
      },
    })
  })

  void registerAdmin(app, config)

  return app
}
