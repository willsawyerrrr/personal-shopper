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
