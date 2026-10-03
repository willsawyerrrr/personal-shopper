import type { Writable } from 'node:stream'
import rateLimit from '@fastify/rate-limit'
import Fastify, { LogController, type FastifyInstance } from 'fastify'
import { registerAdmin } from './admin.ts'
import { requestPath } from './auth.ts'
import { registerCart } from './cart.ts'
import type { AppConfig } from './config.ts'
import { GoogleOAuth } from './google.ts'
import { registerLogin } from './login.ts'
import { TokenStore } from './tokens.ts'
import type { CartClient, ProductLookup } from './woolworths/client.ts'

const HEALTH_CHECK_PATH = '/healthz'

export interface AppOptions {
  /** Replaces stdout as the log destination (used by tests). */
  logStream?: Writable
  /** Replaces the global `fetch` for calls to Google (used by tests). */
  fetch?: typeof fetch
  /** Replaces the clock (used by tests). */
  now?: () => number
  /** Enables `POST /cart/items`; without it the route does not exist. */
  cart?: CartClient
  /** Looks up listing text for items; without it items are stored without one. */
  lookup?: ProductLookup
}

export function buildApp(config: AppConfig, options: AppOptions = {}): FastifyInstance {
  const now = options.now ?? Date.now
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      ...(options.logStream ? { stream: options.logStream } : {}),
    },
    // Replaced by the single `request completed` line below.
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: config.trustProxy,
  })

  const tokens = new TokenStore(config.tokenStorePath, now, (error) => app.log.error(error))
  const google = new GoogleOAuth({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: `${config.publicBaseUrl}/auth/google/callback`,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
  })

  // A corrupt token file fails startup instead of silently signing everyone out.
  app.addHook('onReady', () => tokens.load())
  // Lets a pending last-used write finish before the process exits.
  app.addHook('onClose', () => tokens.flush())

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
  // the sign-in routes are throttled per client IP.
  void app.register(rateLimit, { global: false })

  // Registered as plugins so they load after the rate limiter and pick up
  // its per-route config.
  void app.register(async (routes) => {
    routes.get('/healthz', async () => ({ status: 'ok' }))
  })

  void registerLogin(app, { config, tokens, google, now })
  void registerAdmin(app, config, tokens, options.lookup)
  if (options.cart) {
    void registerCart(app, config, tokens, options.cart)
  }

  return app
}
