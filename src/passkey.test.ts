import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.ts'
import { selectCredential } from './passkey.ts'
import { signInClient, signInWeb, testConfig } from './testing/app.ts'
import { createTestDb } from './testing/db.ts'
import { FakeGoogle } from './testing/google.ts'
import { CredentialStore } from './users/credentials.ts'
import { PgSessionStorage } from './users/sessions.ts'
import { UserWoolworths } from './users/woolworths.ts'
import { passkeyLogin } from './woolworths/passkey.ts'
import type { StoredSession } from './woolworths/session.ts'

vi.mock('./woolworths/passkey.ts', () => ({ passkeyLogin: vi.fn() }))

const session = (aref: string): StoredSession => ({
  cookies: [{ name: 'w-aref', value: aref }],
  capturedAt: new Date().toISOString(),
})

const pkcs8 = (type: 'ed25519' | 'ec' | 'rsa' | 'x25519'): string => {
  const { privateKey } =
    type === 'ec'
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : type === 'rsa'
        ? generateKeyPairSync('rsa', { modulusLength: 2048 })
        : type === 'ed25519'
          ? generateKeyPairSync('ed25519')
          : generateKeyPairSync('x25519')
  return privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64')
}

const credential = (overrides: Record<string, unknown> = {}) => ({
  credentialId: 'Y3JlZA==',
  isResidentCredential: true,
  rpId: 'auth.woolworths.com.au',
  privateKey: pkcs8('ec'),
  userHandle: 'dXNlcg==',
  signCount: 1,
  ...overrides,
})

describe('selectCredential', () => {
  it('accepts a credential object', () => {
    const value = credential()
    expect(selectCredential(value)).toEqual({ ok: true, credential: value })
  })

  it('takes the first usable entry of an array', () => {
    const usable = credential({ credentialId: 'b3Ro' })
    expect(selectCredential([credential({ rpId: 'example.com' }), usable, credential()])).toEqual({
      ok: true,
      credential: usable,
    })
  })

  it.each(['ed25519', 'ec', 'rsa'] as const)('accepts %s keys', (type) => {
    expect(selectCredential(credential({ privateKey: pkcs8(type) })).ok).toBe(true)
  })

  it.each([
    ['an empty array', [], /no credential/],
    ['a string', 'x', /object/],
    ['null', null, /object/],
    ['another rpId', credential({ rpId: 'example.com' }), /auth\.woolworths\.com\.au/],
    ['a missing field', credential({ userHandle: undefined }), /needs/],
    ['an unparseable key', credential({ privateKey: 'AAAA' }), /PKCS#8/],
    ['an unsupported key type', credential({ privateKey: pkcs8('x25519') }), /unsupported/],
  ])('rejects %s', (_name, body, error) => {
    const result = selectCredential(body)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ error: expect.stringMatching(error) })
  })
})

