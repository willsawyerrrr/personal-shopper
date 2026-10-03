import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.ts'
import type { ItemsConfig } from './items.ts'
import type { AppConfig } from './config.ts'
import { signInClient, signInWeb, testConfig } from './testing/app.ts'
import { FakeGoogle } from './testing/google.ts'

describe('admin', () => {
  let dir: string
  let config: AppConfig
  let google: FakeGoogle
  let app: FastifyInstance
  let authHeader: { cookie: string }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-admin-'))
    config = testConfig(dir)
    await writeFile(config.itemsPath, 'milk:\n  stockcode: 123456\n  quantity: 1\n')
    google = await FakeGoogle.create()
    app = buildApp(config, { fetch: google.fetch })
    authHeader = { cookie: await signInWeb(app, google) }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true })
  })

  it('serves a Google sign-in button instead of a password form', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin/login' })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('href="/auth/google/login"')
    expect(response.body).toContain('Sign in with Google')
    expect(response.body).not.toContain('type="password"')
  })

  it('has no password login', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: 'secret=anything',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(response.statusCode).toBe(404)
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('redirects unauthenticated browser requests to the login page', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin' })
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/admin/login')
  })

  it('answers unauthenticated browser writes with 401', async () => {
    const response = await app.inject({ method: 'POST', url: '/admin/items/milk/delete' })
    expect(response.statusCode).toBe(401)
    expect(await readFile(config.itemsPath, 'utf8')).toContain('milk:')
  })

  it('signs out by revoking the session and clearing the cookie', async () => {
    const logout = await app.inject({ method: 'POST', url: '/admin/logout', headers: authHeader })
    expect(logout.statusCode).toBe(302)
    expect(logout.headers.location).toBe('/admin/login')
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0')
    const afterLogout = await app.inject({ method: 'GET', url: '/admin', headers: authHeader })
    expect(afterLogout.statusCode).toBe(302)
  })

  describe('sessions', () => {
    const rows = (body: string) =>
      body
        .split('<tr>')
        .map((row) => /<td>([^<]*)<\/td>[\s\S]*\/admin\/sessions\/([0-9a-f]+)\/revoke/.exec(row))
        .flatMap((match) => (match ? [{ client: match[1] ?? '', id: match[2] ?? '' }] : []))
    const page = async () =>
      rows((await app.inject({ method: 'GET', url: '/admin', headers: authHeader })).body)

    it('lists active sessions, marking the current one, without exposing tokens', async () => {
      const token = await signInClient(app, google, { client: 'extension' })
      const response = await app.inject({ method: 'GET', url: '/admin', headers: authHeader })
      expect(response.body).toContain('web (this session)')
      expect(response.body).toContain('extension')
      expect(response.body).toContain('me@example.com')
      expect(rows(response.body)).toHaveLength(2)
      expect(response.body).not.toContain(token)
      expect(response.body).not.toContain(authHeader.cookie.split('=')[1])
    })

    it('revokes another session', async () => {
      const token = await signInClient(app, google)
      const bearer = { authorization: `Bearer ${token}`, accept: 'application/json' }
      const ios = (await page()).find((row) => row.client === 'ios')
      const revoke = await app.inject({
        method: 'POST',
        url: `/admin/sessions/${ios?.id}/revoke`,
        headers: authHeader,
      })
      expect(revoke.statusCode).toBe(302)
      expect(revoke.headers.location).toBe('/admin')
      const items = await app.inject({ method: 'GET', url: '/admin/items', headers: bearer })
      expect(items.statusCode).toBe(401)
      const admin = await app.inject({ method: 'GET', url: '/admin', headers: authHeader })
      expect(admin.statusCode).toBe(200)
    })

    it('revokes the current session and signs out', async () => {
      const own = (await page()).find((row) => row.client.includes('this session'))
      const revoke = await app.inject({
        method: 'POST',
        url: `/admin/sessions/${own?.id}/revoke`,
        headers: authHeader,
      })
      expect(revoke.headers.location).toBe('/admin/login')
      expect(String(revoke.headers['set-cookie'])).toContain('Max-Age=0')
      const admin = await app.inject({ method: 'GET', url: '/admin', headers: authHeader })
      expect(admin.statusCode).toBe(302)
    })

    it('revokes over JSON with 204', async () => {
      const token = await signInClient(app, google)
      const bearer = { authorization: `Bearer ${token}`, accept: 'application/json' }
      const web = (await page()).find((row) => row.client.includes('this session'))
      const response = await app.inject({
        method: 'POST',
        url: `/admin/sessions/${web?.id}/revoke`,
        headers: bearer,
      })
      expect(response.statusCode).toBe(204)
      const admin = await app.inject({ method: 'GET', url: '/admin', headers: authHeader })
      expect(admin.statusCode).toBe(302)
    })
  })

  it('lists existing items', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin', headers: authHeader })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('milk')
    expect(response.body).toContain('123456')
  })

  it('adds an item from a product URL', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/items',
      headers: authHeader,
      payload: {
        word: 'Bread',
        url: 'https://www.woolworths.com.au/shop/productdetails/888137/woolworths-full-cream-milk',
        quantity: '2',
      },
    })
    expect(response.statusCode).toBe(302)
    const items = await readFile(config.itemsPath, 'utf8')
    expect(items).toContain('bread:')
    expect(items).toContain('888137')
    expect(items).toContain('quantity: 2')
  })

  it('adds an item from a bare stockcode', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/items',
      headers: authHeader,
      payload: { word: 'eggs', url: '654321' },
    })
    expect(response.statusCode).toBe(302)
    const items = await readFile(config.itemsPath, 'utf8')
    expect(items).toContain('eggs:')
    expect(items).toContain('654321')
  })

  it('re-renders with an error when the URL has no stockcode', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/items',
      headers: authHeader,
      payload: { word: 'bread', url: 'not a url' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('Could not find a stockcode')
    const items = await readFile(config.itemsPath, 'utf8')
    expect(items).not.toContain('bread:')
  })

  it('offers an edit form per item, prefilled', async () => {
    const response = await app.inject({ method: 'GET', url: '/admin', headers: authHeader })
    expect(response.body).toContain('action="/admin/items/milk/edit"')
    expect(response.body).toContain('name="word" required value="milk"')
    expect(response.body).toContain('name="url" required value="123456"')
    expect(response.body).toContain('name="quantity" type="number" min="1" value="1"')
  })

  it('edits an item from the web form and redirects', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/items/milk/edit',
      headers: { ...authHeader, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'word=Oat+Milk&url=654321&quantity=3',
    })
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/admin')
    expect(await readFile(config.itemsPath, 'utf8')).toBe(
      'oat milk:\n  stockcode: 654321\n  quantity: 3\n',
    )
  })

  it('re-renders the page with the error when a web edit collides', async () => {
    await writeFile(
      config.itemsPath,
      'milk:\n  stockcode: 1\n  quantity: 1\nbread:\n  stockcode: 2\n  quantity: 1\n',
    )
    const response = await app.inject({
      method: 'POST',
      url: '/admin/items/milk/edit',
      headers: { ...authHeader, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'word=bread&url=1&quantity=1',
    })
    expect(response.statusCode).toBe(409)
    expect(response.body).toContain('already used by another item')
    expect(await readFile(config.itemsPath, 'utf8')).toContain('milk:')
  })

  it('answers unauthenticated web edits with 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/items/milk/edit',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'word=oat&url=1',
    })
    expect(response.statusCode).toBe(401)
    expect(await readFile(config.itemsPath, 'utf8')).toContain('milk:')
  })

  it('removes an item', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/items/milk/delete',
      headers: authHeader,
    })
    expect(response.statusCode).toBe(302)
    const items = await readFile(config.itemsPath, 'utf8')
    expect(items).not.toContain('milk:')
  })

  describe('JSON API', () => {
    let json: { authorization: string; accept: string }

    beforeEach(async () => {
      json = {
        authorization: `Bearer ${await signInClient(app, google)}`,
        accept: 'application/json',
      }
    })

    it('lists items as JSON', async () => {
      const response = await app.inject({ method: 'GET', url: '/admin/items', headers: json })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ items: [{ word: 'milk', stockcode: 123456, quantity: 1 }] })
    })

    it('answers unauthenticated JSON requests with 401 instead of a redirect', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/items',
        headers: { accept: 'application/json' },
      })
      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({ error: 'unauthorized' })
    })

    it('adds an item from a JSON body and returns it', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/items',
        headers: json,
        payload: {
          word: 'Bread',
          url: 'https://www.woolworths.com.au/shop/productdetails/888137/bread',
          quantity: 2,
        },
      })
      expect(response.statusCode).toBe(201)
      expect(response.json()).toEqual({
        word: 'bread',
        stockcode: 888137,
        quantity: 2,
      })
      expect(await readFile(config.itemsPath, 'utf8')).toContain('bread:')
    })

    it('rejects a URL without a stockcode', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/items',
        headers: json,
        payload: { word: 'bread', url: 'nope' },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('Could not find a stockcode')
    })

    it('rejects a missing trigger word', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/items',
        headers: json,
        payload: { url: '654321' },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: 'A trigger word is required.' })
    })

    describe('PATCH /admin/items/:word', () => {
      const patch = async (word: string, payload: Record<string, unknown>) =>
        await app.inject({ method: 'PATCH', url: `/admin/items/${word}`, headers: json, payload })

      beforeEach(async () => {
        await writeFile(
          config.itemsPath,
          'milk:\n  stockcode: 1\n  quantity: 1\n  listing: Milk 2L\nbread:\n  stockcode: 2\n  quantity: 1\neggs:\n  stockcode: 3\n  quantity: 1\n',
        )
      })

      it('changes quantity and stockcode, keeping other entries and order', async () => {
        const response = await patch('bread', { quantity: 4, stockcode: 99 })
        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({ word: 'bread', stockcode: 99, quantity: 4 })
        expect(parse(await readFile(config.itemsPath, 'utf8'))).toEqual({
          milk: { stockcode: 1, quantity: 1, listing: 'Milk 2L' },
          bread: { stockcode: 99, quantity: 4 },
          eggs: { stockcode: 3, quantity: 1 },
        })
        expect(Object.keys(parse(await readFile(config.itemsPath, 'utf8')))).toEqual([
          'milk',
          'bread',
          'eggs',
        ])
      })

      it('renames the phrase in place, normalised', async () => {
        const response = await patch('bread', { word: '  Sourdough ' })
        expect(response.statusCode).toBe(200)
        expect(response.json().word).toBe('sourdough')
        expect(Object.keys(parse(await readFile(config.itemsPath, 'utf8')))).toEqual([
          'milk',
          'sourdough',
          'eggs',
        ])
      })

      it('accepts a rename that only changes case', async () => {
        const response = await patch('bread', { word: 'BREAD', quantity: 2 })
        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({ word: 'bread', stockcode: 2, quantity: 2 })
      })

      it('parses a url to a stockcode', async () => {
        const response = await patch('bread', {
          url: 'https://www.woolworths.com.au/shop/productdetails/888137/bread',
        })
        expect(response.json().stockcode).toBe(888137)
      })

      it('looks the item up by normalised word', async () => {
        const response = await patch('MILK', { quantity: 2 })
        expect(response.statusCode).toBe(200)
      })

      it('rejects a rename onto another item with 409', async () => {
        const response = await patch('bread', { word: 'Milk' })
        expect(response.statusCode).toBe(409)
        expect(response.json().error).toContain('already used')
        expect(parse(await readFile(config.itemsPath, 'utf8')).bread).toBeDefined()
      })

      it('answers an unknown word with 404', async () => {
        const response = await patch('cheese', { quantity: 2 })
        expect(response.statusCode).toBe(404)
        expect(response.json().error).toContain('cheese')
      })

      it.each([
        { quantity: 0 },
        { quantity: -1 },
        { quantity: 1.5 },
        { quantity: 'many' },
        { stockcode: 0 },
        { stockcode: 'abc' },
        { url: 'nope' },
        { word: '   ' },
        { word: 5 },
      ])('rejects %j with 400 and writes nothing', async (payload) => {
        const before = await readFile(config.itemsPath, 'utf8')
        const response = await patch('bread', payload)
        expect(response.statusCode).toBe(400)
        expect(response.json().error).toEqual(expect.any(String))
        expect(await readFile(config.itemsPath, 'utf8')).toBe(before)
      })

      it('answers unauthenticated requests with 401', async () => {
        const response = await app.inject({
          method: 'PATCH',
          url: '/admin/items/bread',
          headers: { accept: 'application/json' },
          payload: { quantity: 2 },
        })
        expect(response.statusCode).toBe(401)
      })
    })

    it('removes an item with DELETE and 204', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/admin/items/milk',
        headers: json,
      })
      expect(response.statusCode).toBe(204)
      expect(await readFile(config.itemsPath, 'utf8')).not.toContain('milk:')
    })

    it('removes an item with 204', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/admin/items/milk/delete',
        headers: json,
      })
      expect(response.statusCode).toBe(204)
      expect(await readFile(config.itemsPath, 'utf8')).not.toContain('milk:')
    })
  })
})

