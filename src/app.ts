import Fastify, { type FastifyInstance } from 'fastify'
import { registerAdmin } from './admin.ts'
import type { AppConfig } from './config.ts'
import { loadItems, resolveItem } from './items.ts'
import type { CartClient } from './woolworths/client.ts'

export function buildApp(config: AppConfig, cart: CartClient): FastifyInstance {
  const app = Fastify({ logger: true })

  app.post<{ Body: { item: string } }>('/items', {
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

  void registerAdmin(app, config)

  return app
}
