import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.ts'
import type { AppConfig } from './config.ts'

const SECRET = 'correct-horse-battery-staple'

type LogLine = Record<string, unknown>

describe('logging', () => {
  let dir: string
  let config: AppConfig
  let output: string

  const logStream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      output += chunk.toString()
      callback()
    },
  })
  const lines = (): LogLine[] =>
    output
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LogLine)
  const rejections = (): LogLine[] => lines().filter((line) => line.msg === 'auth rejected')
  const build = (overrides: Partial<AppConfig> = {}) =>
    buildApp({ ...config, ...overrides }, { addToCart: vi.fn() }, logStream)
  const post = (app: ReturnType<typeof build>, headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/items?debug=1',
      payload: { item: 'milk' },
      headers: { 'user-agent': 'Shortcuts/1', ...headers },
      remoteAddress: '9.9.9.9',
    })
  const basic = (password: string) => `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`

  beforeEach(async () => {
    output = ''
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-logging-'))
    const itemsPath = join(dir, 'items.yml')
    await writeFile(itemsPath, 'milk:\n  stockcode: 123456\n  quantity: 1\n')
    config = {
      port: 0,
      logLevel: 'info',
      trustProxy: false,
      sharedSecret: SECRET,
      itemsPath,
      sessionPath: join(dir, 'session.json'),
      sessionKeepAliveIntervalMs: 0,
      passkeyCredentialsPath: 'passkey-credentials.json',
      remindersSync: undefined,
    }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe('auth rejections', () => {
    it('logs missing_authorization', async () => {
      await post(build(), {})
      expect(rejections()).toHaveLength(1)
      expect(rejections()[0]).toMatchObject({
        level: 40,
        reason: 'missing_authorization',
        route: '/items',
        method: 'POST',
        authScheme: 'none',
        tokenLength: 0,
        hasSurroundingWhitespace: false,
        matchesAfterTrim: false,
        userAgent: 'Shortcuts/1',
        ip: '9.9.9.9',
      })
      expect(rejections()[0]?.reqId).toEqual(expect.any(String))
    })

    it('logs unsupported_scheme without echoing a scheme-less credential', async () => {
      await post(build(), { authorization: 'Token abc' })
      await post(build(), { authorization: 'leaked-looking-credential' })
      expect(rejections().map((line) => [line.reason, line.authScheme])).toEqual([
        ['unsupported_scheme', 'other'],
        ['unsupported_scheme', 'other'],
      ])
      expect(output).not.toContain('leaked-looking-credential')
    })

    it('logs empty_token', async () => {
      await post(build(), { authorization: 'Bearer' })
      expect(rejections()[0]).toMatchObject({
        reason: 'empty_token',
        authScheme: 'Bearer',
        tokenLength: 0,
      })
    })

    it('logs secret_mismatch with the token length', async () => {
      await post(build(), { authorization: 'Bearer nope' })
      expect(rejections()[0]).toMatchObject({
        reason: 'secret_mismatch',
        authScheme: 'Bearer',
        tokenLength: 4,
        hasSurroundingWhitespace: false,
        matchesAfterTrim: false,
      })
    })

    it('flags a token that matches once trimmed', async () => {
      await post(build(), { authorization: `Bearer  ${SECRET}` })
      expect(rejections()[0]).toMatchObject({
        reason: 'secret_mismatch',
        tokenLength: SECRET.length + 1,
        hasSurroundingWhitespace: true,
        matchesAfterTrim: true,
      })
    })

    it('logs no_session for admin requests without credentials', async () => {
      const response = await build().inject({ method: 'GET', url: '/admin/items' })
      expect(response.statusCode).toBe(302)
      expect(rejections()[0]).toMatchObject({
        reason: 'no_session',
        route: '/admin/items',
        method: 'GET',
        authScheme: 'none',
      })
    })

    it('logs no_session for a stale session cookie on the JSON path', async () => {
      const response = await build().inject({
        method: 'GET',
        url: '/admin/items',
        headers: { accept: 'application/json', cookie: 'ps_admin_session=stale' },
      })
      expect(response.statusCode).toBe(401)
      expect(rejections()[0]).toMatchObject({ reason: 'no_session' })
    })

    it('logs admin Basic failures by reason', async () => {
      const app = build()
      const get = (authorization: string) =>
        app.inject({ method: 'GET', url: '/admin/items', headers: { authorization } })
      await get(`Bearer ${SECRET}`)
      await get('Basic')
      await get(basic('wrong'))
      await get(basic(` ${SECRET}`))
      expect(
        rejections().map((line) => [
          line.reason,
          line.authScheme,
          line.tokenLength,
          line.matchesAfterTrim,
        ]),
      ).toEqual([
        ['unsupported_scheme', 'Bearer', SECRET.length, true],
        ['empty_token', 'Basic', 0, false],
        ['secret_mismatch', 'Basic', 5, false],
        ['secret_mismatch', 'Basic', SECRET.length + 1, true],
      ])
    })

    it('accepts valid admin Basic credentials without logging a rejection', async () => {
      const response = await build().inject({
        method: 'GET',
        url: '/admin/items',
        headers: { authorization: basic(SECRET) },
      })
      expect(response.statusCode).toBe(200)
      expect(rejections()).toEqual([])
    })

    it('logs login_failed for a wrong or missing secret', async () => {
      const app = build()
      const login = (payload: string) =>
        app.inject({
          method: 'POST',
          url: '/admin/login',
          payload,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        })
      expect((await login('secret=wrong')).statusCode).toBe(401)
      expect((await login(`secret=${SECRET}%0A`)).statusCode).toBe(401)
      expect((await login('other=1')).statusCode).toBe(401)
      expect(rejections().map((line) => [line.reason, line.route, line.tokenLength])).toEqual([
        ['login_failed', '/admin/login', 5],
        ['login_failed', '/admin/login', SECRET.length + 1],
        ['login_failed', '/admin/login', 0],
      ])
      expect(rejections()[1]).toMatchObject({
        hasSurroundingWhitespace: true,
        matchesAfterTrim: true,
      })
    })
  })

  describe('redaction', () => {
    it('never writes the secret, supplied tokens, headers or cookies', async () => {
      const app = build()
      const sentinel = 'sentinel-token-value'
      await post(app, {
        authorization: `Bearer ${sentinel}`,
        cookie: 'ps_admin_session=cookie-sentinel',
      })
      await post(app, { authorization: `Bearer  ${SECRET}` })
      await app.inject({
        method: 'GET',
        url: '/admin/items',
        headers: { authorization: basic(sentinel), cookie: 'ps_admin_session=cookie-sentinel' },
      })
      await app.inject({
        method: 'POST',
        url: '/admin/login',
        payload: `secret=${sentinel}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      })
      expect(rejections()).toHaveLength(4)
      for (const text of [
        SECRET,
        sentinel,
        'cookie-sentinel',
        basic(sentinel).slice(6),
        'ps_admin_session',
      ]) {
        expect(output).not.toContain(text)
      }
      expect(output).not.toMatch(/authorization/i)
      expect(output).not.toMatch(/cookie/i)
    })
  })

  describe('request completion', () => {
    it('logs one line per request with method, path, status, timing, agent and ip', async () => {
      await post(build(), { authorization: `Bearer ${SECRET}` })
      const completed = lines().filter((line) => line.msg === 'request completed')
      expect(completed).toHaveLength(1)
      expect(completed[0]).toMatchObject({
        level: 30,
        method: 'POST',
        url: '/items',
        statusCode: 200,
        userAgent: 'Shortcuts/1',
        ip: '9.9.9.9',
      })
      expect(completed[0]?.responseTime).toEqual(expect.any(Number))
      expect(output).not.toContain('debug=1')
      expect(lines().some((line) => line.msg === 'incoming request')).toBe(false)
    })

    it('logs health checks at debug only', async () => {
      await build().inject({ method: 'GET', url: '/healthz' })
      expect(output).toBe('')
      await build({ logLevel: 'debug' }).inject({ method: 'GET', url: '/healthz' })
      expect(lines()).toMatchObject([{ level: 20, msg: 'request completed', url: '/healthz' }])
    })

    it('honours the configured level', async () => {
      await post(build({ logLevel: 'error' }), {})
      expect(output).toBe('')
    })
  })
})
