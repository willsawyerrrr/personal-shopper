import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from '../testing/db.ts'
import { passkeyLogin } from '../woolworths/passkey.ts'
import { SESSION_EXPIRED_MESSAGE, type StoredSession } from '../woolworths/session.ts'
import { CredentialStore } from './credentials.ts'
import { PgSessionStorage } from './sessions.ts'
import { UserWoolworths } from './woolworths.ts'

vi.mock('../woolworths/passkey.ts', () => ({ passkeyLogin: vi.fn() }))

const CAPTURED_AT = '2026-10-01T00:00:00.000Z'
const session = (aref: string, capturedAt = CAPTURED_AT): StoredSession => ({
  cookies: [{ name: 'w-aref', value: aref }],
  capturedAt,
})
const now = () => new Date().toISOString()
const hourOld = () => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()

describe('PgSessionStorage', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>

  beforeEach(async () => {
    db = await createTestDb()
  })

  afterEach(async () => {
    await db.close()
  })

  it('round-trips a session per user, whatever the email casing', async () => {
    await new PgSessionStorage(db.sql, 'Me@Example.com').save(session('mine'))
    await new PgSessionStorage(db.sql, 'you@example.com').save(session('yours'))
    await expect(new PgSessionStorage(db.sql, 'me@example.com').load()).resolves.toEqual(
      session('mine'),
    )
    expect((await new PgSessionStorage(db.sql, 'you@example.com').load())?.cookies).toEqual([
      { name: 'w-aref', value: 'yours' },
    ])
  })

  it('replaces the previous session', async () => {
    const storage = new PgSessionStorage(db.sql, 'me@example.com')
    await storage.save(session('one'))
    await storage.save(session('two'))
    expect((await storage.load())?.cookies).toEqual([{ name: 'w-aref', value: 'two' }])
  })

  it("deletes the household's session for any member and leaves other households", async () => {
    const storage = new PgSessionStorage(db.sql, 'me@example.com')
    await storage.save(session('mine'))
    await new PgSessionStorage(db.sql, 'you@example.com').save(session('yours'))
    await storage.clear()
    await expect(storage.load()).resolves.toBeUndefined()
    await expect(new PgSessionStorage(db.sql, 'you@example.com').load()).resolves.toBeDefined()
    await expect(storage.clear()).resolves.toBeUndefined()
  })

  it('has no session for an unknown user', async () => {
    await expect(new PgSessionStorage(db.sql, 'nobody@example.com').load()).resolves.toBeUndefined()
  })
})

