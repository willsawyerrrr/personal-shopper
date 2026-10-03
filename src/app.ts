import { Writable } from 'node:stream'
import rateLimit from '@fastify/rate-limit'
import Fastify, { LogController, type FastifyInstance } from 'fastify'
import { registerAdmin } from './admin.ts'
import { logAuthFailure, requestPath, verifyBearer } from './auth.ts'
import type { AppConfig } from './config.ts'
import { loadItems, resolveItem } from './items.ts'
import type { CartClient } from './woolworths/client.ts'

const WEBHOOK_RATE_LIMIT_MAX = 30

const HEALTH_CHECK_PATH = '/healthz'

/** `logStream` replaces stdout as the log destination (used by tests). */
export function buildApp(
  config: AppConfig,
  cart: CartClient,
  logStream?: Writable,
): FastifyInstance {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      ...(logStream ? { stream: logStream } : {}),
    },
    // Replaced by the single `request completed` line below.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy,
  })

  app.addHook('onResponse', async (request, reply) => {
    const path = requestPath(request)
    // Fly polls the health check constantly; keep it out of the default logs.
    const level = path === HEALTH_CHECK_PATH ? 'debug' : 'info'
    request.log[level](
      {
        method: request.method,
        url: path,
        statusCode: reply.statusCode,
        responseTime: Math.round(reply.elapsedTime),
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      },
      'request completed',
    )
  })

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
        const failure = verifyBearer(request.headers.authorization, config.sharedSecret)
        if (failure) {
          logAuthFailure(request, failure, config.sharedSecret)
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
