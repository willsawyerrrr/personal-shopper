import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.ts'
import { signInClient, signInWeb, testConfig } from './testing/app.ts'
import { createTestDb } from './testing/db.ts'
import { FakeGoogle } from './testing/google.ts'
import {
  InvalidPickupLinkError,
  PickupUpstreamError,
  type PickupNotifier,
} from './woolworths/pickup.ts'

const LINK =
  'https://myorder.woolworths.com.au/pickup/order?token=11111111-2222-3333-4444-555555555555'
const STATUS = {
  statusTitle: "We're on our way",
  statusDescription: 'Head to the pickup area',
  collectionMethod: 'DriveUp',
}

describe('pickup routes', () => {
  let dir: string
  let db: Awaited<ReturnType<typeof createTestDb>>
  let google: FakeGoogle
  let app: FastifyInstance
  let output: string
  let enRoute: ReturnType<typeof vi.fn<PickupNotifier['enRoute']>>
  let arrived: ReturnType<typeof vi.fn<PickupNotifier['arrived']>>
  let bearer: { authorization: string }

  const post = (url: string, payload: unknown, headers: Record<string, string> = bearer) =>
    app.inject({ method: 'POST', url, payload: payload as object, headers })
  const lines = () =>
    output
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)

  beforeEach(async () => {
    output = ''
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-pickup-'))
    db = await createTestDb()
    google = await FakeGoogle.create()
    enRoute = vi.fn<PickupNotifier['enRoute']>().mockResolvedValue(STATUS)
    arrived = vi.fn<PickupNotifier['arrived']>().mockResolvedValue(STATUS)
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output += chunk.toString()
        callback()
      },
    })
    app = buildApp(testConfig(dir, { logLevel: 'info' }), {
      sql: db.sql,
      logStream,
      fetch: google.fetch,
      pickup: { enRoute, arrived },
    })
    bearer = { authorization: `Bearer ${await signInClient(app, google)}` }
    output = ''
  })

  afterEach(async () => {
    await rm(dir, { recursive: true })
    await db.close()
  })

  it('tells Woolworths the user is on their way', async () => {
    const response = await post('/pickup/en-route', {
      link: LINK,
      latitude: -33.8688,
      longitude: 151.2093,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(STATUS)
    expect(enRoute).toHaveBeenCalledWith(LINK, -33.8688, 151.2093)
  })

  it('tells Woolworths the user has parked', async () => {
    const response = await post('/pickup/arrived', { link: LINK })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual(STATUS)
    expect(arrived).toHaveBeenCalledWith(LINK)
  })

  it('logs without the link, coordinates or token', async () => {
    await post('/pickup/en-route', { link: LINK, latitude: -33.8688, longitude: 151.2093 })
    expect(lines().find((line) => line.msg === 'pickup en route')).toBeDefined()
    expect(output).not.toContain('11111111')
    expect(output).not.toContain('33.8688')
    expect(output).not.toContain(bearer.authorization.slice('Bearer '.length))
  })

  it.each([undefined, {}, { link: '' }, { link: 5 }])(
    'answers a missing link (%j) with 400',
    async (payload) => {
      for (const url of ['/pickup/en-route', '/pickup/arrived']) {
        const response = await post(url, payload)
        expect(response.statusCode).toBe(400)
        expect(response.json()).toEqual({ error: 'link is required' })
      }
      expect(enRoute).not.toHaveBeenCalled()
      expect(arrived).not.toHaveBeenCalled()
    },
  )

  it.each([
    {},
    { latitude: '1', longitude: '2' },
    { latitude: 91, longitude: 0 },
    { latitude: 0, longitude: -181 },
    { latitude: null, longitude: 0 },
  ])('answers invalid coordinates (%j) with 400', async (coordinates) => {
    const response = await post('/pickup/en-route', { link: LINK, ...coordinates })
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'latitude and longitude are required' })
    expect(enRoute).not.toHaveBeenCalled()
  })

  it('answers an invalid or expired link with 422', async () => {
    arrived.mockRejectedValue(new InvalidPickupLinkError('pickup link is invalid or expired'))
    const response = await post('/pickup/arrived', { link: LINK })
    expect(response.statusCode).toBe(422)
    expect(response.json()).toEqual({ error: 'pickup link is invalid or expired' })
  })

  it('answers an upstream failure with 502', async () => {
    enRoute.mockRejectedValue(new PickupUpstreamError('Woolworths pickup request failed'))
    const response = await post('/pickup/en-route', { link: LINK, latitude: 1, longitude: 2 })
    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ error: 'Woolworths pickup request failed' })
  })

  it('answers other failures with 500', async () => {
    arrived.mockRejectedValue(new Error('boom'))
    expect((await post('/pickup/arrived', { link: LINK })).statusCode).toBe(500)
  })

  it('rejects a missing or invalid token with 401 and logs the reason', async () => {
    expect((await post('/pickup/arrived', { link: LINK }, {})).statusCode).toBe(401)
    expect(
      (await post('/pickup/arrived', { link: LINK }, { authorization: 'Bearer nope' })).statusCode,
    ).toBe(401)
    expect(lines().find((line) => line.msg === 'auth rejected')).toMatchObject({
      reason: 'missing_authorization',
      route: '/pickup/arrived',
    })
    expect(arrived).not.toHaveBeenCalled()
  })

  it('rejects the web session cookie', async () => {
    const cookie = await signInWeb(app, google)
    expect((await post('/pickup/arrived', { link: LINK }, { cookie })).statusCode).toBe(401)
    expect(arrived).not.toHaveBeenCalled()
  })

  it('is rate limited', async () => {
    for (let i = 0; i < 30; i++) {
      await post('/pickup/arrived', { link: LINK })
    }
    expect((await post('/pickup/arrived', { link: LINK })).statusCode).toBe(429)
  })
})