describe('UserWoolworths', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  let credentials: CredentialStore
  let woolworths: UserWoolworths
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(async () => {
    db = await createTestDb()
    credentials = new CredentialStore(db.sql, randomBytes(32))
    woolworths = new UserWoolworths(db.sql, credentials)
    fetchMock.mockReset()
    vi.mocked(passkeyLogin).mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await db.close()
  })

  it('caches one session store per user', () => {
    expect(woolworths.sessionsFor('me@example.com')).toBe(woolworths.sessionsFor('ME@example.com'))
    expect(woolworths.sessionsFor('me@example.com')).not.toBe(
      woolworths.sessionsFor('you@example.com'),
    )
    expect(woolworths.clientFor('me@example.com')).toBe(woolworths.clientFor('me@example.com'))
  })

  it("drops a user's cached session store when invalidated", () => {
    const mine = woolworths.sessionsFor('me@example.com')
    const yours = woolworths.sessionsFor('you@example.com')
    woolworths.invalidate('ME@example.com')
    expect(woolworths.sessionsFor('me@example.com')).not.toBe(mine)
    expect(woolworths.sessionsFor('you@example.com')).toBe(yours)
  })

  it('stores the passkey login as the session and replaces the old one', async () => {
    const storage = new PgSessionStorage(db.sql, 'me@example.com')
    await storage.save(session('old'))
    vi.mocked(passkeyLogin).mockResolvedValue(session('fresh'))
    await woolworths.replaceSession('me@example.com', { credentialId: 'new' })
    expect(passkeyLogin).toHaveBeenCalledWith([{ credentialId: 'new' }])
    expect((await storage.load())?.cookies).toEqual([{ name: 'w-aref', value: 'fresh' }])
  })

  it('deletes the session and rethrows when the passkey login fails', async () => {
    const storage = new PgSessionStorage(db.sql, 'me@example.com')
    await storage.save(session('old'))
    vi.mocked(passkeyLogin).mockRejectedValue(new Error('rejected'))
    await expect(woolworths.replaceSession('me@example.com', {})).rejects.toThrow('rejected')
    await expect(storage.load()).resolves.toBeUndefined()
  })

  it('clears the stored session and drops the cached store', async () => {
    const storage = new PgSessionStorage(db.sql, 'me@example.com')
    await storage.save(session('old'))
    const cached = woolworths.sessionsFor('me@example.com')
    await woolworths.clearSession('me@example.com')
    await expect(storage.load()).resolves.toBeUndefined()
    expect(woolworths.sessionsFor('me@example.com')).not.toBe(cached)
  })

  it("adds to the cart with the signed-in user's own cookies", async () => {
    await new PgSessionStorage(db.sql, 'me@example.com').save(session('mine', now()))
    await new PgSessionStorage(db.sql, 'you@example.com').save(session('yours', now()))
    fetchMock.mockImplementation(async () => Response.json({}))
    await woolworths.clientFor('you@example.com').addToCart(1, 1)
    await woolworths.clientFor('me@example.com').addToCart(1, 1)
    const cookies = fetchMock.mock.calls.map(
      ([, init]) => ((init ?? {}).headers as Record<string, string>).Cookie,
    )
    expect(cookies).toEqual(['w-aref=yours', 'w-aref=mine'])
  })

  it('fails a user with no session as expired without touching Woolworths', async () => {
    await expect(woolworths.clientFor('new@example.com').addToCart(1, 1)).rejects.toThrow(
      SESSION_EXPIRED_MESSAGE,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("signs in again with the user's own passkey when the refresh is rejected", async () => {
    await new PgSessionStorage(db.sql, 'me@example.com').save(session('old', hourOld()))
    await new PgSessionStorage(db.sql, 'you@example.com').save(session('old', hourOld()))
    await credentials.put('you@example.com', [{ credentialId: 'yours' }])
    vi.mocked(passkeyLogin).mockResolvedValue(session('fresh', now()))
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith('/auth/heartbeat')
        ? new Response('no', { status: 401 })
        : Response.json({}),
    )

    await woolworths.clientFor('you@example.com').addToCart(1, 1)
    expect(passkeyLogin).toHaveBeenCalledWith([{ credentialId: 'yours' }])
    expect((await new PgSessionStorage(db.sql, 'you@example.com').load())?.cookies).toEqual([
      { name: 'w-aref', value: 'fresh' },
    ])

    await expect(woolworths.clientFor('me@example.com').addToCart(1, 1)).rejects.toThrow(
      SESSION_EXPIRED_MESSAGE,
    )
    expect(passkeyLogin).toHaveBeenCalledTimes(1)
  })

  it('shares one refresh and login between concurrent calls for a user', async () => {
    await new PgSessionStorage(db.sql, 'me@example.com').save(session('old', hourOld()))
    await credentials.put('me@example.com', [{ credentialId: 'mine' }])
    vi.mocked(passkeyLogin).mockResolvedValue(session('fresh', now()))
    fetchMock.mockImplementation(async (url) =>
      String(url).endsWith('/auth/heartbeat')
        ? new Response('no', { status: 401 })
        : Response.json({}),
    )
    const client = woolworths.clientFor('me@example.com')
    await Promise.all([client.addToCart(1, 1), client.addToCart(2, 1)])
    expect(passkeyLogin).toHaveBeenCalledTimes(1)
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/auth/heartbeat')),
    ).toHaveLength(1)
  })

  it('has no passkey fallback without a credential store', async () => {
    const without = new UserWoolworths(db.sql)
    await new PgSessionStorage(db.sql, 'me@example.com').save(session('old', hourOld()))
    fetchMock.mockResolvedValue(new Response('no', { status: 401 }))
    await expect(without.clientFor('me@example.com').addToCart(1, 1)).rejects.toThrow(
      SESSION_EXPIRED_MESSAGE,
    )
  })
})
