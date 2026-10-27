import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { authenticate, logAuthFailure } from './auth.ts'
import { UserRateLimiter } from './rate-limit.ts'
import type { AppConfig } from './config.ts'
import type { TokenStore } from './tokens.ts'
import {
  InvalidPickupLinkError,
  PickupUpstreamError,
  type PickupNotifier,
} from './woolworths/pickup.ts'

interface PickupBody {
  link?: unknown
  latitude?: unknown
  longitude?: unknown
}

/**
 * Registers `POST /pickup/en-route` and `POST /pickup/arrived`, which tell
 * Woolworths the user is on their way to, or has parked for, a Direct to boot
 * order. The body carries the link from Woolworths' ready-order message.
 * Authorised by a bearer token only, never the web session cookie. Links and
 * coordinates are never logged.
 */
export async function registerPickup(
  app: FastifyInstance,
  config: AppConfig,
  tokens: TokenStore,
  pickup: PickupNotifier,
  now: () => number = Date.now,
): Promise<void> {
  await app.register(async (routes) => {
    const userLimiter = new UserRateLimiter(config.limits.userRequestsPerMinute, now)

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
    })

    const rateLimit = { max: config.limits.ipRequestsPerMinute, timeWindow: '1 minute' }

    routes.post<{ Body: PickupBody | undefined }>(
      '/pickup/en-route',
      { config: { rateLimit } },
      async (request, reply) => {
        const { link, latitude, longitude } = request.body ?? {}
        if (typeof link !== 'string' || link === '') {
          return reply.code(400).send({ error: 'link is required' })
        }
        if (!inRange(latitude, 90) || !inRange(longitude, 180)) {
          return reply.code(400).send({ error: 'latitude and longitude are required' })
        }
        return notify(request, reply, 'en route', () => pickup.enRoute(link, latitude, longitude))
      },
    )

    routes.post<{ Body: PickupBody | undefined }>(
      '/pickup/arrived',
      { config: { rateLimit } },
      async (request, reply) => {
        const link = request.body?.link
        if (typeof link !== 'string' || link === '') {
          return reply.code(400).send({ error: 'link is required' })
        }
        return notify(request, reply, 'arrived', () => pickup.arrived(link))
      },
    )
  })
}

function inRange(value: unknown, limit: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit
}

async function notify(
  request: FastifyRequest,
  reply: FastifyReply,
  action: string,
  run: () => Promise<unknown>,
): Promise<unknown> {
  try {
    const status = await run()
    request.log.info(`pickup ${action}`)
    return status
  } catch (error) {
    if (error instanceof InvalidPickupLinkError) {
      request.log.warn(`pickup link rejected (${action})`)
      return reply.code(422).send({ error: error.message })
    }
    if (error instanceof PickupUpstreamError) {
      request.log.warn(`woolworths pickup failed (${action})`)
      return reply.code(502).send({ error: error.message })
    }
    throw error
  }
}
