import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'
import type { Sql } from '../db.ts'

const MIGRATIONS = join(import.meta.dirname, '../../supabase/migrations')

/**
 * A fresh schema in the Postgres at `TEST_DATABASE_URL` (default: a local
 * server on port 54329), with every migration applied, or only those before
 * the one named `before` (`migrate` then applies the rest). `close` drops it.
 */
export async function createTestDb(before?: string): Promise<{
  sql: Sql
  migrate: () => Promise<void>
  close: () => Promise<void>
}> {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:54329/postgres'
  const admin = postgres(url, { onnotice: () => {}, max: 1 })
  const schema = `test_${randomBytes(6).toString('hex')}`
  await admin.unsafe(`create schema ${schema}`)
  const sql = postgres(url, {
    prepare: false,
    onnotice: () => {},
    max: 4,
    connection: { search_path: schema },
  })
  const files = readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()
  const stop =
    before === undefined ? files.length : files.findIndex((name) => name.includes(before))
  const apply = async (names: string[]) => {
    for (const file of names) {
      await sql.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8'))
    }
  }
  await apply(files.slice(0, stop))
  return {
    sql,
    migrate: () => apply(files.slice(stop)),
    close: async () => {
      await sql.end()
      await admin.unsafe(`drop schema ${schema} cascade`)
      await admin.end()
    },
  }
}
