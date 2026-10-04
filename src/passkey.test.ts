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
  let invalidate: ReturnType<typeof vi.fn<(email: string) => void>>
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
    invalidate = vi.fn()
    app = buildApp(
      testConfig(dir, { logLevel: 'info', allowedEmails: ['me@example.com', 'you@example.com'] }),
      {
        sql: db.sql,
        fetch: google.fetch,
        passkeys: { credentials, invalidate },
        logStream: new Writable({
          write(chunk: Buffer, _encoding, callback) {
            output += chunk.toString()
            callback()
          },
        }),
      },
    )
    bearer = { authorization: `Bearer ${await signInClient(app, google)}` }
  })

  afterEach(async () => {
    await rm(dir, { recursive: true })
    await db.close()
  })

  it('stores the first usable credential of an array and invalidates the session', async () => {
    const usable = credential({ credentialId: 'b3Ro' })
    const response = await call('PUT', [credential({ rpId: 'example.com' }), usable])
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ registered: true })
    await expect(credentials.get('me@example.com')).resolves.toEqual([usable])
    expect(invalidate).toHaveBeenCalledWith('me@example.com')
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
    expect(invalidate).not.toHaveBeenCalled()
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

  it('removes the credential and invalidates the session', async () => {
    await call('PUT', credential())
    invalidate.mockClear()
    const response = await call('DELETE')
    expect(response.json()).toEqual({ registered: false })
    await expect(credentials.has('me@example.com')).resolves.toBe(false)
    expect(invalidate).toHaveBeenCalledWith('me@example.com')
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