describe('admin listing text', () => {
  let dir: string
  let config: AppConfig
  let google: FakeGoogle
  let app: FastifyInstance
  let json: { cookie: string; accept: string }
  const listings: Record<number, string> = { 1: 'Milk 2L', 2: 'Bread 650g', 99: 'Rye 500g' }
  const lookup = { listing: vi.fn(async (stockcode: number) => listings[stockcode]) }

  const readItems = async () => parse(await readFile(config.itemsPath, 'utf8')) as ItemsConfig

  beforeEach(async () => {
    lookup.listing.mockClear()
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-admin-'))
    config = testConfig(dir)
    await writeFile(config.itemsPath, 'milk:\n  stockcode: 1\n  quantity: 1\n  name: Guess\n')
    google = await FakeGoogle.create()
    app = buildApp(config, { fetch: google.fetch, lookup })
    json = { cookie: await signInWeb(app, google), accept: 'application/json' }
  })

  afterEach(async () => {
    await app.close()
    await rm(dir, { recursive: true })
  })

  it('stores the listing of an added item and returns it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/items',
      headers: json,
      payload: { word: 'Bread', url: '2', quantity: 2 },
    })
    expect(response.json()).toEqual({
      word: 'bread',
      stockcode: 2,
      quantity: 2,
      listing: 'Bread 650g',
    })
    expect((await readItems()).bread).toEqual({
      stockcode: 2,
      quantity: 2,
      listing: 'Bread 650g',
    })
  })

  it('adds the item without a listing when the lookup fails', async () => {
    lookup.listing.mockRejectedValueOnce(new Error('boom'))
    const response = await app.inject({
      method: 'POST',
      url: '/admin/items',
      headers: json,
      payload: { word: 'bread', url: '2' },
    })
    expect(response.statusCode).toBe(201)
    expect(response.json()).toEqual({ word: 'bread', stockcode: 2, quantity: 1 })
  })

  it('looks the listing up again when the stockcode changes', async () => {
    await vi.waitFor(async () => expect((await readItems()).milk?.listing).toBe('Milk 2L'))
    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/items/milk',
      headers: json,
      payload: { stockcode: 99 },
    })
    expect(response.json().listing).toBe('Rye 500g')
  })

  it('keeps the listing when the stockcode is unchanged', async () => {
    await vi.waitFor(async () => expect((await readItems()).milk?.listing).toBe('Milk 2L'))
    lookup.listing.mockClear()
    const response = await app.inject({
      method: 'PATCH',
      url: '/admin/items/milk',
      headers: json,
      payload: { url: '1', quantity: 3 },
    })
    expect(response.json()).toEqual({ word: 'milk', stockcode: 1, quantity: 3, listing: 'Milk 2L' })
    expect(lookup.listing).not.toHaveBeenCalled()
  })

  it('backfills existing items in the background and lists them with their listing', async () => {
    await vi.waitFor(async () => expect((await readItems()).milk?.listing).toBe('Milk 2L'))
    const response = await app.inject({ method: 'GET', url: '/admin/items', headers: json })
    expect(response.json().items).toEqual([
      { word: 'milk', stockcode: 1, quantity: 1, listing: 'Milk 2L' },
    ])
  })

  it('shows the listing under the phrase on the admin page', async () => {
    await vi.waitFor(async () => expect((await readItems()).milk?.listing).toBe('Milk 2L'))
    const response = await app.inject({ method: 'GET', url: '/admin', headers: json })
    expect(response.body).toContain('<div class="listing">Milk 2L</div>')
  })
})
