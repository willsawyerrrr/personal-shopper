import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
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
        name: 'Full Cream Milk',
        quantity: '2',
      },
    })
    expect(response.statusCode).toBe(302)
    const items = await readFile(config.itemsPath, 'utf8')
    expect(items).toContain('bread:')
    expect(items).toContain('888137')
    expect(items).toContain('Full Cream Milk')
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
          name: ' Bread ',
          quantity: 2,
        },
      })
      expect(response.statusCode).toBe(201)
      expect(response.json()).toEqual({
        word: 'bread',
        stockcode: 888137,
        quantity: 2,
        name: 'Bread',
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
