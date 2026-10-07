import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.ts'
import { DEFAULT_LIMITS } from './config.ts'
import { TokenStore } from './tokens.ts'
import type { ItemsConfig } from './items.ts'
import type { AppConfig } from './config.ts'
import { itemsYaml, seedItems, signInClient, signInWeb, testConfig } from './testing/app.ts'
import { createTestDb } from './testing/db.ts'
import { FakeGoogle } from './testing/google.ts'
import { CredentialStore } from './users/credentials.ts'
import { PgSessionStorage } from './users/sessions.ts'
import { UserWoolworths } from './users/woolworths.ts'

describe('admin', () => {
  let dir: string
  let db: Awaited<ReturnType<typeof createTestDb>>
  let config: AppConfig
  let google: FakeGoogle
  let app: FastifyInstance
  let authHeader: { cookie: string }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-admin-'))
    db = await createTestDb()
    config = testConfig(dir)
    await seedItems(db.sql, 'milk:\n  stockcode: 123456\n  quantity: 1\n')
    google = await FakeGoogle.create()
    app = buildApp(config, { sql: db.sql, fetch: google.fetch })
    authHeader = { cookie: await signInWeb(app, google) }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true })
    await db.close()
  })

  it('shows whether a passkey is registered only when passkeys are enabled', async () => {
    const page = () => app.inject({ method: 'GET', url: '/account', headers: authHeader })
    expect((await page()).body).not.toContain('Woolworths passkey')

    const credentials = new CredentialStore(db.sql, randomBytes(32))
    app = buildApp(config, {
      sql: db.sql,
      fetch: google.fetch,
      passkeys: { credentials, sessions: new UserWoolworths(db.sql, credentials) },
    })
    authHeader = { cookie: await signInWeb(app, google) }
    const unregistered = (await page()).body
    expect(unregistered).toContain('Not registered.')
    expect(unregistered).toContain('data-open-extension-options>Register passkey<')
    await credentials.put('me@example.com', [{ credentialId: 'x' }])
    const registered = (await page()).body
    expect(registered).toContain('Registered.')
    expect(registered).toContain('data-open-extension-options>Replace passkey<')
  })

  describe('removing the passkey', () => {
    let credentials: CredentialStore
    const stored = (email: string) => new PgSessionStorage(db.sql, email)
    const remove = (headers?: { cookie: string }) =>
      app.inject({
        method: 'POST',
        url: '/account/passkey/remove',
        ...(headers && { headers }),
      })

    beforeEach(async () => {
      credentials = new CredentialStore(db.sql, randomBytes(32))
      app = buildApp(config, {
        sql: db.sql,
        fetch: google.fetch,
        passkeys: { credentials, sessions: new UserWoolworths(db.sql, credentials) },
      })
      authHeader = { cookie: await signInWeb(app, google) }
    })

    const page = async () =>
      (await app.inject({ method: 'GET', url: '/account', headers: authHeader })).body

    it('offers removal only when a passkey is registered', async () => {
      expect(await page()).not.toContain('Remove passkey')
      await credentials.put('me@example.com', [{ credentialId: 'x' }])
      expect(await page()).toContain('action="/account/passkey/remove"')
      expect(await page()).toContain('Remove passkey</button>')
    })

    it('removes the credential, deletes the stored session and confirms', async () => {
      await credentials.put('me@example.com', [{ credentialId: 'x' }])
      await stored('me@example.com').save({ cookies: [], capturedAt: new Date().toISOString() })
      const response = await remove(authHeader)
      expect(response.statusCode).toBe(302)
      expect(response.headers.location).toBe('/account?passkey=removed')
      expect(await credentials.has('me@example.com')).toBe(false)
      await expect(stored('me@example.com').load()).resolves.toBeUndefined()
      const shown = await app.inject({
        method: 'GET',
        url: response.headers.location as string,
        headers: authHeader,
      })
      expect(shown.body).toContain('<p class="notice" role="status">Passkey removed.</p>')
      expect(shown.body).toContain('Not registered.')
      expect(shown.body).not.toContain('Remove passkey</button>')
    })

    it('leaves other users credentials alone', async () => {
      await credentials.put('me@example.com', [{ credentialId: 'x' }])
      await credentials.put('you@example.com', [{ credentialId: 'y' }])
      await remove(authHeader)
      expect(await credentials.has('you@example.com')).toBe(true)
    })

    it('handles removal when none is registered', async () => {
      const response = await remove(authHeader)
      expect(response.statusCode).toBe(302)
      expect(response.headers.location).toBe('/account?passkey=removed')
    })

    it('rejects unauthenticated requests', async () => {
      await credentials.put('me@example.com', [{ credentialId: 'x' }])
      const response = await remove()
      expect(response.statusCode).toBe(401)
      expect(await credentials.has('me@example.com')).toBe(true)
    })

    it('does not show the notice for other values', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/account?passkey=%3Cb%3E',
        headers: authHeader,
      })
      expect(response.body).not.toContain('class="notice"')
    })

    it('is rate limited like the API route', async () => {
      const statuses: number[] = []
      for (let i = 0; i < 11; i++) {
        statuses.push((await remove(authHeader)).statusCode)
      }
      expect(statuses.slice(0, 10).every((status) => status === 302)).toBe(true)
      expect(statuses[10]).toBe(429)
    })

    it('is not available when passkeys are disabled', async () => {
      app = buildApp(config, { sql: db.sql, fetch: google.fetch })
      authHeader = { cookie: await signInWeb(app, google) }
      expect((await remove(authHeader)).statusCode).toBe(404)
    })
  })

  describe('pages', () => {
    const get = (url: string, headers?: { cookie: string }) =>
      app.inject({ method: 'GET', url, ...(headers && { headers }) })
    const pages = [
      {
        url: '/',
        label: 'Items',
        has: ['class="items"'],
        lacks: ['Signed-in sessions', 'name="word"', 'Invite code'],
      },
      {
        url: '/items/new',
        label: 'Add item',
        has: ['name="word"'],
        lacks: ['class="items"', 'Signed-in sessions', 'Invite code'],
      },
      {
        url: '/household/manage',
        label: 'Household',
        has: ['Invite code'],
        lacks: ['class="items"', 'name="word"', 'Signed-in sessions'],
      },
      {
        url: '/account',
        label: 'Account',
        has: ['Signed-in sessions'],
        lacks: ['class="items"', 'name="word"', 'Invite code'],
      },
    ]

    it.each(pages)('renders only its own sections at $url', async ({ url, has, lacks }) => {
      const response = await get(url, authHeader)
      expect(response.statusCode).toBe(200)
      for (const text of has) {
        expect(response.body).toContain(text)
      }
      for (const text of lacks) {
        expect(response.body).not.toContain(text)
      }
    })

    it.each(pages)('marks only $label as the current page at $url', async ({ url, label }) => {
      const { body } = await get(url, authHeader)
      expect(body.match(/aria-current="page"/g)).toHaveLength(1)
      expect(body).toContain(`aria-current="page">${label}</a>`)
      for (const { url: href } of pages) {
        expect(body).toContain(`href="${href}"`)
      }
      expect(body).toContain('action="/logout"')
    })

    it.each(pages)(
      'redirects unauthenticated requests for $url to the login page',
      async ({ url }) => {
        const response = await get(url)
        expect(response.statusCode).toBe(302)
        expect(response.headers.location).toBe('/login')
      },
    )

    it('keeps GET /household as the JSON member list', async () => {
      const token = await signInClient(app, google)
      const response = await app.inject({
        method: 'GET',
        url: '/household',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
      expect(response.json()).toHaveProperty('members')
    })
  })

  it('serves a Google sign-in button instead of a password form', async () => {
    const response = await app.inject({ method: 'GET', url: '/login' })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('href="/auth/google/login"')
    expect(response.body).toContain('Sign in with Google')
    expect(response.body).not.toContain('type="password"')
  })

  it('adapts the pages to phone screens and the system colour scheme', async () => {
    const login = await app.inject({ method: 'GET', url: '/login' })
    const admin = await app.inject({ method: 'GET', url: '/account', headers: authHeader })
    for (const page of [login, admin]) {
      expect(page.body).toContain(
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
      )
      expect(page.body).toContain('prefers-color-scheme: dark')
    }
    expect(admin.body).toContain('<table class="sessions">')
  })

  it('has no password login', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/login',
      payload: 'secret=anything',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    expect(response.statusCode).toBe(404)
    expect(response.headers['set-cookie']).toBeUndefined()
  })

  it('redirects unauthenticated browser requests to the login page', async () => {
    const response = await app.inject({ method: 'GET', url: '/' })
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/login')
  })

  it('answers unauthenticated browser writes with 401', async () => {
    const response = await app.inject({ method: 'POST', url: '/items/milk/delete' })
    expect(response.statusCode).toBe(401)
    expect(await itemsYaml(db.sql)).toContain('milk:')
  })

  it('signs out by revoking the session and clearing the cookie', async () => {
    const logout = await app.inject({ method: 'POST', url: '/logout', headers: authHeader })
    expect(logout.statusCode).toBe(302)
    expect(logout.headers.location).toBe('/login')
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0')
    const afterLogout = await app.inject({ method: 'GET', url: '/', headers: authHeader })
    expect(afterLogout.statusCode).toBe(302)
  })

  describe('sessions', () => {
    const rows = (body: string) =>
      body
        .split('<tr>')
        .map((row) => /<td>([^<]*)<\/td>[\s\S]*\/sessions\/([0-9a-f]+)\/revoke/.exec(row))
        .flatMap((match) => (match ? [{ client: match[1] ?? '', id: match[2] ?? '' }] : []))
    const page = async () =>
      rows((await app.inject({ method: 'GET', url: '/account', headers: authHeader })).body)

    it('lists active sessions, marking the current one, without exposing tokens', async () => {
      const token = await signInClient(app, google, { client: 'extension' })
      const response = await app.inject({ method: 'GET', url: '/account', headers: authHeader })
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
        url: `/sessions/${ios?.id}/revoke`,
        headers: authHeader,
      })
      expect(revoke.statusCode).toBe(302)
      expect(revoke.headers.location).toBe('/account')
      const items = await app.inject({ method: 'GET', url: '/items', headers: bearer })
      expect(items.statusCode).toBe(401)
      const admin = await app.inject({ method: 'GET', url: '/', headers: authHeader })
      expect(admin.statusCode).toBe(200)
    })

    it('revokes the current session and signs out', async () => {
      const own = (await page()).find((row) => row.client.includes('this session'))
      const revoke = await app.inject({
        method: 'POST',
        url: `/sessions/${own?.id}/revoke`,
        headers: authHeader,
      })
      expect(revoke.headers.location).toBe('/login')
      expect(String(revoke.headers['set-cookie'])).toContain('Max-Age=0')
      const admin = await app.inject({ method: 'GET', url: '/', headers: authHeader })
      expect(admin.statusCode).toBe(302)
    })

    it('revokes over JSON with 204', async () => {
      const token = await signInClient(app, google)
      const bearer = { authorization: `Bearer ${token}`, accept: 'application/json' }
      const web = (await page()).find((row) => row.client.includes('this session'))
      const response = await app.inject({
        method: 'POST',
        url: `/sessions/${web?.id}/revoke`,
        headers: bearer,
      })
      expect(response.statusCode).toBe(204)
      const admin = await app.inject({ method: 'GET', url: '/', headers: authHeader })
      expect(admin.statusCode).toBe(302)
    })
  })

  it('lists existing items', async () => {
    const response = await app.inject({ method: 'GET', url: '/', headers: authHeader })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('Milk')
    expect(response.body).toContain('123456')
  })

  it('adds an item from a product URL', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/items',
      headers: authHeader,
      payload: {
        word: 'Bread',
        url: 'https://www.woolworths.com.au/shop/productdetails/888137/woolworths-full-cream-milk',
        quantity: '2',
      },
    })
    expect(response.statusCode).toBe(302)
    const items = await itemsYaml(db.sql)
    expect(items).toContain('bread:')
    expect(items).toContain('888137')
    expect(items).toContain('quantity: 2')
  })

  it('adds an item from a bare stockcode', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/items',
      headers: authHeader,
      payload: { word: 'eggs', url: '654321' },
    })
    expect(response.statusCode).toBe(302)
    const items = await itemsYaml(db.sql)
    expect(items).toContain('eggs:')
    expect(items).toContain('654321')
  })

  it('re-renders with an error when the URL has no stockcode', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/items',
      headers: authHeader,
      payload: { word: 'bread', url: 'not a url' },
    })
    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('Could not find a stockcode')
    expect(response.body).toContain('aria-current="page">Add item</a>')
    expect(response.body).toContain('value="bread"')
    expect(response.body).toContain('value="not a url"')
    const items = await itemsYaml(db.sql)
    expect(items).not.toContain('bread:')
  })

  it('offers an edit form per product, prefilled', async () => {
    const response = await app.inject({ method: 'GET', url: '/', headers: authHeader })
    expect(response.body).toContain('action="/products/123456/1/edit"')
    expect(response.body).toContain(
      'aria-label="Trigger words, separated by commas" name="words" required value="Milk"',
    )
    expect(response.body).not.toContain('<details')
    expect(response.body).toContain('name="url" required value="123456"')
    expect(response.body).toContain('name="quantity" type="number" min="1" value="1"')
  })

  it('renders products read-only until Edit is pressed', async () => {
    const response = await app.inject({ method: 'GET', url: '/', headers: authHeader })
    expect(response.body).toContain('<strong class="view">Milk</strong>')
    expect(response.body).toContain('<label class="view button-label" for="edit-0">Edit</label>')
    expect(response.body).toMatch(/class="edit-toggle" id="edit-0" aria-label="Edit Milk">/)
    expect(response.body).toContain('<button type="reset" class="edit secondary">Cancel</button>')
  })

  describe('grouped by product', () => {
    beforeEach(async () => {
      await seedItems(
        db.sql,
        [
          'full cream milk:\n  stockcode: 1\n  quantity: 1\n  listing: Full Cream Milk 2L\n',
          'bread:\n  stockcode: 2\n  quantity: 1\n',
          'milk:\n  stockcode: 1\n  quantity: 1\n',
          "ben & jerry's:\n  stockcode: 3\n  quantity: 2\n",
          'coca-cola:\n  stockcode: 3\n  quantity: 2\n',
          '7up:\n  stockcode: 3\n  quantity: 2\n',
          'lemonade:\n  stockcode: 3\n  quantity: 1\n',
        ].join(''),
      )
    })

    const form = { 'content-type': 'application/x-www-form-urlencoded' }

    it('lists one row per product with its words display-cased, sorted by title', async () => {
      const { body } = await app.inject({ method: 'GET', url: '/', headers: authHeader })
      expect(body.match(/<form class="item"/g)).toHaveLength(4)
      expect(body).toContain('<strong class="view">Full Cream Milk 2L</strong>')
      expect(body).toContain(
        '<div class="view words"><div>Full Cream Milk</div><div>Milk</div></div>',
      )
      expect(body).toContain('<strong class="view">Bread</strong>')
      expect(body).toContain(
        '<div class="view words"><div>Ben &amp; Jerry\'s</div><div>Coca-Cola</div><div>7up</div></div>',
      )
      expect(body.indexOf('Ben &amp; Jerry')).toBeLessThan(body.indexOf('>Bread<'))
      expect(body.indexOf('>Bread<')).toBeLessThan(body.indexOf('Full Cream Milk 2L'))
      expect(body.indexOf('Full Cream Milk 2L')).toBeLessThan(body.indexOf('>Lemonade<'))
    })

    it('sorts titles ignoring case and comparing numbers naturally, keeping word order', async () => {
      await seedItems(
        db.sql,
        [
          'zed:\n  stockcode: 10\n  quantity: 1\n  listing: Milk 10L\n',
          'a:\n  stockcode: 11\n  quantity: 1\n  listing: milk 2L\n',
          'b:\n  stockcode: 12\n  quantity: 1\n  listing: Apple\n',
          'y:\n  stockcode: 12\n  quantity: 1\n',
          'c:\n  stockcode: 13\n  quantity: 1\n  listing: apple\n',
        ].join(''),
      )
      const { body } = await app.inject({ method: 'GET', url: '/', headers: authHeader })
      const titles = [...body.matchAll(/<strong class="view">([^<]*)<\/strong>/g)].map((m) => m[1])
      expect(titles).toEqual(['Apple', 'apple', 'milk 2L', 'Milk 10L'])
      expect(body).toContain('<div class="view words"><div>B</div><div>Y</div></div>')
      expect(body).toMatch(/id="edit-3" aria-label="Edit Milk 10L"/)
    })

    it('titles a product without a listing by its first word', async () => {
      const { body } = await app.inject({ method: 'GET', url: '/', headers: authHeader })
      expect(body).toContain('<strong class="view">Ben &amp; Jerry\'s</strong>')
    })

    it('edits the whole word set from the web form', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/products/1/1/edit',
        headers: { ...authHeader, ...form },
        payload: 'words=Milk%2C+Skim+Milk&url=1&quantity=3',
      })
      expect(response.statusCode).toBe(302)
      expect(response.headers.location).toBe('/')
      expect(parse(await itemsYaml(db.sql))).toEqual({
        milk: { stockcode: 1, quantity: 3, listing: 'Full Cream Milk 2L' },
        'skim milk': { stockcode: 1, quantity: 3, listing: 'Full Cream Milk 2L' },
        bread: { stockcode: 2, quantity: 1 },
        "ben & jerry's": { stockcode: 3, quantity: 2 },
        'coca-cola': { stockcode: 3, quantity: 2 },
        '7up': { stockcode: 3, quantity: 2 },
        lemonade: { stockcode: 3, quantity: 1 },
      })
    })

    it("re-renders with the error when a web edit takes another product's word", async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/products/1/1/edit',
        headers: { ...authHeader, ...form },
        payload: 'words=milk%2C+bread&url=1&quantity=1',
      })
      expect(response.statusCode).toBe(409)
      expect(response.body).toContain('&quot;bread&quot; is already used by another item')
      expect(response.body).toMatch(/aria-label="Edit Full Cream Milk 2L" checked>/)
      expect(response.body).toContain('name="words" required value="milk, bread"')
      expect(response.body).toContain('<a class="edit button-link" href="/">Cancel</a>')
      expect(await itemsYaml(db.sql)).toContain('full cream milk:')
    })

    it('answers unauthenticated web edits with 401', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/products/1/1/edit',
        headers: form,
        payload: 'words=oat&url=1',
      })
      expect(response.statusCode).toBe(401)
      expect(await itemsYaml(db.sql)).toContain('milk:')
    })

    it('removes every word of a product', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/products/3/2/delete',
        headers: authHeader,
      })
      expect(response.statusCode).toBe(302)
      expect(Object.keys(parse(await itemsYaml(db.sql)))).toEqual([
        'full cream milk',
        'bread',
        'milk',
        'lemonade',
      ])
    })

    describe('JSON API', () => {
      let json: { authorization: string; accept: string }

      beforeEach(async () => {
        json = {
          authorization: `Bearer ${await signInClient(app, google)}`,
          accept: 'application/json',
        }
      })

      it('lists items in stored order', async () => {
        const response = await app.inject({ method: 'GET', url: '/items', headers: json })
        expect(response.json().items.map((item: { word: string }) => item.word)).toEqual([
          'full cream milk',
          'bread',
          'milk',
          "ben & jerry's",
          'coca-cola',
          '7up',
          'lemonade',
        ])
      })

      it("replaces a product's words, quantity and stockcode", async () => {
        const response = await app.inject({
          method: 'PATCH',
          url: '/products/3/2',
          headers: json,
          payload: { words: ['coca-cola', 'Fanta'], quantity: 4, stockcode: 9 },
        })
        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({
          words: ['coca-cola', 'fanta'],
          stockcode: 9,
          quantity: 4,
        })
        expect(Object.keys(parse(await itemsYaml(db.sql)))).toEqual([
          'full cream milk',
          'bread',
          'milk',
          'coca-cola',
          'fanta',
          'lemonade',
        ])
      })

      it('joins another product when its stockcode and quantity match', async () => {
        const response = await app.inject({
          method: 'PATCH',
          url: '/products/3/1',
          headers: json,
          payload: { stockcode: 2 },
        })
        expect(response.json().words).toEqual(['bread', 'lemonade'])
      })

      it.each([
        [{ words: [] }, 400],
        [{ words: ' , ' }, 400],
        [{ words: [5] }, 400],
        [{ words: ['bread'] }, 409],
        [{ quantity: 0 }, 400],
        [{ url: 'nope' }, 400],
      ])('rejects %j with %i and writes nothing', async (payload, status) => {
        const before = await itemsYaml(db.sql)
        const response = await app.inject({
          method: 'PATCH',
          url: '/products/1/1',
          headers: json,
          payload,
        })
        expect(response.statusCode).toBe(status)
        expect(response.json().error).toEqual(expect.any(String))
        expect(await itemsYaml(db.sql)).toBe(before)
      })

      it('answers an unknown or malformed product with 404 or 400', async () => {
        const patch = (url: string) =>
          app.inject({ method: 'PATCH', url, headers: json, payload: { quantity: 2 } })
        expect((await patch('/products/99/1')).statusCode).toBe(404)
        expect((await patch('/products/abc/1')).statusCode).toBe(400)
      })

      it('removes a product with DELETE and 204, then 404', async () => {
        const remove = () => app.inject({ method: 'DELETE', url: '/products/3/2', headers: json })
        expect((await remove()).statusCode).toBe(204)
        expect(await itemsYaml(db.sql)).not.toContain('coca-cola')
        expect((await remove()).statusCode).toBe(404)
      })
    })
  })

  it('removes an item', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/items/milk/delete',
      headers: authHeader,
    })
    expect(response.statusCode).toBe(302)
    const items = await itemsYaml(db.sql)
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
      const response = await app.inject({ method: 'GET', url: '/items', headers: json })
      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({ items: [{ word: 'milk', stockcode: 123456, quantity: 1 }] })
    })

    it('answers unauthenticated JSON requests with 401 instead of a redirect', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/items',
        headers: { accept: 'application/json' },
      })
      expect(response.statusCode).toBe(401)
      expect(response.json()).toEqual({ error: 'unauthorized' })
    })

    it('adds an item from a JSON body and returns it', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/items',
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
      expect(await itemsYaml(db.sql)).toContain('bread:')
    })

    it('rejects a URL without a stockcode', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/items',
        headers: json,
        payload: { word: 'bread', url: 'nope' },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toContain('Could not find a stockcode')
    })

    it('rejects a missing trigger word', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/items',
        headers: json,
        payload: { url: '654321' },
      })
      expect(response.statusCode).toBe(400)
      expect(response.json()).toEqual({ error: 'A trigger word is required.' })
    })

    describe('PATCH /items/:word', () => {
      const patch = async (word: string, payload: Record<string, unknown>) =>
        await app.inject({ method: 'PATCH', url: `/items/${word}`, headers: json, payload })

      beforeEach(async () => {
        await seedItems(
          db.sql,
          'milk:\n  stockcode: 1\n  quantity: 1\n  listing: Milk 2L\nbread:\n  stockcode: 2\n  quantity: 1\neggs:\n  stockcode: 3\n  quantity: 1\n',
        )
      })

      it('changes quantity and stockcode, keeping other entries and order', async () => {
        const response = await patch('bread', { quantity: 4, stockcode: 99 })
        expect(response.statusCode).toBe(200)
        expect(response.json()).toEqual({ word: 'bread', stockcode: 99, quantity: 4 })
        expect(parse(await itemsYaml(db.sql))).toEqual({
          milk: { stockcode: 1, quantity: 1, listing: 'Milk 2L' },
          bread: { stockcode: 99, quantity: 4 },
          eggs: { stockcode: 3, quantity: 1 },
        })
        expect(Object.keys(parse(await itemsYaml(db.sql)))).toEqual(['milk', 'bread', 'eggs'])
      })

      it('renames the phrase in place, normalised', async () => {
        const response = await patch('bread', { word: '  Sourdough ' })
        expect(response.statusCode).toBe(200)
        expect(response.json().word).toBe('sourdough')
        expect(Object.keys(parse(await itemsYaml(db.sql)))).toEqual(['milk', 'sourdough', 'eggs'])
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
        expect(parse(await itemsYaml(db.sql)).bread).toBeDefined()
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
        const before = await itemsYaml(db.sql)
        const response = await patch('bread', payload)
        expect(response.statusCode).toBe(400)
        expect(response.json().error).toEqual(expect.any(String))
        expect(await itemsYaml(db.sql)).toBe(before)
      })

      it('answers unauthenticated requests with 401', async () => {
        const response = await app.inject({
          method: 'PATCH',
          url: '/items/bread',
          headers: { accept: 'application/json' },
          payload: { quantity: 2 },
        })
        expect(response.statusCode).toBe(401)
      })
    })

    it('removes an item with DELETE and 204', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/items/milk',
        headers: json,
      })
      expect(response.statusCode).toBe(204)
      expect(await itemsYaml(db.sql)).not.toContain('milk:')
    })

    it('removes an item with 204', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/items/milk/delete',
        headers: json,
      })
      expect(response.statusCode).toBe(204)
      expect(await itemsYaml(db.sql)).not.toContain('milk:')
    })
  })
})

