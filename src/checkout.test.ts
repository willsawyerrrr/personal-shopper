import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.ts'
import { CartStore } from './cart-store.ts'
import { pickCheapest } from './checkout.ts'
import { itemIdFor, seedItems, signInClient, signInWeb, testConfig } from './testing/app.ts'
import { createTestDb } from './testing/db.ts'
import { FakeGoogle } from './testing/google.ts'
import type { CartClient, PriceLookup } from './woolworths/client.ts'
import { SESSION_EXPIRED_MESSAGE, SessionRejectedError } from './woolworths/session.ts'

describe('pickCheapest', () => {
  it('picks the lower price per unit', () => {
    expect(
      pickCheapest([
        { stockcode: 1, quantity: 1, price: 2 },
        { stockcode: 2, quantity: 4, price: 7 },
      ]),
    ).toEqual({ stockcode: 2, quantity: 4, price: 7 })
  })

  it('falls back to the first candidate when no price is known', () => {
    expect(
      pickCheapest([
        { stockcode: 1, quantity: 1 },
        { stockcode: 2, quantity: 4 },
      ]),
    ).toEqual({ stockcode: 1, quantity: 1 })
  })

  it('ignores a candidate with an unknown price even when it would otherwise win', () => {
    expect(
      pickCheapest([
        { stockcode: 1, quantity: 1, price: 2 },
        { stockcode: 2, quantity: 4 },
      ]),
    ).toEqual({ stockcode: 1, quantity: 1, price: 2 })
  })
})

const YAML = `
milk:
  stockcode: 100
  quantity: 2
bars:
  stockcode: 1
  quantity: 1
  alternatives:
    - stockcode: 2
      quantity: 4
bread:
  stockcode: 300
  quantity: 1
`

