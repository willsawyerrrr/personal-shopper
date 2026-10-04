import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureUser } from './db.ts'
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

  it('refuses an email that is not lower-case when written directly', async () => {
    await expect(db.sql`insert into users (email) values ('Me@Example.com')`).rejects.toThrow()
  })
})
