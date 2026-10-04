import { readFile, rename } from 'node:fs/promises'
import type { LegacyFiles } from '../config.ts'
import { ensureUser, type Sql } from '../db.ts'
import { ItemStore, parseItemsYaml } from '../items.ts'
import type { StoredSession } from '../woolworths/session.ts'
import { parseCredentials, type CredentialStore } from './credentials.ts'
import { PgSessionStorage } from './sessions.ts'

const IMPORTED_SUFFIX = '.imported'

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw error
  }
}

/** Keeps the file, renamed, so the import never runs twice and nothing is lost. */
const markImported = (path: string) => rename(path, `${path}${IMPORTED_SUFFIX}`)

/**
 * Imports the files of a single-user deployment into the database: tokens
 * keep their emails, everything else becomes `owner`'s. Each file is imported
 * only into an empty destination (no tokens at all, or none of that kind for
 * the owner) and then renamed with a `.imported` suffix. The passkey file
 * needs `credentials`, which encrypts it. Returns the kinds imported.
 */
export async function importLegacyFiles(
  sql: Sql,
  files: LegacyFiles,
  owner: string,
  credentials: CredentialStore | undefined,
): Promise<string[]> {
  const imported: string[] = []

  const tokens = await readIfPresent(files.tokens)
  if (tokens !== undefined) {
    const [stored] = await sql<{ count: string }[]>`select count(*)::text as count from tokens`
    if (stored?.count === '0') {
      const parsed = JSON.parse(tokens) as {
        tokens?: {
          hash: string
          email: string
          client: string
          createdAt: number
          lastUsedAt: number
          expiresAt: number
        }[]
      }
      if (!Array.isArray(parsed.tokens)) {
        throw new Error(`${files.tokens} is not a token store`)
      }
      for (const record of parsed.tokens) {
        const userId = await ensureUser(sql, record.email)
        await sql`
          insert into tokens (hash, user_id, client, created_at, last_used_at, expires_at)
          values (${record.hash}, ${userId}, ${record.client}, ${record.createdAt},
                  ${record.lastUsedAt}, ${record.expiresAt})
          on conflict (hash) do nothing`
      }
      await markImported(files.tokens)
      imported.push('tokens')
    }
  }

  const items = await readIfPresent(files.items)
  if (items !== undefined) {
    const store = new ItemStore(sql)
    if (Object.keys(await store.load(owner)).length === 0) {
      await store.save(owner, parseItemsYaml(items))
      await markImported(files.items)
      imported.push('items')
    }
  }

  const session = await readIfPresent(files.session)
  if (session !== undefined) {
    const storage = new PgSessionStorage(sql, owner)
    if (!(await storage.load())) {
      await storage.save(JSON.parse(session) as StoredSession)
      await markImported(files.session)
      imported.push('session')
    }
  }

  const passkey = await readIfPresent(files.passkeyCredentials)
  if (passkey !== undefined) {
    if (!credentials) {
      throw new Error(
        `${files.passkeyCredentials} needs importing: set CREDENTIALS_ENCRYPTION_KEY to encrypt it`,
      )
    }
    if (!(await credentials.get(owner))) {
      await credentials.put(owner, parseCredentials(JSON.parse(passkey)))
      await markImported(files.passkeyCredentials)
      imported.push('passkey')
    }
  }
  return imported
}