describe('cart API and checkout', () => {
  let dir: string
  let db: Awaited<ReturnType<typeof createTestDb>>
  let google: FakeGoogle
  let app: FastifyInstance
  let addToCart: ReturnType<typeof vi.fn<CartClient['addToCart']>>
  let price: ReturnType<typeof vi.fn<PriceLookup['price']>>
  let bearer: { authorization: string; accept: string }
  let cookie: { cookie: string }
  let cart: CartStore

  const send = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    headers: Record<string, string> = bearer,
  ) => app.inject({ method, url, headers })
  const id = (word: string) => itemIdFor(db.sql, word)
  const fill = async (...words: string[]) => {
    for (const word of words) {
      await cart.add('me@example.com', await id(word))
    }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-checkout-'))
    db = await createTestDb()
    cart = new CartStore(db.sql)
    await seedItems(db.sql, YAML)
    google = await FakeGoogle.create()
    addToCart = vi.fn<CartClient['addToCart']>().mockResolvedValue(undefined)
    price = vi.fn<PriceLookup['price']>((stockcode) => Promise.resolve(stockcode === 1 ? 3 : 10))
    app = buildApp(testConfig(dir), {
      sql: db.sql,
      fetch: google.fetch,
      cart: () => ({ addToCart, price }),
    })
    bearer = {
      authorization: `Bearer ${await signInClient(app, google)}`,
      accept: 'application/json',
    }
    cookie = { cookie: await signInWeb(app, google) }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true })
    await db.close()
  })

  describe('GET /cart', () => {
    it('lists entries with title, words and count', async () => {
      await fill('milk', 'milk', 'bars')
      const response = await send('GET', '/cart')
      expect(response.json()).toEqual({
        entries: [
          { id: await id('milk'), title: 'Milk', words: ['milk'], count: 2 },
          { id: await id('bars'), title: 'Bars', words: ['bars'], count: 1 },
        ],
      })
    })

    it('is empty for an empty cart and accepts the session cookie', async () => {
      const response = await send('GET', '/cart', { ...cookie, accept: 'application/json' })
      expect(response.json()).toEqual({ entries: [] })
    })

    it('requires authentication', async () => {
      expect((await app.inject({ method: 'GET', url: '/cart' })).statusCode).toBe(302)
      expect(
        (await app.inject({ method: 'GET', url: '/cart', headers: { accept: 'application/json' } }))
          .statusCode,
      ).toBe(401)
    })
  })

  describe('DELETE /cart/items/:id', () => {
    it('removes the entry', async () => {
      await fill('milk', 'milk')
      expect((await send('DELETE', `/cart/items/${await id('milk')}`)).statusCode).toBe(204)
      expect(await cart.list('me@example.com')).toEqual([])
    })

    it('answers an entry not in the cart with 404', async () => {
      expect((await send('DELETE', `/cart/items/${await id('milk')}`)).statusCode).toBe(404)
    })

    it('answers a malformed id with 400', async () => {
      expect((await send('DELETE', '/cart/items/nope')).statusCode).toBe(400)
    })
  })

  describe('POST /cart/checkout', () => {
    it('adds count times the quantity of the only candidate without a price lookup', async () => {
      await fill('milk', 'milk', 'milk')
      const response = await send('POST', '/cart/checkout')
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        added: [{ id: await id('milk'), title: 'Milk', stockcode: 100, quantity: 6 }],
        failed: [],
      })
      expect(addToCart).toHaveBeenCalledWith(100, 6)
      expect(price).not.toHaveBeenCalled()
      expect(await cart.list('me@example.com')).toEqual([])
    })

    it('chooses the cheapest candidate at checkout time', async () => {
      await fill('bars', 'bars')
      await send('POST', '/cart/checkout')
      expect(addToCart).toHaveBeenLastCalledWith(2, 8)

      price.mockImplementation((stockcode) => Promise.resolve(stockcode === 1 ? 1 : 10))
      await fill('bars')
      await send('POST', '/cart/checkout')
      expect(addToCart).toHaveBeenLastCalledWith(1, 1)
    })

    it('uses the first candidate when prices cannot be looked up', async () => {
      price.mockRejectedValue(new Error('boom'))
      await fill('bars')
      await send('POST', '/cart/checkout')
      expect(addToCart).toHaveBeenCalledWith(1, 1)
    })

    it('leaves failures in the cart and removes what landed', async () => {
      addToCart.mockImplementation((stockcode) =>
        stockcode === 100 ? Promise.reject(new Error('boom')) : Promise.resolve(),
      )
      await fill('milk', 'bread')
      const response = await send('POST', '/cart/checkout')
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        added: [{ id: await id('bread'), title: 'Bread', stockcode: 300, quantity: 1 }],
        failed: [{ id: await id('milk'), title: 'Milk', error: expect.any(String) }],
      })
      expect(await cart.list('me@example.com')).toEqual([{ itemId: await id('milk'), count: 1 }])
    })

    it('keeps an item without products in the cart', async () => {
      await fill('bread')
      await db.sql`delete from item_candidates where stockcode = 300`
      const response = await send('POST', '/cart/checkout')
      expect(response.json()).toMatchObject({ added: [], failed: [{ title: 'Bread' }] })
      expect(addToCart).not.toHaveBeenCalled()
      expect(await cart.list('me@example.com')).toHaveLength(1)
    })

    it('keeps what was added to the cart during checkout', async () => {
      addToCart.mockImplementation(async () => {
        await fill('milk')
      })
      await fill('milk')
      await send('POST', '/cart/checkout')
      expect(await cart.list('me@example.com')).toEqual([{ itemId: await id('milk'), count: 1 }])
    })

    it('answers a rejected Woolworths session with 502 and keeps the cart', async () => {
      addToCart.mockRejectedValue(new SessionRejectedError(SESSION_EXPIRED_MESSAGE))
      await fill('milk', 'bread')
      const response = await send('POST', '/cart/checkout')
      expect(response.statusCode).toBe(502)
      expect(response.json()).toEqual({ error: SESSION_EXPIRED_MESSAGE })
      expect(await cart.list('me@example.com')).toHaveLength(2)
    })

    it('answers a session rejected by a price lookup with 502', async () => {
      price.mockRejectedValue(new SessionRejectedError(SESSION_EXPIRED_MESSAGE))
      await fill('bars')
      expect((await send('POST', '/cart/checkout')).statusCode).toBe(502)
      expect(addToCart).not.toHaveBeenCalled()
      expect(await cart.list('me@example.com')).toHaveLength(1)
    })

    it('removes the entries that landed before the session was rejected', async () => {
      addToCart.mockImplementation((stockcode) =>
        stockcode === 300
          ? Promise.reject(new SessionRejectedError(SESSION_EXPIRED_MESSAGE))
          : Promise.resolve(),
      )
      await fill('milk', 'bread')
      expect((await send('POST', '/cart/checkout')).statusCode).toBe(502)
      expect(await cart.list('me@example.com')).toEqual([{ itemId: await id('bread'), count: 1 }])
    })

    it('adds nothing for an empty cart', async () => {
      expect((await send('POST', '/cart/checkout')).json()).toEqual({ added: [], failed: [] })
      expect(addToCart).not.toHaveBeenCalled()
    })

    it('does not exist without a Woolworths cart', async () => {
      const bare = buildApp(testConfig(dir), { sql: db.sql, fetch: google.fetch })
      const headers = { ...bearer, authorization: `Bearer ${await signInClient(bare, google)}` }
      expect(
        (await bare.inject({ method: 'POST', url: '/cart/checkout', headers })).statusCode,
      ).toBe(404)
    })

    it('requires authentication', async () => {
      const response = await app.inject({ method: 'POST', url: '/cart/checkout' })
      expect(response.statusCode).toBe(401)
    })
  })

  describe('cart page', () => {
    const page = (path = '/cart/manage') =>
      app.inject({ method: 'GET', url: path, headers: cookie })

    it('is in the navigation, marked current on its own page', async () => {
      const response = await page()
      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('<a href="/cart/manage" aria-current="page">Cart</a>')
      const items = await page('/')
      expect(items.body).toContain('<a href="/cart/manage">Cart</a>')
    })

    it('lists entries with counts and remove buttons', async () => {
      await fill('milk', 'milk')
      const { body } = await page()
      expect(body).toContain('Milk')
      expect(body).toContain(`action="/cart/items/${await id('milk')}/delete"`)
      expect(body).toContain('Check out')
    })

    it('shows an empty cart without a Check out button', async () => {
      const { body } = await page()
      expect(body).toContain('Your cart is empty.')
      expect(body).not.toContain('Check out')
    })

    it('removes an entry from its form', async () => {
      await fill('milk')
      const response = await app.inject({
        method: 'POST',
        url: `/cart/items/${await id('milk')}/delete`,
        headers: cookie,
      })
      expect(response.statusCode).toBe(302)
      expect(response.headers.location).toBe('/cart/manage')
      expect(await cart.list('me@example.com')).toEqual([])
    })

    it('shows the checkout result', async () => {
      addToCart.mockImplementation((stockcode) =>
        stockcode === 100 ? Promise.reject(new Error('boom')) : Promise.resolve(),
      )
      await fill('milk', 'bread')
      const response = await app.inject({ method: 'POST', url: '/cart/checkout', headers: cookie })
      expect(response.statusCode).toBe(200)
      expect(response.body).toContain('Added to your Woolworths cart')
      expect(response.body).toContain('1 × Bread')
      expect(response.body).toContain('Still in your cart')
    })

    it('shows a rejected session as an error', async () => {
      addToCart.mockRejectedValue(new SessionRejectedError(SESSION_EXPIRED_MESSAGE))
      await fill('milk')
      const response = await app.inject({ method: 'POST', url: '/cart/checkout', headers: cookie })
      expect(response.statusCode).toBe(502)
      expect(response.body).toContain(SESSION_EXPIRED_MESSAGE)
      expect(response.body).toContain('Milk')
    })

    it('says so when checking out an empty cart', async () => {
      const response = await app.inject({ method: 'POST', url: '/cart/checkout', headers: cookie })
      expect(response.body).toContain('Your cart was empty')
    })

    it('shows the page without a Check out button when checkout is unavailable', async () => {
      const bare = buildApp(testConfig(dir), { sql: db.sql, fetch: google.fetch })
      const headers = { cookie: await signInWeb(bare, google) }
      await fill('milk')
      const response = await bare.inject({ method: 'GET', url: '/cart/manage', headers })
      expect(response.body).toContain('Milk')
      expect(response.body).not.toContain('Check out')
    })
  })
})
