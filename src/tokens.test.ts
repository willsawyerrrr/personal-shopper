import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './testing/db.ts'
import { DEFAULT_TOKEN_TTL_MS, hashToken, TokenLimitError, TokenStore } from './tokens.ts'

const DAY = 24 * 60 * 60 * 1000

describe('TokenStore', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  let clock: number
  const store = () => new TokenStore(db.sql, () => clock)

  beforeEach(async () => {
    db = await createTestDb()
    clock = Date.UTC(2026, 0, 1)
  })

  afterEach(async () => {
    await db.close()
  })

  it('issues 32+ random bytes and verifies them', async () => {
    const tokens = store()
    const { token, expiresAt } = await tokens.issue('me@example.com', 'ios')
    expect(Buffer.from(token.slice(3), 'base64url').length).toBeGreaterThanOrEqual(32)
    expect(expiresAt).toBe(clock + DEFAULT_TOKEN_TTL_MS)
    const check = await tokens.verify(token)
    expect(check).toMatchObject({ ok: true, record: { email: 'me@example.com', client: 'ios' } })
    expect((await tokens.issue('me@example.com', 'ios')).token).not.toBe(token)
  })

  it('stores only the hash', async () => {
    const { token } = await store().issue('me@example.com', 'extension')
    const rows = await db.sql`select * from tokens`
    expect(JSON.stringify(rows)).not.toContain(token)
    expect(rows.map((row) => row.hash)).toEqual([hashToken(token)])
  })

  it('rejects an unknown token', async () => {
    expect(await store().verify('ps_unknown')).toEqual({ ok: false, reason: 'invalid_token' })
  })

  it('survives a restart', async () => {
    const { token } = await store().issue('me@example.com', 'ios')
    expect((await store().verify(token)).ok).toBe(true)
  })

  it('expires after 90 days of disuse', async () => {
    const tokens = store()
    const { token } = await tokens.issue('me@example.com', 'ios')
    clock += 90 * DAY
    expect(await tokens.verify(token)).toEqual({ ok: false, reason: 'expired_token' })
  })

  it('slides the expiry forward on use', async () => {
    const tokens = store()
    const { token } = await tokens.issue('me@example.com', 'ios')
    clock += 60 * DAY
    expect((await tokens.verify(token)).ok).toBe(true)
    clock += 60 * DAY
    expect((await tokens.verify(token)).ok).toBe(true)
    clock += 91 * DAY
    expect(await tokens.verify(token)).toEqual({ ok: false, reason: 'expired_token' })
  })

  it('persists the slid expiry across a restart', async () => {
    const tokens = store()
    const { token } = await tokens.issue('me@example.com', 'ios')
    clock += 60 * DAY
    await tokens.verify(token)
    clock += 60 * DAY
    expect((await store().verify(token)).ok).toBe(true)
  })

  it('keeps a shorter lifetime for web sessions', async () => {
    const tokens = store()
    const { token } = await tokens.issue('me@example.com', 'web', 30 * DAY)
    clock += 30 * DAY
    expect(await tokens.verify(token)).toEqual({ ok: false, reason: 'expired_token' })
  })

  it('revokes the presented token', async () => {
    const tokens = store()
    const { token } = await tokens.issue('me@example.com', 'ios')
    expect(await tokens.revoke(token)).toBe(true)
    expect(await tokens.revoke(token)).toBe(false)
    expect(await tokens.verify(token)).toEqual({ ok: false, reason: 'invalid_token' })
  })

  it('lists unexpired sessions without hashes and revokes them by id', async () => {
    const tokens = store()
    const old = await tokens.issue('me@example.com', 'web', DAY)
    clock += 1000
    const fresh = await tokens.issue('me@example.com', 'ios')
    clock += DAY
    const sessions = await tokens.list()
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ client: 'ios', email: 'me@example.com' })
    expect(JSON.stringify(sessions)).not.toContain(hashToken(fresh.token))
    expect((await tokens.verify(old.token)).ok).toBe(false)
    expect(await tokens.revokeById(sessions[0]?.id ?? '')).toBe(true)
    expect(await tokens.list()).toEqual([])
  })

  it('does not revoke on a short, partial or non-hex id', async () => {
    const tokens = store()
    await tokens.issue('me@example.com', 'ios')
    expect(await tokens.revokeById('')).toBe(false)
    expect(await tokens.revokeById('a')).toBe(false)
    expect(await tokens.revokeById('%'.repeat(16))).toBe(false)
    expect(await tokens.list()).toHaveLength(1)
  })

  it('drops long-expired records when issuing', async () => {
    const tokens = store()
    const old = await tokens.issue('me@example.com', 'web', DAY)
    clock += 9 * DAY
    await tokens.issue('me@example.com', 'ios')
    expect(await tokens.verify(old.token)).toEqual({ ok: false, reason: 'invalid_token' })
  })

  it('lists the distinct emails with a session', async () => {
    const tokens = store()
    await tokens.issue('me@example.com', 'ios')
    await tokens.issue('me@example.com', 'web')
    await tokens.issue('you@example.com', 'ios')
    expect((await tokens.emails()).sort()).toEqual(['me@example.com', 'you@example.com'])
  })

  it("refuses to issue beyond the user's cap of unexpired tokens", async () => {
    const tokens = new TokenStore(db.sql, () => clock, 2)
    await tokens.issue('me@example.com', 'ios')
    await tokens.issue('me@example.com', 'web')
    await expect(tokens.issue('me@example.com', 'ios')).rejects.toBeInstanceOf(TokenLimitError)
    await tokens.issue('you@example.com', 'ios')
  })

  it('does not count expired tokens against the cap', async () => {
    const tokens = new TokenStore(db.sql, () => clock, 1)
    await tokens.issue('me@example.com', 'ios', DAY)
    clock += 2 * DAY
    await tokens.issue('me@example.com', 'ios')
  })

  it('holds the cap under concurrent sign-ins', async () => {
    const tokens = new TokenStore(db.sql, () => clock, 3)
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () => tokens.issue('me@example.com', 'ios')),
    )
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(3)
  })
})