describe('admin listing text', () => {
  let dir: string
  let db: Awaited<ReturnType<typeof createTestDb>>
  let config: AppConfig
  let google: FakeGoogle
  let app: FastifyInstance
  let json: { cookie: string; accept: string }
  const listings: Record<number, string> = { 1: 'Milk 2L', 2: 'Bread 650g', 99: 'Rye 500g' }
  const lookup = { listing: vi.fn(async (stockcode: number) => listings[stockcode]) }

  const readItems = async () => parse(await itemsYaml(db.sql)) as ItemsConfig

  beforeEach(async () => {
    lookup.listing.mockClear()
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-admin-'))
    db = await createTestDb()
    config = testConfig(dir)
    await seedItems(db.sql, 'milk:\n  stockcode: 1\n  quantity: 1\n  name: Guess\n')
    google = await FakeGoogle.create()
    app = buildApp(config, { sql: db.sql, fetch: google.fetch, lookup: () => lookup })
    json = { cookie: await signInWeb(app, google), accept: 'application/json' }
  })

  afterEach(async () => {
    await app.close()
    await rm(dir, { recursive: true })
    await db.close()
  })

  it('stores the listing of an added item and returns it', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/items',
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
      url: '/items',
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
      url: '/items/milk',
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
      url: '/items/milk',
      headers: json,
      payload: { url: '1', quantity: 3 },
    })
    expect(response.json()).toEqual({ word: 'milk', stockcode: 1, quantity: 3, listing: 'Milk 2L' })
    expect(lookup.listing).not.toHaveBeenCalled()
  })

  it('backfills existing items in the background and lists them with their listing', async () => {
    await vi.waitFor(async () => expect((await readItems()).milk?.listing).toBe('Milk 2L'))
    const response = await app.inject({ method: 'GET', url: '/items', headers: json })
    expect(response.json().items).toEqual([
      { word: 'milk', stockcode: 1, quantity: 1, listing: 'Milk 2L' },
    ])
  })

  it('titles the product with its listing on the admin page', async () => {
    await vi.waitFor(async () => expect((await readItems()).milk?.listing).toBe('Milk 2L'))
    const response = await app.inject({ method: 'GET', url: '/', headers: json })
    expect(response.body).toContain('<strong class="view">Milk 2L</strong>')
  })
})

