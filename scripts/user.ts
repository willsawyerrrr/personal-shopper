import { parseArgs } from 'node:util'
import { resolveOwnerEmail } from '../src/config.ts'
import { connect } from '../src/db.ts'
import { CredentialStore, parseEncryptionKey } from '../src/users/credentials.ts'
import { normalizeEmail } from '../src/users/email.ts'
import { PgSessionStorage } from '../src/users/sessions.ts'
import { SessionStore } from '../src/woolworths/session.ts'

/**
 * Resolves the user a script acts for: `--user <email>`, else the owner
 * (`REMINDERS_OWNER_EMAIL`). The user's
 * data is in the database at `DATABASE_URL`, like the server's. Call `close`
 * when done.
 */
export function scriptUser() {
  const { values, positionals } = parseArgs({
    options: { user: { type: 'string' } },
    allowPositionals: true,
  })
  const email = values.user ? normalizeEmail(values.user) : resolveOwnerEmail()
  if (!email) {
    throw new Error('Pass --user <email> or set REMINDERS_OWNER_EMAIL')
  }
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required')
  }
  const sql = connect(databaseUrl)
  return {
    email,
    positionals,
    sessions: new SessionStore(new PgSessionStorage(sql, email)),
    /** The credential store; needs `CREDENTIALS_ENCRYPTION_KEY`. */
    credentials(): CredentialStore {
      const key = process.env.CREDENTIALS_ENCRYPTION_KEY
      if (!key) {
        throw new Error('CREDENTIALS_ENCRYPTION_KEY is required')
      }
      return new CredentialStore(sql, parseEncryptionKey(key))
    },
    close: () => sql.end(),
  }
}
