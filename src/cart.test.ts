import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.ts'
import { seedItems, signInClient, signInWeb, testConfig } from './testing/app.ts'
import { createTestDb } from './testing/db.ts'
import { FakeGoogle } from './testing/google.ts'
import type { CartClient } from './woolworths/client.ts'
import { SESSION_EXPIRED_MESSAGE, SessionRejectedError } from './woolworths/session.ts'

describe('POST /cart/items', () => {
  let dir: string
  let db: Awaited<ReturnType<typeof createTestDb>>
  let google: FakeGoogle
  let app: FastifyInstance
  let output: string
  let addToCart: ReturnType<typeof vi.fn<CartClient['addToCart']>>
  let cartFor: ReturnType<typeof vi.fn<(email: string) => CartClient>>
  let bearer: { authorization: string }

  const post = (payload: unknown, headers: Record<string, string> = bearer) =>
    app.inject({ method: 'POST', url: '/cart/items', payload: payload as object, headers })
  const lines = () =>
    output
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)

  beforeEach(async () => {
    output = ''
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-cart-'))
    db = await createTestDb()
    const config = testConfig(dir, {
      logLevel: 'info',
      allowedEmails: ['me@example.com', 'you@example.com'],
    })
    await seedItems(db.sql, 'milk:\n  stockcode: 123456\n  quantity: 2\n')
    google = await FakeGoogle.create()
    addToCart = vi.fn<CartClient['addToCart']>().mockResolvedValue(undefined)
    cartFor = vi.fn((_email: string) => ({ addToCart }))
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output += chunk.toString()
        callback()
      },
    })
    app = buildApp(config, {
      sql: db.sql,
      logStream,
      fetch: google.fetch,
      cart: cartFor,
    })
    bearer = { authorization: `Bearer ${await signInClient(app, google)}` }
    output = ''
  })

  afterEach(async () => {
    await rm(dir, { recursive: true })
    await db.close()
  })

  it('adds the mapped product to the cart', async () => {
    const response = await post({ item: '  Milk ' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ item: '  Milk ', stockcode: 123456, quantity: 2 })
    expect(addToCart).toHaveBeenCalledWith(123456, 2)
  })

  it("uses the signed-in user's own items and Woolworths account", async () => {
    await seedItems(db.sql, 'milk:\n  stockcode: 777\n  quantity: 4\n', 'you@example.com')
    const other = {
      authorization: `Bearer ${await signInClient(app, google, { overrides: { email: 'you@example.com' } })}`,
    }
    const response = await post({ item: 'milk' }, other)
    expect(response.json()).toEqual({ item: 'milk', stockcode: 777, quantity: 4 })
    expect(cartFor).toHaveBeenLastCalledWith('you@example.com')
    expect(addToCart).toHaveBeenLastCalledWith(777, 4)

    await post({ item: 'milk' })
    expect(cartFor).toHaveBeenLastCalledWith('me@example.com')
    expect(addToCart).toHaveBeenLastCalledWith(123456, 2)
  })

  it("does not fall back to another user's items", async () => {
    const other = {
      authorization: `Bearer ${await signInClient(app, google, { overrides: { email: 'you@example.com' } })}`,
    }
    expect((await post({ item: 'milk' }, other)).statusCode).toBe(404)
    expect(addToCart).not.toHaveBeenCalled()
  })

  it('logs the request and the resolved stockcode without the token', async () => {
    await post({ item: 'milk' })
    expect(lines().find((line) => line.msg === 'added to cart')).toMatchObject({
      stockcode: 123456,
    })
    expect(lines().find((line) => line.msg === 'request completed')).toMatchObject({
      method: 'POST',
      url: '/cart/items',
      statusCode: 200,
    })
    expect(output).not.toContain(bearer.authorization.slice('Bearer '.length))
  })

  it('answers an unmapped item with 404', async () => {
    const response = await post({ item: 'bread' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'no mapping configured for "bread"' })
    expect(addToCart).not.toHaveBeenCalled()
  })

  it.each([undefined, {}, { item: '' }, { item: '   ' }, { item: 5 }])(
    'answers a missing or empty item (%j) with 400',
    async (payload) => {
      const response = await post(payload)
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: 'item is required' })
      expect(addToCart).not.toHaveBeenCalled()
    },
  )

  it('answers a rejected Woolworths session with 502', async () => {
    addToCart.mockRejectedValue(new SessionRejectedError(SESSION_EXPIRED_MESSAGE))
    const response = await post({ item: 'milk' })
    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({ error: SESSION_EXPIRED_MESSAGE })
  })

  it('answers other cart failures with 500', async () => {
    addToCart.mockRejectedValue(new Error('boom'))
    expect((await post({ item: 'milk' })).statusCode).toBe(500)
  })

  it('rejects a missing token with 401 and logs the reason', async () => {
    const response = await post({ item: 'milk' }, {})
    expect(response.statusCode).toBe(401)
    expect(response.json()).toEqual({ error: 'unauthorized' })
    expect(lines().find((line) => line.msg === 'auth rejected')).toMatchObject({
      reason: 'missing_authorization',
      route: '/cart/items',
      method: 'POST',
    })
    expect(addToCart).not.toHaveBeenCalled()
  })

  it('rejects an invalid token with 401', async () => {
    const response = await post({ item: 'milk' }, { authorization: 'Bearer nope' })
    expect(response.statusCode).toBe(401)
    expect(lines().find((line) => line.msg === 'auth rejected')).toMatchObject({
      reason: 'invalid_token',
    })
    expect(output).not.toContain('Bearer nope')
  })

  it('rejects the web session cookie', async () => {
    const cookie = await signInWeb(app, google)
    const response = await post({ item: 'milk' }, { cookie })
    expect(response.statusCode).toBe(401)
    expect(addToCart).not.toHaveBeenCalled()
  })

  it('is rate limited', async () => {
    for (let i = 0; i < 30; i++) {
      await post({ item: 'milk' })
    }
    expect((await post({ item: 'milk' })).statusCode).toBe(429)
  })
})
