import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureUser } from './db.ts'
import { HouseholdStore, INVITE_TTL_MS, InviteLimitError } from './households.ts'
import { ItemStore } from './items.ts'
import { createTestDb } from './testing/db.ts'
import { CredentialStore } from './users/credentials.ts'
import { PgSessionStorage } from './users/sessions.ts'

const A = 'a@example.com'
const B = 'b@example.com'

describe('households migration', () => {
  it('gives every existing user a household holding their data', async () => {
    const db = await createTestDb('households')
    const sql = db.sql
    const [a] = await sql<{ id: string }[]>`insert into users (email) values (${A}) returning id`
    const [b] = await sql<{ id: string }[]>`insert into users (email) values (${B}) returning id`
    await sql`insert into items (user_id, word, position, stockcode, quantity)
      values (${a?.id ?? ''}, 'milk', 0, 1, 1), (${b?.id ?? ''}, 'milk', 0, 2, 3)`
    await sql`insert into woolworths_sessions (user_id, cookies, captured_at)
      values (${a?.id ?? ''}, '[]', now())`
    await sql`insert into passkey_credentials (user_id, encrypted)
      values (${b?.id ?? ''}, ${Buffer.from('x')})`
    await db.migrate()

    const items = new ItemStore(sql)
    expect(await items.load(A)).toMatchObject([
      { words: ['milk'], candidates: [{ stockcode: 1, quantity: 1 }] },
    ])
    expect(await items.load(B)).toMatchObject([
      { words: ['milk'], candidates: [{ stockcode: 2, quantity: 3 }] },
    ])
    expect(await new PgSessionStorage(sql, A).load()).toBeDefined()
    expect(await new PgSessionStorage(sql, B).load()).toBeUndefined()
    expect(await new CredentialStore(sql, Buffer.alloc(32)).has(B)).toBe(true)
    expect(await sql`select 1 from households`).toHaveLength(2)
    expect(await new HouseholdStore(sql).members(A)).toEqual([A])
    await db.close()
  })
})

describe('HouseholdStore', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  let clock: number
  let households: HouseholdStore
  let items: ItemStore

  beforeEach(async () => {
    db = await createTestDb()
    clock = 1_000_000
    households = new HouseholdStore(db.sql, () => clock, 2)
    items = new ItemStore(db.sql)
    await ensureUser(db.sql, A)
    await ensureUser(db.sql, B)
  })

  afterEach(async () => {
    await db.close()
  })

  it('shares items, the session and the credential between members', async () => {
    await items.save(A, [
      {
        id: '11111111-1111-1111-1111-111111111111',
        words: ['milk'],
        candidates: [{ stockcode: 1, quantity: 1 }],
      },
    ])
    await new PgSessionStorage(db.sql, A).save({
      cookies: [{ name: 'x', value: 'y' }],
      capturedAt: '2026-01-01T00:00:00.000Z',
    })
    const credentials = new CredentialStore(db.sql, Buffer.alloc(32, 1))
    await credentials.put(A, [{ id: 'c' }])
    const { code } = await households.invite(A)
    await households.join(B, code)

    expect(await households.members(A)).toEqual([A, B])
    expect((await items.load(B)).map((item) => item.words)).toEqual([['milk']])
    await items.save(B, [
      {
        id: '22222222-2222-2222-2222-222222222222',
        words: ['bread'],
        candidates: [{ stockcode: 2, quantity: 1 }],
      },
    ])
    expect((await items.load(A)).map((item) => item.words[0])).toEqual(['bread'])
    expect((await new PgSessionStorage(db.sql, B).load())?.cookies).toEqual([
      { name: 'x', value: 'y' },
    ])
    expect(await credentials.get(B)).toEqual([{ id: 'c' }])
  })

  it('stores only the hash of an invite code', async () => {
    const { code } = await households.invite(A)
    const rows = await db.sql<{ code_hash: string }[]>`select code_hash from household_invites`
    expect(rows).toHaveLength(1)
    expect(rows[0]?.code_hash).not.toContain(code)
  })

  it('discards the data of a household its only member leaves for another', async () => {
    await items.save(B, [
      {
        id: '33333333-3333-3333-3333-333333333333',
        words: ['eggs'],
        candidates: [{ stockcode: 9, quantity: 1 }],
      },
    ])
    const { code } = await households.invite(A)
    expect(await households.join(B, ` ${code} `)).toBe('joined')
    expect(await db.sql`select 1 from households`).toHaveLength(1)
    expect(await items.load(B)).toEqual([])
  })

  it('keeps the data of a household that still has members when one joins elsewhere', async () => {
    const c = 'c@example.com'
    await ensureUser(db.sql, c)
    await items.save(A, [
      {
        id: '11111111-1111-1111-1111-111111111111',
        words: ['milk'],
        candidates: [{ stockcode: 1, quantity: 1 }],
      },
    ])
    await households.join(B, (await households.invite(A)).code)
    await households.join(A, (await households.invite(c)).code)
    expect((await items.load(B)).map((item) => item.words)).toEqual([['milk']])
    expect(await households.members(A)).toEqual([A, c])
  })

  it('consumes an invite on use', async () => {
    const c = 'c@example.com'
    await ensureUser(db.sql, c)
    const { code } = await households.invite(A)
    expect(await households.join(B, code)).toBe('joined')
    expect(await households.join(c, code)).toBe('invalid_invite')
  })

  it('rejects unknown and expired codes, and a code to the joiner own household', async () => {
    expect(await households.join(B, 'nope')).toBe('invalid_invite')
    const { code, expiresAt } = await households.invite(A)
    expect(expiresAt).toBe(clock + INVITE_TTL_MS)
    expect(await households.join(A, code)).toBe('already_member')
    expect(await households.activeInvites(A)).toBe(1)
    clock = expiresAt
    expect(await households.activeInvites(A)).toBe(0)
    expect(await households.join(B, code)).toBe('invalid_invite')
  })

  it('limits the unexpired invites a household holds', async () => {
    await households.invite(A)
    await households.invite(A)
    await expect(households.invite(A)).rejects.toBeInstanceOf(InviteLimitError)
    await households.invite(B)
    clock += INVITE_TTL_MS
    await expect(households.invite(A)).resolves.toBeDefined()
  })

  it('gives a leaving member a fresh empty household and keeps the rest', async () => {
    await items.save(A, [
      {
        id: '11111111-1111-1111-1111-111111111111',
        words: ['milk'],
        candidates: [{ stockcode: 1, quantity: 1 }],
      },
    ])
    await households.join(B, (await households.invite(A)).code)
    expect(await households.leave(B)).toBe('left')
    expect(await households.members(A)).toEqual([A])
    expect(await households.members(B)).toEqual([B])
    expect(await items.load(B)).toEqual([])
    expect((await items.load(A)).map((item) => item.words)).toEqual([['milk']])
  })

  it('leaves a sole member where they are', async () => {
    await items.save(A, [
      {
        id: '11111111-1111-1111-1111-111111111111',
        words: ['milk'],
        candidates: [{ stockcode: 1, quantity: 1 }],
      },
    ])
    expect(await households.leave(A)).toBe('sole_member')
    expect((await items.load(A)).map((item) => item.words)).toEqual([['milk']])
  })

  it('picks one email per household', async () => {
    await households.join(B, (await households.invite(A)).code)
    const c = 'c@example.com'
    await ensureUser(db.sql, c)
    expect((await households.onePerHousehold([B, A, c])).sort()).toEqual([A, c])
    expect(await households.onePerHousehold([])).toEqual([])
  })
})
