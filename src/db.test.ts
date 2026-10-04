import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { admitUser, ensureHousehold, ensureUser } from './db.ts'
import { createTestDb } from './testing/db.ts'

describe('migrations', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>

  beforeEach(async () => {
    db = await createTestDb()
  })

  afterEach(async () => {
    await db.close()
  })

  it('enable row level security on every table, with no policies', async () => {
    const tables = await db.sql<{ relname: string; relrowsecurity: boolean }[]>`
      select relname, relrowsecurity from pg_class
      where relkind = 'r' and relnamespace = current_schema()::regnamespace`
    expect(tables.map((table) => table.relname).sort()).toEqual([
      'household_invites',
      'households',
      'items',
      'passkey_credentials',
      'tokens',
      'users',
      'woolworths_sessions',
    ])
    expect(tables.every((table) => table.relrowsecurity)).toBe(true)
    const policies = await db.sql`select 1 from pg_policies where schemaname = current_schema()`
    expect(policies).toHaveLength(0)
  })
})

describe('ensureUser', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>

  beforeEach(async () => {
    db = await createTestDb()
  })

  afterEach(async () => {
    await db.close()
  })

  it('returns one id per email, whatever its casing', async () => {
    const id = await ensureUser(db.sql, 'Me@Example.com ')
    expect(await ensureUser(db.sql, 'me@example.com')).toBe(id)
    expect(await ensureUser(db.sql, 'you@example.com')).not.toBe(id)
  })

  it('puts each new user in a household of their own, leaving none orphaned', async () => {
    await Promise.all(
      ['a@example.com', 'a@example.com', 'b@example.com'].map((email) => ensureUser(db.sql, email)),
    )
    expect(await db.sql`select distinct household_id from users`).toHaveLength(2)
    expect(await db.sql`select 1 from households`).toHaveLength(2)
    expect(await ensureHousehold(db.sql, 'A@example.com')).toBe(
      await ensureHousehold(db.sql, 'a@example.com'),
    )
  })

  it('refuses an email that is not lower-case when written directly', async () => {
    const [household] = await db.sql<
      { id: string }[]
    >`insert into households default values returning id`
    await expect(
      db.sql`insert into users (email, household_id) values ('Me@Example.com', ${household?.id ?? ''})`,
    ).rejects.toThrow()
  })
})

describe('admitUser', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>

  beforeEach(async () => {
    db = await createTestDb()
  })

  afterEach(async () => {
    await db.close()
  })

  it('creates users up to the cap and admits existing ones beyond it', async () => {
    expect(await admitUser(db.sql, 'a@example.com', 2)).toBe('admitted')
    expect(await admitUser(db.sql, 'b@example.com', 2)).toBe('admitted')
    expect(await admitUser(db.sql, 'c@example.com', 2)).toBe('closed')
    expect(await admitUser(db.sql, 'A@Example.com', 2)).toBe('admitted')
    expect(await db.sql`select 1 from users`).toHaveLength(2)
    expect(await db.sql`select 1 from households`).toHaveLength(2)
  })

  it('never exceeds the cap under concurrent sign-ups', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => admitUser(db.sql, `user${i}@example.com`, 3)),
    )
    expect(results.filter((result) => result === 'admitted')).toHaveLength(3)
    expect(await db.sql`select 1 from users`).toHaveLength(3)
  })
})
