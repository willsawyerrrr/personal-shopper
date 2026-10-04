import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { DEFAULT_LIMITS, type AppConfig } from './config.ts'
import { IOS_REDIRECT, pkcePair, signInClient, signInWeb, testConfig } from './testing/app.ts'
import { createTestDb } from './testing/db.ts'
import { CLIENT_SECRET, FakeGoogle } from './testing/google.ts'

type LogLine = Record<string, unknown>

describe('logging', () => {
  let dir: string
  let config: AppConfig
  let db: Awaited<ReturnType<typeof createTestDb>>
  let google: FakeGoogle
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
    buildApp(
      { ...config, logLevel: 'info', ...overrides },
      { sql: db.sql, logStream, fetch: google.fetch },
    )
  const get = (app: ReturnType<typeof build>, headers: Record<string, string>) =>
    app.inject({
      method: 'GET',
      url: '/items?debug=1',
      headers: { 'user-agent': 'PersonalShopper/1', accept: 'application/json', ...headers },
      remoteAddress: '9.9.9.9',
    })

  beforeEach(async () => {
    output = ''
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-logging-'))
    config = testConfig(dir)
    db = await createTestDb()
    google = await FakeGoogle.create()
  })

  afterEach(async () => {
    await rm(dir, { recursive: true })
    await db.close()
  })

  describe('auth rejections', () => {
    it('logs missing_authorization', async () => {
      await get(build(), {})
      expect(rejections()).toHaveLength(1)
      expect(rejections()[0]).toMatchObject({
        level: 40,
        reason: 'missing_authorization',
        route: '/items',
        method: 'GET',
        authScheme: 'none',
        tokenLength: 0,
        hasSurroundingWhitespace: false,
        userAgent: 'PersonalShopper/1',
        ip: '9.9.9.9',
      })
      expect(rejections()[0]?.reqId).toEqual(expect.any(String))
    })

    it('logs unsupported_scheme without echoing a scheme-less credential', async () => {
      const app = build()
      await get(app, { authorization: 'Token abc' })
      await get(app, { authorization: 'leaked-looking-credential' })
      await get(app, {
        authorization: `Basic ${Buffer.from('admin:old-secret').toString('base64')}`,
      })
      expect(rejections().map((line) => [line.reason, line.authScheme])).toEqual([
        ['unsupported_scheme', 'other'],
        ['unsupported_scheme', 'other'],
        ['unsupported_scheme', 'Basic'],
      ])
      expect(output).not.toContain('leaked-looking-credential')
    })

    it('logs empty_token', async () => {
      await get(build(), { authorization: 'Bearer' })
      expect(rejections()[0]).toMatchObject({
        reason: 'empty_token',
        authScheme: 'Bearer',
        tokenLength: 0,
      })
    })

    it('logs invalid_token with the token length and whitespace', async () => {
      const app = build()
      await get(app, { authorization: 'Bearer nope' })
      await get(app, { authorization: 'Bearer  nope' })
      expect(rejections()[0]).toMatchObject({
        reason: 'invalid_token',
        authScheme: 'Bearer',
        tokenLength: 4,
        hasSurroundingWhitespace: false,
      })
      expect(rejections()[1]).toMatchObject({ tokenLength: 5, hasSurroundingWhitespace: true })
    })

    it('logs invalid_token for a stale session cookie', async () => {
      const response = await get(build(), { cookie: 'ps_admin_session=stale' })
      expect(response.statusCode).toBe(401)
      expect(rejections()[0]).toMatchObject({ reason: 'invalid_token', authScheme: 'cookie' })
    })

    it('logs expired_token', async () => {
      let clock = Date.now()
      const app = buildApp(
        { ...config, logLevel: 'info' },
        { sql: db.sql, logStream, fetch: google.fetch, now: () => clock },
      )
      const token = await signInClient(app, google)
      clock += 91 * 24 * 60 * 60 * 1000
      await get(app, { authorization: `Bearer ${token}` })
      expect(rejections()[0]).toMatchObject({ reason: 'expired_token', authScheme: 'Bearer' })
    })

    it('logs signup_closed for a new account beyond the user cap', async () => {
      const app = build({ limits: { ...DEFAULT_LIMITS, maxUsers: 1 } })
      await signInWeb(app, google)
      await signInWeb(app, google, { email: 'stranger@example.com' })
      expect(rejections()[0]).toMatchObject({
        reason: 'signup_closed',
        route: '/auth/google/callback',
      })
      expect(output).not.toContain('stranger@example.com')
    })

    it('logs user_limit when a user already holds the maximum of tokens', async () => {
      const app = build({ limits: { ...DEFAULT_LIMITS, maxTokensPerUser: 1 } })
      await signInClient(app, google)
      await signInClient(app, google)
      expect(rejections()[0]).toMatchObject({ reason: 'user_limit', route: '/auth/token' })
    })

    it('logs invalid_state for an unknown callback state', async () => {
      await build().inject({ method: 'GET', url: '/auth/google/callback?code=c&state=forged' })
      expect(rejections()[0]).toMatchObject({ reason: 'invalid_state', authScheme: 'none' })
    })

    it('logs login_failed with the detail', async () => {
      const app = build()
      const login = await app.inject({ method: 'GET', url: '/auth/google/login' })
      const { code, state } = google.approve(String(login.headers.location), {
        audience: 'someone-else',
      })
      await app.inject({
        method: 'GET',
        url: `/auth/google/callback?${new URLSearchParams({ code, state })}`,
      })
      expect(rejections()[0]).toMatchObject({
        reason: 'login_failed',
        detail: 'invalid_id_token',
      })
    })

    it('logs invalid_request and invalid_grant', async () => {
      const app = build()
      await app.inject({ method: 'GET', url: '/auth/start' })
      await app.inject({
        method: 'POST',
        url: '/auth/token',
        payload: { code: 'nope', code_verifier: pkcePair().verifier },
      })
      expect(rejections().map((line) => line.reason)).toEqual(['invalid_request', 'invalid_grant'])
    })

    it('does not log accepted requests as rejections', async () => {
      const app = build()
      const token = await signInClient(app, google)
      const response = await get(app, { authorization: `Bearer ${token}` })
      expect(response.statusCode).toBe(200)
      expect(rejections()).toEqual([])
    })
  })

  describe('redaction', () => {
    it('never writes tokens, codes, secrets, headers or cookies', async () => {
      const app = build()
      const sentinel = 'sentinel-token-value'
      const bearer = await signInClient(app, google)
      const cookie = await signInWeb(app, google)
      const { verifier, challenge } = pkcePair()
      const start = await app.inject({
        method: 'GET',
        url: `/auth/start?${new URLSearchParams({
          client: 'ios',
          redirect_uri: IOS_REDIRECT,
          code_challenge: challenge,
          state: 'client-state-sentinel',
        })}`,
      })
      const authorizationUrl = String(start.headers.location)
      const approved = google.approve(authorizationUrl)
      const callback = await app.inject({
        method: 'GET',
        url: `/auth/google/callback?${new URLSearchParams(approved)}`,
      })
      const authCode = new URL(String(callback.headers.location)).searchParams.get('code') ?? ''
      await app.inject({
        method: 'POST',
        url: '/auth/token',
        payload: { code: authCode, code_verifier: verifier },
      })
      await app.inject({
        method: 'POST',
        url: '/auth/token',
        payload: { code: authCode, code_verifier: verifier },
      })
      await get(app, {
        authorization: `Bearer ${sentinel}`,
        cookie: 'ps_admin_session=cookie-sentinel',
      })
      await get(app, { authorization: `Bearer ${bearer}`, cookie })
      await app.inject({
        method: 'GET',
        url: '/auth/google/callback?code=google-code-sentinel&state=forged',
      })
      await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { authorization: `Bearer ${sentinel}` },
      })

      const authorization = new URL(authorizationUrl).searchParams
      const forbidden = [
        CLIENT_SECRET,
        sentinel,
        'cookie-sentinel',
        'google-code-sentinel',
        'client-state-sentinel',
        bearer,
        cookie.split('=')[1] ?? '',
        authCode,
        verifier,
        approved.code,
        authorization.get('state') ?? '',
        authorization.get('nonce') ?? '',
        'ps_admin_session',
      ]
      for (const text of forbidden) {
        expect(text).not.toBe('')
        expect(output).not.toContain(text)
      }
      expect(output).not.toMatch(/authorization/i)
      expect(output).not.toMatch(/cookie/i)
      expect(output).not.toMatch(/\bid_token|eyJ/)
      expect(rejections().length).toBeGreaterThanOrEqual(4)
    })
  })

  describe('request completion', () => {
    it('logs one line per request with method, path, status, timing, agent and ip', async () => {
      const app = build()
      const token = await signInClient(app, google)
      output = ''
      await get(app, { authorization: `Bearer ${token}` })
      const completed = lines().filter((line) => line.msg === 'request completed')
      expect(completed).toHaveLength(1)
      expect(completed[0]).toMatchObject({
        level: 30,
        method: 'GET',
        url: '/items',
        statusCode: 200,
        userAgent: 'PersonalShopper/1',
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
      await get(build({ logLevel: 'error' }), {})
      expect(output).toBe('')
    })
  })
})