describe('/woolworths/passkey', () => {
  let dir: string
  let db: Awaited<ReturnType<typeof createTestDb>>
  let google: FakeGoogle
  let app: FastifyInstance
  let credentials: CredentialStore
  let stored: PgSessionStorage
  let output: string
  let bearer: Record<string, string>

  const call = (
    method: 'PUT' | 'GET' | 'DELETE',
    payload?: unknown,
    headers: Record<string, string> = bearer,
  ) =>
    app.inject({
      method,
      url: '/woolworths/passkey',
      headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    })

  beforeEach(async () => {
    output = ''
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-passkey-'))
    db = await createTestDb()
    google = await FakeGoogle.create()
    credentials = new CredentialStore(db.sql, randomBytes(32))
    stored = new PgSessionStorage(db.sql, 'me@example.com')
    vi.mocked(passkeyLogin).mockReset()
    vi.mocked(passkeyLogin).mockResolvedValue(session('new'))
    app = buildApp(testConfig(dir, { logLevel: 'info' }), {
      sql: db.sql,
      fetch: google.fetch,
      passkeys: { credentials, sessions: new UserWoolworths(db.sql, credentials) },
      logStream: new Writable({
        write(chunk: Buffer, _encoding, callback) {
          output += chunk.toString()
          callback()
        },
      }),
    })
    bearer = { authorization: `Bearer ${await signInClient(app, google)}` }
    await stored.save(session('old'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true })
    await db.close()
  })

  const aref = async () => (await stored.load())?.cookies[0]?.value

  it('stores the first usable credential of an array and signs in with it', async () => {
    const usable = credential({ credentialId: 'b3Ro' })
    const response = await call('PUT', [credential({ rpId: 'example.com' }), usable])
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ registered: true })
    await expect(credentials.get('me@example.com')).resolves.toEqual([usable])
    expect(passkeyLogin).toHaveBeenCalledWith([usable])
    expect(await aref()).toBe('new')
  })

  it('replaces the stored session with the new account', async () => {
    const replacement = credential({ credentialId: 'bmV3' })
    vi.mocked(passkeyLogin).mockResolvedValue(session('other-account'))
    expect((await call('PUT', replacement)).statusCode).toBe(200)
    expect(passkeyLogin).toHaveBeenCalledWith([replacement])
    expect(await aref()).toBe('other-account')
  })

  it('keeps the credential, deletes the session and answers 502 when sign-in fails', async () => {
    vi.mocked(passkeyLogin).mockRejectedValue(new Error('Woolworths passkey login was rejected'))
    const value = credential()
    const response = await call('PUT', value)
    expect(response.statusCode).toBe(502)
    expect(response.json()).toEqual({
      error:
        'passkey saved, but signing in to Woolworths with it failed: Woolworths passkey login was rejected',
    })
    await expect(credentials.get('me@example.com')).resolves.toEqual([value])
    await expect(stored.load()).resolves.toBeUndefined()
    expect(output).not.toContain(value.privateKey)
  })

  it('replaces an existing credential', async () => {
    await call('PUT', credential({ credentialId: 'b2xk' }))
    const replacement = credential({ credentialId: 'bmV3' })
    await call('PUT', replacement)
    await expect(credentials.get('me@example.com')).resolves.toEqual([replacement])
  })

  it('rejects an invalid credential and stores nothing', async () => {
    const response = await call('PUT', credential({ rpId: 'example.com' }))
    expect(response.statusCode).toBe(400)
    expect(response.json()).toEqual({ error: 'credential must be for auth.woolworths.com.au' })
    await expect(credentials.has('me@example.com')).resolves.toBe(false)
    expect(passkeyLogin).not.toHaveBeenCalled()
    expect(await aref()).toBe('old')
  })

  it('reports whether a passkey is registered', async () => {
    expect((await call('GET')).json()).toEqual({ registered: false })
    await call('PUT', credential())
    expect((await call('GET')).json()).toEqual({ registered: true })
  })

  it('keeps each user to their own credential', async () => {
    await call('PUT', credential())
    const token = await signInClient(app, google, { overrides: { email: 'you@example.com' } })
    const other = { authorization: `Bearer ${token}` }
    expect((await call('GET', undefined, other)).json()).toEqual({ registered: false })
    await call('DELETE', undefined, other)
    await expect(credentials.has('me@example.com')).resolves.toBe(true)
  })

  it('removes the credential and deletes the stored session', async () => {
    await call('PUT', credential())
    const response = await call('DELETE')
    expect(response.json()).toEqual({ registered: false })
    await expect(credentials.has('me@example.com')).resolves.toBe(false)
    await expect(stored.load()).resolves.toBeUndefined()
  })

  it('rejects missing and cookie authorisation', async () => {
    expect((await call('GET', undefined, {})).statusCode).toBe(401)
    const cookie = await signInWeb(app, google)
    expect((await call('GET', undefined, { cookie })).statusCode).toBe(401)
  })

  it('never logs the credential', async () => {
    const value = credential()
    await call('PUT', value)
    expect(output).not.toContain(value.privateKey)
    expect(output).not.toContain(value.credentialId)
  })

  it('is rate limited', async () => {
    const statuses = []
    for (let i = 0; i < 11; i++) {
      statuses.push((await call('GET')).statusCode)
    }
    expect(statuses.at(-1)).toBe(429)
  })

  it('does not exist without passkey support', async () => {
    const bare = buildApp(testConfig(dir), { sql: db.sql, fetch: google.fetch })
    const response = await bare.inject({
      method: 'GET',
      url: '/woolworths/passkey',
      headers: bearer,
    })
    expect(response.statusCode).toBe(404)
  })
})