describe('admin with several users', () => {
  let dir: string
  let db: Awaited<ReturnType<typeof createTestDb>>
  let google: FakeGoogle
  let app: FastifyInstance
  let me: { authorization: string; accept: string }
  let you: { authorization: string; accept: string }
  const lookupFor = vi.fn((email: string) => ({
    listing: async () => `Listing for ${email}`,
  }))

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-admin-'))
    db = await createTestDb()
    const config = testConfig(dir)
    google = await FakeGoogle.create()
    app = buildApp(config, { sql: db.sql, fetch: google.fetch, lookup: lookupFor })
    const bearer = async (email: string) => ({
      authorization: `Bearer ${await signInClient(app, google, { overrides: { email } })}`,
      accept: 'application/json',
    })
    me = await bearer('me@example.com')
    you = await bearer('you@example.com')
  })

  afterEach(async () => {
    await app.close()
    await rm(dir, { recursive: true })
    await db.close()
  })

  const add = (headers: typeof me, word: string, url: string) =>
    app.inject({ method: 'POST', url: '/items', headers, payload: { word, url } })
  const list = async (headers: typeof me) =>
    (await app.inject({ method: 'GET', url: '/items', headers })).json()

  it('keeps each user their own items, looked up through their own account', async () => {
    await add(me, 'milk', '1')
    await add(you, 'milk', '2')
    await add(you, 'bread', '3')
    expect(await list(me)).toEqual({
      items: [{ word: 'milk', stockcode: 1, quantity: 1, listing: 'Listing for me@example.com' }],
    })
    expect((await list(you)).items).toHaveLength(2)
    expect(lookupFor).toHaveBeenCalledWith('you@example.com')
  })

  it("edits and removes only the signed-in user's items", async () => {
    await add(me, 'milk', '1')
    await add(you, 'milk', '2')
    await app.inject({
      method: 'PATCH',
      url: '/items/milk',
      headers: you,
      payload: { quantity: 5 },
    })
    await app.inject({ method: 'DELETE', url: '/items/milk', headers: me })
    expect((await list(me)).items).toEqual([])
    expect((await list(you)).items).toMatchObject([{ word: 'milk', stockcode: 2, quantity: 5 }])
  })

  it("shows the page only the signed-in user's items and sessions", async () => {
    await add(me, 'milk', '1')
    await add(you, 'oatmilk', '2')
    const cookie = await signInWeb(app, google, { email: 'you@example.com' })
    const get = async (url: string) =>
      (await app.inject({ method: 'GET', url, headers: { cookie } })).body
    const items = await get('/')
    expect(items).toContain('Oatmilk')
    expect(items).not.toContain('<strong class="view">Milk</strong>')
    const account = await get('/account')
    expect(account).toContain('you@example.com')
    expect(account).not.toContain('me@example.com')
  })

  it("does not let a user revoke another user's session", async () => {
    const cookie = await signInWeb(app, google, { email: 'you@example.com' })
    const [mine] = (await new TokenStore(db.sql).list()).filter(
      (session) => session.email === 'me@example.com',
    )
    const response = await app.inject({
      method: 'POST',
      url: `/sessions/${mine?.id}/revoke`,
      headers: { cookie, accept: 'application/json' },
    })
    expect(response.statusCode).toBe(204)
    expect((await list(me)).items).toEqual([])
  })

  describe('household', () => {
    const json = (token: string) => ({
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    })
    let mine: ReturnType<typeof json>
    let yours: ReturnType<typeof json>

    beforeEach(async () => {
      await seedItems(db.sql, 'milk:\n  stockcode: 123456\n  quantity: 1\n')
      mine = json(await signInClient(app, google))
      yours = json(await signInClient(app, google, { overrides: { email: 'you@example.com' } }))
    })

    const post = (headers: typeof mine, url: string, payload?: object) =>
      app.inject({
        method: 'POST',
        url: `/household${url}`,
        headers,
        ...(payload && { payload }),
      })

    it('lists members, invites one, and shares items on joining', async () => {
      const invite = await post(mine, '/invites')
      expect(invite.statusCode).toBe(201)
      const { code } = invite.json<{ code: string; expiresAt: number }>()
      expect((await post(yours, '/join', { code })).statusCode).toBe(204)
      const members = await app.inject({ method: 'GET', url: '/household', headers: yours })
      expect(members.json()).toEqual({
        members: [
          { email: 'me@example.com', you: false },
          { email: 'you@example.com', you: true },
        ],
      })
      const items = await app.inject({ method: 'GET', url: '/items', headers: yours })
      expect(items.json<{ items: { word: string }[] }>().items.map((item) => item.word)).toEqual([
        'milk',
      ])
    })

    it('rejects an invalid, missing or reused code', async () => {
      expect((await post(yours, '/join', { code: 'nope' })).statusCode).toBe(400)
      expect((await post(yours, '/join', {})).statusCode).toBe(400)
      const { code } = (await post(mine, '/invites')).json<{ code: string }>()
      expect((await post(mine, '/join', { code })).statusCode).toBe(409)
      expect((await post(yours, '/join', { code })).statusCode).toBe(204)
      expect((await post(yours, '/join', { code })).statusCode).toBe(400)
    })

    it('caps unexpired invites', async () => {
      const strict = buildApp(
        testConfig(dir, { limits: { ...DEFAULT_LIMITS, maxInvitesPerHousehold: 1 } }),
        { sql: db.sql, fetch: google.fetch },
      )
      const headers = json(await signInClient(strict, google))
      const create = () => strict.inject({ method: 'POST', url: '/household/invites', headers })
      expect((await create()).statusCode).toBe(201)
      expect((await create()).statusCode).toBe(409)
      await strict.close()
    })

    it('lets a member leave, but not a sole member', async () => {
      expect((await post(mine, '/leave')).statusCode).toBe(409)
      const { code } = (await post(mine, '/invites')).json<{ code: string }>()
      await post(yours, '/join', { code })
      expect((await post(yours, '/leave')).statusCode).toBe(204)
      const items = await app.inject({ method: 'GET', url: '/items', headers: yours })
      expect(items.json()).toEqual({ items: [] })
      const members = await app.inject({ method: 'GET', url: '/household', headers: mine })
      expect(members.json()).toEqual({ members: [{ email: 'me@example.com', you: true }] })
    })

    it('requires authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/household/invites',
        headers: { accept: 'application/json' },
      })
      expect(response.statusCode).toBe(401)
    })

    it('drives the household from the admin page', async () => {
      const cookie = { cookie: await signInWeb(app, google) }
      const form = (url: string, body = '') =>
        app.inject({
          method: 'POST',
          url,
          headers: { ...cookie, 'content-type': 'application/x-www-form-urlencoded' },
          payload: body,
        })
      const page = await form('/household/invites')
      expect(page.statusCode).toBe(201)
      expect(page.body).toContain('aria-current="page">Household</a>')
      expect(page.body).toContain('Join household')
      expect(page.body).not.toContain('Leave household')
      const code = /<code>([^<]+)<\/code>/.exec(page.body)?.[1] ?? ''
      expect(code).not.toBe('')
      const yourCookie = { cookie: await signInWeb(app, google, { email: 'you@example.com' }) }
      const join = await app.inject({
        method: 'POST',
        url: '/household/join',
        headers: { ...yourCookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: `code=${code}`,
      })
      expect(join.statusCode).toBe(302)
      expect(join.headers.location).toBe('/household/manage')
      const shown = await app.inject({
        method: 'GET',
        url: '/household/manage',
        headers: yourCookie,
      })
      expect(shown.body).toContain('me@example.com')
      expect(shown.body).toContain('Leave household')
      expect(shown.body).toMatch(
        /<button type="submit">Join household<\/button>\s*<button type="submit" class="secondary" formaction="\/household\/leave" formnovalidate>Leave household/,
      )
      const bad = await form('/household/join', 'code=nope')
      expect(bad.statusCode).toBe(400)
      expect(bad.body).toContain('invalid, expired or already used')
      expect(bad.body).toContain('aria-current="page">Household</a>')
      const left = await app.inject({
        method: 'POST',
        url: '/household/leave',
        headers: yourCookie,
      })
      expect(left.statusCode).toBe(302)
      expect(left.headers.location).toBe('/household/manage')
      const sole = await form('/household/leave')
      expect(sole.statusCode).toBe(409)
      expect(sole.body).toContain('nothing to leave')
      expect(sole.body).toContain('aria-current="page">Household</a>')
    })
  })

  it('limits each user per minute across /', async () => {
    const strict = buildApp(
      testConfig(dir, { limits: { ...DEFAULT_LIMITS, userRequestsPerMinute: 2 } }),
      { sql: db.sql, fetch: google.fetch },
    )
    const mine = {
      authorization: `Bearer ${await signInClient(strict, google)}`,
      accept: 'application/json',
    }
    const get = (headers: typeof mine) => strict.inject({ method: 'GET', url: '/items', headers })
    expect((await get(mine)).statusCode).toBe(200)
    expect((await get(mine)).statusCode).toBe(200)
    const limited = await get(mine)
    expect(limited.statusCode).toBe(429)
    expect(limited.headers['retry-after']).toBeDefined()
    const yours = {
      authorization: `Bearer ${await signInClient(strict, google, { overrides: { email: 'you@example.com' } })}`,
      accept: 'application/json',
    }
    expect((await get(yours)).statusCode).toBe(200)
    await strict.close()
  })
})
