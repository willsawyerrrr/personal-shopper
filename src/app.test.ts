import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import type { AppConfig } from './config.ts'
import { testConfig } from './testing/app.ts'

describe('buildApp', () => {
  let dir: string
  let config: AppConfig

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-app-'))
    config = testConfig(dir)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true })
  })

  it('answers the health check without authentication', async () => {
    const response = await buildApp(config).inject({ method: 'GET', url: '/healthz' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })

  it('has no voice webhook', async () => {
    const response = await buildApp(config).inject({
      method: 'POST',
      url: '/items',
      payload: { item: 'milk' },
    })
    expect(response.statusCode).toBe(404)
  })

  it('has no cart route without a cart client', async () => {
    const response = await buildApp(config).inject({
      method: 'POST',
      url: '/cart/items',
      payload: { item: 'milk' },
    })
    expect(response.statusCode).toBe(404)
  })

  it('keys rate limits on X-Forwarded-For when the proxy is trusted', async () => {
    const app = buildApp({ ...config, trustProxy: true })
    const send = (ip: string) =>
      app.inject({ method: 'POST', url: '/auth/token', headers: { 'x-forwarded-for': ip } })
    for (let i = 0; i < 30; i++) {
      await send('3.3.3.3')
    }
    expect((await send('3.3.3.3')).statusCode).toBe(429)
    expect((await send('4.4.4.4')).statusCode).not.toBe(429)
  })

  it('fails to start when the token store is corrupt', async () => {
    await writeFile(config.tokenStorePath, '{ nope')
    await expect(buildApp(config).ready()).rejects.toThrow()
  })
})
