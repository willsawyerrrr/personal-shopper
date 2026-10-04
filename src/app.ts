import type { Writable } from 'node:stream'
import rateLimit from '@fastify/rate-limit'
import Fastify, { LogController, type FastifyInstance } from 'fastify'
import { registerAdmin } from './admin.ts'
import { requestPath } from './auth.ts'
import { registerCart } from './cart.ts'
import type { AppConfig } from './config.ts'
import type { Sql } from './db.ts'
import { GoogleOAuth } from './google.ts'
import { ItemStore } from './items.ts'
import { registerLogin } from './login.ts'
import { registerPasskey, type PasskeyOptions } from './passkey.ts'
import { TokenStore } from './tokens.ts'
import type { CartClient, ProductLookup } from './woolworths/client.ts'

declare module 'fastify' {
  interface FastifyInstance {
    /** The store of bearer tokens and admin sessions, which also tells who the users are. */
    tokens: TokenStore
  }
}

const HEALTH_CHECK_PATH = '/healthz'

export interface AppOptions {
  /** The database holding users, tokens and each user's data. */
  sql: Sql
  /** Replaces stdout as the log destination (used by tests). */
  logStream?: Writable
  /** Replaces the global `fetch` for calls to Google (used by tests). */
  fetch?: typeof fetch
  /** Replaces the clock (used by tests). */
  now?: () => number
  /** Resolves a user's cart; enables `POST /cart/items`, which does not exist without it. */
  cart?: (email: string) => CartClient
  /** Resolves a user's product lookup for listing text; without it items are stored without one. */
  lookup?: (email: string) => ProductLookup
  /** Enables `/woolworths/passkey` and the admin page's passkey status; neither exists without it. */
  passkeys?: PasskeyOptions
}

export function buildApp(config: AppConfig, options: AppOptions): FastifyInstance {
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

  const tokens = new TokenStore(options.sql, now)
  const items = new ItemStore(options.sql)
  app.decorate('tokens', tokens)
  const google = new GoogleOAuth({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: `${config.publicBaseUrl}/auth/google/callback`,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    now,
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
  // the sign-in routes are throttled per client IP.
  void app.register(rateLimit, { global: false })

  // Registered as plugins so they load after the rate limiter and pick up
  // its per-route config.
  void app.register(async (routes) => {
    routes.get('/healthz', async () => ({ status: 'ok' }))
  })

  void registerLogin(app, { config, tokens, google, now })
  void registerAdmin(app, config, tokens, items, options.lookup, options.passkeys?.credentials)
  if (options.cart) {
    void registerCart(app, config, tokens, items, options.cart)
  }

  if (options.passkeys) {
    void registerPasskey(app, config, tokens, options.passkeys)
  }

  return app
}
