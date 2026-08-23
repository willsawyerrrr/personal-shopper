import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionStore, type StoredSession } from './session.ts'

describe('SessionStore', () => {
  let dir: string
  let store: SessionStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-session-'))
    store = new SessionStore(join(dir, 'session.json'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('round-trips a saved session', async () => {
    const session: StoredSession = {
      cookies: [{ name: 'wow-auth-token', value: 'abc' }],
      capturedAt: new Date().toISOString(),
    }
    await store.save(session)
    await expect(store.load()).resolves.toEqual(session)
  })

  it('treats a freshly captured session as not expired', () => {
    const session: StoredSession = { cookies: [], capturedAt: new Date().toISOString() }
    expect(store.isExpired(session)).toBe(false)
  })

  it('treats an hour-old session as expired', () => {
    const capturedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    expect(store.isExpired({ cookies: [], capturedAt })).toBe(true)
  })

  it('joins cookies into a Cookie header', () => {
    const session: StoredSession = {
      cookies: [
        { name: 'a', value: '1' },
        { name: 'b', value: '2' },
      ],
      capturedAt: new Date().toISOString(),
    }
    expect(store.toCookieHeader(session)).toBe('a=1; b=2')
  })
})
