import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app.ts'
import { DEFAULT_LIMITS, type AppConfig } from './config.ts'
import {
  EXTENSION_REDIRECT,
  IOS_REDIRECT,
  pkcePair,
  signInClient,
  signInWeb,
  testConfig,
} from './testing/app.ts'
import { createTestDb } from './testing/db.ts'
import { FakeGoogle } from './testing/google.ts'

const DAY = 24 * 60 * 60 * 1000

describe('Google sign-in', () => {
  let dir: string
  let config: AppConfig
  let db: Awaited<ReturnType<typeof createTestDb>>
  let google: FakeGoogle
  let clock: number
  let apps: ReturnType<typeof buildApp>[]
  const build = (overrides: Partial<AppConfig> = {}) => {
    const app = buildApp(
      { ...config, ...overrides },
      { sql: db.sql, fetch: google.fetch, now: () => clock },
    )
    apps.push(app)
    return app
  }
  const startUrl = (params: Record<string, string>) =>
    `/auth/start?${new URLSearchParams({
      client: 'ios',
      redirect_uri: IOS_REDIRECT,
      code_challenge: pkcePair().challenge,
      state: 's',
      ...params,
    })}`
  const callback = (app: ReturnType<typeof build>, params: Record<string, string>) =>
    app.inject({ method: 'GET', url: `/auth/google/callback?${new URLSearchParams(params)}` })
  const redirectParams = (location: unknown) => new URL(String(location)).searchParams

  beforeEach(async () => {
    apps = []
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-login-'))
    db = await createTestDb()
    clock = Date.now()
    google = await FakeGoogle.create(() => clock)
    config = testConfig(dir)
  })

  afterEach(async () => {
    await Promise.all(apps.map((app) => app.close()))
    await rm(dir, { recursive: true })
    await db.close()
  })

  describe('browser flow', () => {
    it('sends the browser to Google with PKCE, state and nonce', async () => {
      const response = await build().inject({ method: 'GET', url: '/auth/google/login' })
      expect(response.statusCode).toBe(302)
      const location = new URL(String(response.headers.location))
      expect(`${location.origin}${location.pathname}`).toBe(
        'https://accounts.google.com/o/oauth2/v2/auth',
      )
      expect(Object.fromEntries(location.searchParams)).toMatchObject({
        client_id: config.googleClientId,
        redirect_uri: 'https://shop.example.com/auth/google/callback',
        response_type: 'code',
        scope: 'openid email',
        code_challenge_method: 'S256',
      })
      for (const name of ['state', 'nonce', 'code_challenge']) {
        expect(location.searchParams.get(name)?.length).toBeGreaterThanOrEqual(43)
      }
    })

    it('signs in an allowed account and sets a hardened session cookie', async () => {
      const app = build()
      const login = await app.inject({ method: 'GET', url: '/auth/google/login' })
      const { code, state } = google.approve(String(login.headers.location))
      const response = await callback(app, { code, state })
      expect(response.statusCode).toBe(302)
      expect(response.headers.location).toBe('/')
      const cookie = String(response.headers['set-cookie'])
      expect(cookie).toContain('HttpOnly')
      expect(cookie).toContain('SameSite=Lax')
      expect(cookie).toContain('Secure')
      const admin = await app.inject({
        method: 'GET',
        url: '/',
        headers: { cookie: cookie.split(';')[0] ?? '' },
      })
      expect(admin.statusCode).toBe(200)
    })

    it('omits Secure when the public URL is plain HTTP', async () => {
      const app = build({ publicBaseUrl: 'http://localhost:3000' })
      const login = await app.inject({ method: 'GET', url: '/auth/google/login' })
      const { code, state } = google.approve(String(login.headers.location))
      const response = await callback(app, { code, state })
      expect(String(response.headers['set-cookie'])).not.toContain('Secure')
    })

    it('signs up any account until the user cap, case-insensitively for existing ones', async () => {
      const app = build({ limits: { ...DEFAULT_LIMITS, maxUsers: 2 } })
      expect(await signInWeb(app, google, { email: 'ME@Example.com' })).toContain('ps_')
      expect(await signInWeb(app, google, { email: 'me@example.com' })).toContain('ps_')
      expect(await signInWeb(app, google, { email: 'new@example.com' })).toContain('ps_')
      const login = await app.inject({ method: 'GET', url: '/auth/google/login' })
      const { code, state } = google.approve(String(login.headers.location), {
        email: 'stranger@example.com',
      })
      const response = await callback(app, { code, state })
      expect(response.statusCode).toBe(403)
      expect(response.headers['set-cookie']).toBeUndefined()
      expect(response.body).toContain('Sign-ups are closed')
      expect(await db.sql`select 1 from users`).toHaveLength(2)
    })

    it('creates a user on first sign-in and none for a repeat sign-in', async () => {
      const app = build()
      await signInWeb(app, google, { email: 'new@example.com' })
      await signInWeb(app, google, { email: 'new@example.com' })
      const users = await db.sql`select email from users`
      expect(users.map((user) => user.email)).toEqual(['new@example.com'])
    })

    it('refuses a sign-in while the user holds the maximum of tokens', async () => {
      const app = build({ limits: { ...DEFAULT_LIMITS, maxTokensPerUser: 1 } })
      expect(await signInWeb(app, google)).toContain('ps_')
      const login = await app.inject({ method: 'GET', url: '/auth/google/login' })
      const { code, state } = google.approve(String(login.headers.location))
      const response = await callback(app, { code, state })
      expect(response.statusCode).toBe(403)
      expect(response.body).toContain('Too many active sign-ins')
      expect(response.headers['set-cookie']).toBeUndefined()
    })

    it('rejects an unverified email', async () => {
      const app = build()
      const login = await app.inject({ method: 'GET', url: '/auth/google/login' })
      const { code, state } = google.approve(String(login.headers.location), {
        emailVerified: false,
      })
      expect((await callback(app, { code, state })).statusCode).toBe(401)
    })

    it('rejects a string email_verified', async () => {
      const app = build()
      const login = await app.inject({ method: 'GET', url: '/auth/google/login' })
      const { code, state } = google.approve(String(login.headers.location), {
        emailVerified: 'true',
      })
      expect((await callback(app, { code, state })).statusCode).toBe(401)
    })

    it.each([
      ['audience', { audience: 'someone-else' }],
      ['issuer', { issuer: 'https://evil.example.com' }],
      ['nonce', { nonce: 'replayed-nonce' }],
      ['expiry', { expiresIn: -120 }],
      ['signature', { signWithOtherKey: true }],
    ])('rejects an ID token with the wrong %s', async (_name, overrides) => {
      const app = build()
      const login = await app.inject({ method: 'GET', url: '/auth/google/login' })
      const { code, state } = google.approve(String(login.headers.location), overrides)
      const response = await callback(app, { code, state })
      expect(response.statusCode).toBe(401)
      expect(response.headers['set-cookie']).toBeUndefined()
    })

    it('accepts either Google issuer form', async () => {
      const app = build()
      expect(await signInWeb(app, google, { issuer: 'accounts.google.com' })).toContain('ps_')
    })

    it('rejects an unknown, missing or reused state', async () => {
      const app = build()
      const login = await app.inject({ method: 'GET', url: '/auth/google/login' })
      const { code, state } = google.approve(String(login.headers.location))
      expect((await callback(app, { code, state: 'forged' })).statusCode).toBe(400)
      expect((await callback(app, { code })).statusCode).toBe(400)
      expect((await callback(app, { code, state })).statusCode).toBe(302)
      const reused = await callback(app, { code, state })
      expect(reused.statusCode).toBe(400)
      expect(reused.body).toContain('expired or was already used')
    })

    it('rejects a state after it expires', async () => {
      const app = build()
      const login = await app.inject({ method: 'GET', url: '/auth/google/login' })
      const { code, state } = google.approve(String(login.headers.location))
      clock += 11 * 60 * 1000
      expect((await callback(app, { code, state })).statusCode).toBe(400)
    })

    it('burns the state even when Google reports an error', async () => {
      const app = build()
      const login = await app.inject({ method: 'GET', url: '/auth/google/login' })
      const { code, state } = google.approve(String(login.headers.location))
      expect((await callback(app, { error: 'access_denied', state })).statusCode).toBe(401)
      expect((await callback(app, { code, state })).statusCode).toBe(400)
    })

    it('fails the sign-in when Google cannot be reached', async () => {
      const app = build()
      const login = await app.inject({ method: 'GET', url: '/auth/google/login' })
      const { code, state } = google.approve(String(login.headers.location))
      google.tokenEndpointDown = true
      expect((await callback(app, { code, state })).statusCode).toBe(401)
    })

    it('reuses cached signing keys and refetches after a rotation', async () => {
      const app = build()
      await signInWeb(app, google)
      await signInWeb(app, google)
      const jwksFetches = () => google.requests.filter((r) => r.url.endsWith('/certs')).length
      expect(jwksFetches()).toBe(1)
      await google.rotateKey()
      expect(await signInWeb(app, google)).toContain('ps_')
      expect(jwksFetches()).toBe(2)
    })

    it('sends the PKCE verifier and client secret to Google', async () => {
      await signInWeb(build(), google)
      const body = google.requests.find((r) => r.url.endsWith('/token'))?.body
      expect(body?.get('client_secret')).toBe(config.googleClientSecret)
      expect(body?.get('code_verifier')?.length).toBeGreaterThanOrEqual(43)
    })
  })

  describe('API client flow', () => {
    it('begins Google sign-in for an allowed redirect URI', async () => {
      const response = await build().inject({ method: 'GET', url: startUrl({}) })
      expect(response.statusCode).toBe(302)
      expect(String(response.headers.location)).toContain('accounts.google.com')
    })

    it.each([
      ['an unlisted redirect URI', { redirect_uri: 'https://evil.example.com/' }],
      ['a near-miss redirect URI', { redirect_uri: `${IOS_REDIRECT}/extra` }],
      ['an unknown client', { client: 'web' }],
      ['no client', { client: '' }],
      ['a malformed code challenge', { code_challenge: 'short' }],
      ['a non-S256 method', { code_challenge_method: 'plain' }],
      ['no state', { state: '' }],
      ['an oversized state', { state: 'x'.repeat(513) }],
    ])('rejects %s', async (_name, params) => {
      const response = await build().inject({ method: 'GET', url: startUrl(params) })
      expect(response.statusCode).toBe(400)
      expect(response.headers.location).toBeUndefined()
    })

    it('accepts the extension redirect URI', async () => {
      const response = await build().inject({
        method: 'GET',
        url: startUrl({ client: 'extension', redirect_uri: EXTENSION_REDIRECT }),
      })
      expect(response.statusCode).toBe(302)
    })

    it('returns a one-time code and the client state to the redirect URI', async () => {
      const app = build()
      const start = await app.inject({ method: 'GET', url: startUrl({ state: 'abc 123' }) })
      const { code, state } = google.approve(String(start.headers.location))
      const response = await callback(app, { code, state })
      expect(response.statusCode).toBe(302)
      const location = String(response.headers.location)
      expect(location.startsWith(`${IOS_REDIRECT}?`)).toBe(true)
      const params = redirectParams(location)
      expect(params.get('state')).toBe('abc 123')
      expect(params.get('code')?.length).toBeGreaterThanOrEqual(43)
      expect(response.headers['set-cookie']).toBeUndefined()
    })

    it('returns the error and state to the redirect URI when sign-ups are closed', async () => {
      const app = build({ limits: { ...DEFAULT_LIMITS, maxUsers: 1 } })
      await signInClient(app, google)
      const start = await app.inject({ method: 'GET', url: startUrl({ state: 'xyz' }) })
      const { code, state } = google.approve(String(start.headers.location), {
        email: 'stranger@example.com',
      })
      const response = await callback(app, { code, state })
      expect(response.statusCode).toBe(302)
      const params = redirectParams(response.headers.location)
      expect(params.get('error')).toBe('signup_closed')
      expect(params.get('state')).toBe('xyz')
      expect(params.get('code')).toBeNull()
    })

    it('redeems the code with the PKCE verifier for a bearer token', async () => {
      const app = build()
      const token = await signInClient(app, google)
      expect(token).toMatch(/^ps_/)
      const items = await app.inject({
        method: 'GET',
        url: '/items',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
      expect(items.statusCode).toBe(200)
    })

    it('reports a 90-day expiry and forbids caching', async () => {
      const app = build()
      const { verifier, challenge } = pkcePair()
      const start = await app.inject({
        method: 'GET',
        url: startUrl({ code_challenge: challenge }),
      })
      const approved = google.approve(String(start.headers.location))
      const cb = await callback(app, approved)
      const code = redirectParams(cb.headers.location).get('code')
      const response = await app.inject({
        method: 'POST',
        url: '/auth/token',
        payload: { code, code_verifier: verifier },
      })
      expect(response.statusCode).toBe(200)
      expect(response.headers['cache-control']).toBe('no-store')
      const body = response.json<{ access_token: string; expires_at: string }>()
      expect(Date.parse(body.expires_at)).toBe(clock + 90 * DAY)
    })

    describe('code redemption', () => {
      let app: ReturnType<typeof build>
      let code: string
      let verifier: string
      const redeem = (payload: unknown) =>
        app.inject({
          method: 'POST',
          url: '/auth/token',
          payload: JSON.stringify(payload),
          headers: { 'content-type': 'application/json' },
        })

      beforeEach(async () => {
        app = build()
        const pair = pkcePair()
        verifier = pair.verifier
        const start = await app.inject({
          method: 'GET',
          url: startUrl({ code_challenge: pair.challenge }),
        })
        const cb = await callback(app, google.approve(String(start.headers.location)))
        code = redirectParams(cb.headers.location).get('code') ?? ''
      })

      it('rejects a reused code', async () => {
        expect((await redeem({ code, code_verifier: verifier })).statusCode).toBe(200)
        const again = await redeem({ code, code_verifier: verifier })
        expect(again.statusCode).toBe(400)
        expect(again.json()).toEqual({ error: 'invalid_grant' })
      })

      it('rejects a wrong verifier and burns the code', async () => {
        expect((await redeem({ code, code_verifier: pkcePair().verifier })).statusCode).toBe(400)
        expect((await redeem({ code, code_verifier: verifier })).statusCode).toBe(400)
      })

      it('rejects a malformed verifier', async () => {
        expect((await redeem({ code, code_verifier: 'short' })).statusCode).toBe(400)
      })

      it('rejects an unknown code', async () => {
        expect((await redeem({ code: 'nope', code_verifier: verifier })).statusCode).toBe(400)
      })

      it('rejects an expired code', async () => {
        clock += 61 * 1000
        expect((await redeem({ code, code_verifier: verifier })).statusCode).toBe(400)
      })

      it('refuses to issue a token beyond the per-user cap', async () => {
        const app = build({ limits: { ...DEFAULT_LIMITS, maxTokensPerUser: 1 } })
        await signInClient(app, google)
        const { verifier, challenge } = pkcePair()
        const start = await app.inject({
          method: 'GET',
          url: startUrl({ code_challenge: challenge }),
        })
        const approved = google.approve(String(start.headers.location))
        const response = await callback(app, approved)
        const authCode = redirectParams(response.headers.location).get('code')
        const token = await app.inject({
          method: 'POST',
          url: '/auth/token',
          payload: { code: authCode, code_verifier: verifier },
        })
        expect(token.statusCode).toBe(403)
        expect(token.json()).toEqual({ error: 'user_limit' })
      })

      it.each([[{}], [{ code: 1, code_verifier: 2 }], [{ code: 'x' }], [null]])(
        'rejects a malformed body %j',
        async (payload) => {
          const response = await redeem(payload)
          expect(response.statusCode).toBe(400)
          expect(response.json()).toEqual({ error: 'invalid_request' })
        },
      )
    })
  })

  describe('bearer tokens', () => {
    it('authorises the JSON API until revoked by /auth/logout', async () => {
      const app = build()
      const token = await signInClient(app, google)
      const headers = { authorization: `Bearer ${token}`, accept: 'application/json' }
      expect((await app.inject({ method: 'GET', url: '/items', headers })).statusCode).toBe(200)
      const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers })
      expect(logout.statusCode).toBe(204)
      expect((await app.inject({ method: 'GET', url: '/items', headers })).statusCode).toBe(401)
      expect((await app.inject({ method: 'POST', url: '/auth/logout', headers })).statusCode).toBe(
        401,
      )
    })

    it('rejects the token once its 90-day sliding window lapses', async () => {
      const app = build()
      const token = await signInClient(app, google)
      const get = () =>
        app.inject({
          method: 'GET',
          url: '/items',
          headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        })
      clock += 80 * DAY
      expect((await get()).statusCode).toBe(200)
      clock += 80 * DAY
      expect((await get()).statusCode).toBe(200)
      clock += 91 * DAY
      expect((await get()).statusCode).toBe(401)
    })

    it('keeps tokens across a restart', async () => {
      const token = await signInClient(build(), google)
      const restarted = build()
      await restarted.ready()
      const response = await restarted.inject({
        method: 'GET',
        url: '/items',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      })
      expect(response.statusCode).toBe(200)
    })

    it('does not accept the session cookie on /auth/logout', async () => {
      const app = build()
      const cookie = await signInWeb(app, google)
      expect(
        (await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } })).statusCode,
      ).toBe(401)
    })
  })

  describe('rate limiting', () => {
    it.each([
      ['GET', '/auth/google/login'],
      ['GET', '/auth/start'],
      ['GET', '/auth/google/callback'],
      ['POST', '/auth/token'],
      ['POST', '/auth/logout'],
    ] as const)('limits %s %s per client', async (method, url) => {
      const app = build()
      const send = (remoteAddress: string) => app.inject({ method, url, remoteAddress })
      for (let i = 0; i < 30; i++) {
        expect((await send('1.1.1.1')).statusCode).not.toBe(429)
      }
      expect((await send('1.1.1.1')).statusCode).toBe(429)
      expect((await send('2.2.2.2')).statusCode).not.toBe(429)
    })
  })
})
