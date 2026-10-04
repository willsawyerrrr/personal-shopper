import { randomBytes } from 'node:crypto'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LegacyFiles } from '../config.ts'
import { ItemStore } from '../items.ts'
import { createTestDb } from '../testing/db.ts'
import { TokenStore } from '../tokens.ts'
import { CredentialStore } from './credentials.ts'
import { importLegacyFiles } from './import.ts'
import { PgSessionStorage } from './sessions.ts'

const OWNER = 'me@example.com'
const session = {
  cookies: [{ name: 'w-aref', value: 'a' }],
  capturedAt: '2026-10-01T00:00:00.000Z',
}

describe('importLegacyFiles', () => {
  let dir: string
  let db: Awaited<ReturnType<typeof createTestDb>>
  let files: LegacyFiles
  let credentials: CredentialStore

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-import-'))
    db = await createTestDb()
    files = {
      tokens: join(dir, 'tokens.json'),
      items: join(dir, 'items.yml'),
      session: join(dir, 'session.json'),
      passkeyCredentials: join(dir, 'passkey-credentials.json'),
    }
    credentials = new CredentialStore(db.sql, randomBytes(32))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true })
    await db.close()
  })

  async function writeAll() {
    await writeFile(files.items, 'milk:\n  stockcode: 1\n  quantity: 2\n  listing: Milk 2L\n')
    await writeFile(files.session, JSON.stringify(session))
    await writeFile(files.passkeyCredentials, JSON.stringify([{ credentialId: 'abc' }]))
    await writeFile(
      files.tokens,
      JSON.stringify({
        tokens: [
          {
            hash: 'h'.repeat(64),
            email: 'you@example.com',
            client: 'ios',
            createdAt: 1,
            lastUsedAt: 2,
            expiresAt: Date.now() + 1e9,
          },
        ],
      }),
    )
  }

  it('imports every file into the owner and keeps the originals renamed', async () => {
    await writeAll()
    await expect(importLegacyFiles(db.sql, files, OWNER, credentials)).resolves.toEqual([
      'tokens',
      'items',
      'session',
      'passkey',
    ])
    await expect(new ItemStore(db.sql).load(OWNER)).resolves.toEqual({
      milk: { stockcode: 1, quantity: 2, listing: 'Milk 2L' },
    })
    await expect(new PgSessionStorage(db.sql, OWNER).load()).resolves.toEqual(session)
    await expect(credentials.get(OWNER)).resolves.toEqual([{ credentialId: 'abc' }])
    expect(await new TokenStore(db.sql).list()).toMatchObject([
      { email: 'you@example.com', client: 'ios' },
    ])
    expect((await readdir(dir)).sort()).toEqual([
      'items.yml.imported',
      'passkey-credentials.json.imported',
      'session.json.imported',
      'tokens.json.imported',
    ])
  })

  it('does nothing when there are no files, or on a second run', async () => {
    await expect(importLegacyFiles(db.sql, files, OWNER, credentials)).resolves.toEqual([])
    await writeAll()
    await importLegacyFiles(db.sql, files, OWNER, credentials)
    await expect(importLegacyFiles(db.sql, files, OWNER, credentials)).resolves.toEqual([])
  })

  it('leaves a file alone when the owner already has that data', async () => {
    await new ItemStore(db.sql).save(OWNER, { bread: { stockcode: 9, quantity: 1 } })
    await writeAll()
    const imported = await importLegacyFiles(db.sql, files, OWNER, credentials)
    expect(imported).not.toContain('items')
    await expect(new ItemStore(db.sql).load(OWNER)).resolves.toEqual({
      bread: { stockcode: 9, quantity: 1 },
    })
    expect(await readdir(dir)).toContain('items.yml')
  })

  it('refuses to import a plaintext credential without an encryption key', async () => {
    await writeFile(files.passkeyCredentials, JSON.stringify([{ credentialId: 'abc' }]))
    await expect(importLegacyFiles(db.sql, files, OWNER, undefined)).rejects.toThrow(
      'CREDENTIALS_ENCRYPTION_KEY',
    )
    expect(await readdir(dir)).toEqual(['passkey-credentials.json'])
  })

  it('rejects a tokens file that is not a token store', async () => {
    await writeFile(files.tokens, '{"other":1}')
    await expect(importLegacyFiles(db.sql, files, OWNER, credentials)).rejects.toThrow(
      'not a token store',
    )
  })
})
