import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.ts'
import type { AppConfig } from './config.ts'
import type { CartClient } from './woolworths/client.ts'

describe('admin', () => {
  let dir: string
  let config: AppConfig
  let cart: CartClient
  const authHeader = { authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-admin-'))
    const itemsPath = join(dir, 'items.yml')
    await writeFile(itemsPath, 'milk:\n  stockcode: 123456\n  quantity: 1\n')
    config = {
      port: 0,
      trustProxy: false,
      sharedSecret: 'secret',
      itemsPath,
      sessionPath: join(dir, 'session.json'),
      sessionKeepAliveIntervalMs: 0,
      passkeyCredentialsPath: 'passkey-credentials.json',
      remindersSync: undefined,
    }
    cart = { addToCart: vi.fn() }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('rate limits login attempts per client', async () => {
    const app = buildApp(config, cart)
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/admin/login',
        payload: 'secret=wrong',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
    for (let i = 0; i < 10; i++) {
      expect((await attempt()).statusCode).toBe(401)
    }
    expect((await attempt()).statusCode).toBe(429)
  })

  it('marks the session cookie Secure only over HTTPS', async () => {
    const app = buildApp({ ...config, trustProxy: true }, cart)
    const login = (proto: string) =>
      app.inject({
        method: 'POST',
        url: '/admin/login',
        payload: 'secret=secret',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-forwarded-proto': proto,
        },
      })
    expect(String((await login('https')).headers['set-cookie'])).toContain('; Secure')
    expect(String((await login('http')).headers['set-cookie'])).not.toContain('Secure')
  })

  it('serves the login page', async () => {
    const app = buildApp(config, cart)
    const response = await app.inject({ method: 'GET', url: '/admin/login' })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('Shared secret')
  })

  it('redirects unauthenticated browser requests to the login page', async () => {
    const app = buildApp(config, cart)
    const response = await app.inject({ method: 'GET', url: '/admin' })
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/admin/login')
  })

  it('rejects unauthenticated API requests', async () => {
    const app = buildApp(config, cart)
    const response = await app.inject({ method: 'POST', url: '/admin/items', payload: {} })
    expect(response.statusCode).toBe(401)
  })

  it('signs in with the shared secret and sets a session cookie', async () => {
    const app = buildApp(config, cart)
    const response = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { secret: 'secret' },
    })
    expect(response.statusCode).toBe(302)
    expect(response.headers.location).toBe('/admin')
    const cookie = response.headers['set-cookie']
    expect(cookie).toContain('ps_admin_session=')

    const authed = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { cookie: String(cookie).split(';')[0] },
    })
    expect(authed.statusCode).toBe(200)
  })

  it('rejects sign-in with the wrong secret', async () => {
    const app = buildApp(config, cart)
    const response = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { secret: 'wrong' },
    })
    expect(response.statusCode).toBe(401)
    expect(response.body).toContain('Incorrect secret')
  })

  it('logs out by clearing the session cookie', async () => {
    const app = buildApp(config, cart)
    const login = await app.inject({
      method: 'POST',
      url: '/admin/login',
      payload: { secret: 'secret' },
    })
    const sessionCookie = String(login.headers['set-cookie']).split(';')[0]

    const logout = await app.inject({
      method: 'POST',
      url: '/admin/logout',
      headers: { cookie: sessionCookie },
    })
    expect(logout.statusCode).toBe(302)
    expect(logout.headers.location).toBe('/admin/login')

    const afterLogout = await app.inject({
      method: 'GET',
      url: '/admin',
      headers: { cookie: sessionCookie },
    })
    expect(afterLogout.statusCode).toBe(302)
  })

  it('lists existing items', async () => {
    const app = buildApp(config, cart)
    const response = await app.inject({ method: 'GET', url: '/admin', headers: authHeader })
    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('milk')
    expect(response.body).toContain('123456')
  })

  it('adds an item from a product URL', async () => {
    const app = buildApp(config, cart)
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
    const app = buildApp(config, cart)
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
    const app = buildApp(config, cart)
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
    const app = buildApp(config, cart)
    const response = await app.inject({
      method: 'POST',
      url: '/admin/items/milk/delete',
      headers: authHeader,
    })
    expect(response.statusCode).toBe(302)
    const items = await readFile(config.itemsPath, 'utf8')
    expect(items).not.toContain('milk:')
  })
})
