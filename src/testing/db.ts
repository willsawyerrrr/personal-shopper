import { randomBytes } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'
import type { Sql } from '../db.ts'

const MIGRATIONS = join(import.meta.dirname, '../../supabase/migrations')

/**
 * A fresh schema in the Postgres at `TEST_DATABASE_URL` (default: a local
 * server on port 54329), with every migration applied. `close` drops it.
 */
export async function createTestDb(): Promise<{ sql: Sql; close: () => Promise<void> }> {
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
  for (const file of readdirSync(MIGRATIONS)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await sql.unsafe(readFileSync(join(MIGRATIONS, file), 'utf8'))
  }
  return {
    sql,
    close: async () => {
      await sql.end()
      await admin.unsafe(`drop schema ${schema} cascade`)
      await admin.end()
    },
  }
}
