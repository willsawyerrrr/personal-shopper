import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_TOKEN_TTL_MS, hashToken, TokenStore } from './tokens.ts'

const DAY = 24 * 60 * 60 * 1000

describe('TokenStore', () => {
  let dir: string
  let path: string
  let clock: number
  const store = () => new TokenStore(path, () => clock)

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-tokens-'))
    path = join(dir, 'tokens.json')
    clock = Date.UTC(2026, 0, 1)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true })
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

  it('stores only the hash, readable only by the owner', async () => {
    const { token } = await store().issue('me@example.com', 'extension')
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain(token)
    expect(text).toContain(hashToken(token))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
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
    await tokens.flush()
    clock += 91 * DAY
    expect(await tokens.verify(token)).toEqual({ ok: false, reason: 'expired_token' })
  })

  it('persists the slid expiry across a restart', async () => {
    const tokens = store()
    const { token } = await tokens.issue('me@example.com', 'ios')
    clock += 60 * DAY
    await tokens.verify(token)
    await tokens.flush()
    clock += 60 * DAY
    const restarted = store()
    expect((await restarted.verify(token)).ok).toBe(true)
    await restarted.flush()
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
    expect((await store().verify(token)).ok).toBe(false)
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

  it('does not revoke on a short or partial id', async () => {
    const tokens = store()
    await tokens.issue('me@example.com', 'ios')
    expect(await tokens.revokeById('')).toBe(false)
    expect(await tokens.revokeById('a')).toBe(false)
    expect(await tokens.list()).toHaveLength(1)
  })

  it('drops long-expired records when issuing', async () => {
    const tokens = store()
    const old = await tokens.issue('me@example.com', 'web', DAY)
    clock += 9 * DAY
    await tokens.issue('me@example.com', 'ios')
    expect(await tokens.verify(old.token)).toEqual({ ok: false, reason: 'invalid_token' })
  })

  it('refuses to start from a corrupt file', async () => {
    await writeFile(path, '{ nope')
    await expect(store().load()).rejects.toThrow()
    await writeFile(path, '{"other":1}')
    await expect(store().load()).rejects.toThrow('not a token store')
  })

  it('reports a write failure when the sliding expiry cannot be saved', async () => {
    const errors: unknown[] = []
    const tokens = new TokenStore(
      path,
      () => clock,
      (error) => errors.push(error),
    )
    const { token } = await tokens.issue('me@example.com', 'ios')
    await rm(dir, { recursive: true })
    await writeFile(dir, 'a file where the directory was')
    clock += 2 * 60 * 60 * 1000
    expect((await tokens.verify(token)).ok).toBe(true)
    await tokens.flush()
    expect(errors).toHaveLength(1)
    await rm(dir)
    await mkdir(dir)
  })
})
