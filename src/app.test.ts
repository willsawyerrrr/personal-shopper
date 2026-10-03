import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.ts'
import type { AppConfig } from './config.ts'
import type { CartClient } from './woolworths/client.ts'

describe('buildApp', () => {
  let dir: string
  let config: AppConfig
  let cart: CartClient

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-app-'))
    const itemsPath = join(dir, 'items.yml')
    await writeFile(itemsPath, 'milk:\n  stockcode: 123456\n  quantity: 1\n')
    config = {
      port: 0,
      logLevel: 'info',
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

  it('answers the health check without authentication', async () => {
    const app = buildApp(config, cart)
    const response = await app.inject({ method: 'GET', url: '/healthz' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })

  it('rate limits the webhook per client', async () => {
    const app = buildApp(config, cart)
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/items',
        payload: { item: 'milk' },
        remoteAddress: '1.1.1.1',
      })
    for (let i = 0; i < 30; i++) {
      expect((await send()).statusCode).toBe(401)
    }
    expect((await send()).statusCode).toBe(429)
    const other = await app.inject({
      method: 'POST',
      url: '/items',
      payload: { item: 'milk' },
      remoteAddress: '2.2.2.2',
    })
    expect(other.statusCode).toBe(401)
  })

  it('keys rate limits on X-Forwarded-For when the proxy is trusted', async () => {
    const app = buildApp({ ...config, trustProxy: true }, cart)
    const send = (ip: string) =>
      app.inject({
        method: 'POST',
        url: '/items',
        payload: { item: 'milk' },
        headers: { 'x-forwarded-for': ip },
      })
    for (let i = 0; i < 30; i++) {
      await send('3.3.3.3')
    }
    expect((await send('3.3.3.3')).statusCode).toBe(429)
    expect((await send('4.4.4.4')).statusCode).toBe(401)
  })

  it('rejects requests without the shared secret', async () => {
    const app = buildApp(config, cart)
    const response = await app.inject({ method: 'POST', url: '/items', payload: { item: 'milk' } })
    expect(response.statusCode).toBe(401)
  })

  it('adds a mapped item to the cart', async () => {
    const app = buildApp(config, cart)
    const response = await app.inject({
      method: 'POST',
      url: '/items',
      headers: { authorization: 'Bearer secret' },
      payload: { item: ' Milk ' },
    })
    expect(response.statusCode).toBe(200)
    expect(cart.addToCart).toHaveBeenCalledWith(123456, 1)
  })

  it('404s for an unmapped item', async () => {
    const app = buildApp(config, cart)
    const response = await app.inject({
      method: 'POST',
      url: '/items',
      headers: { authorization: 'Bearer secret' },
      payload: { item: 'bread' },
    })
    expect(response.statusCode).toBe(404)
    expect(cart.addToCart).not.toHaveBeenCalled()
  })
})
