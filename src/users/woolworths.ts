import type { Sql } from '../db.ts'
import { WoolworthsClient } from '../woolworths/client.ts'
import { passkeyLogin } from '../woolworths/passkey.ts'
import { SessionStore } from '../woolworths/session.ts'
import type { CredentialStore, PasskeyCredential } from './credentials.ts'
import { normalizeEmail } from './email.ts'
import { PgSessionStorage } from './sessions.ts'

/**
 * Hands out each user's Woolworths session and client, created on first use
 * and cached, so a user's concurrent refreshes and logins share one request
 * while users never share a session.
 */
export class UserWoolworths {
  private readonly clients = new Map<string, { sessions: SessionStore; client: WoolworthsClient }>()

  /** `credentials`, when given, lets a rejected session sign in again with the user's passkey. */
  constructor(
    private readonly sql: Sql,
    private readonly credentials?: CredentialStore,
  ) {}

  sessionsFor(email: string): SessionStore {
    return this.entry(email).sessions
  }

  clientFor(email: string): WoolworthsClient {
    return this.entry(email).client
  }

  /** Drops the user's cached session store, so the next login reads their current credential. */
  invalidate(email: string): void {
    this.clients.delete(normalizeEmail(email))
  }

  /**
   * Signs in with `credential` and stores the result as the household's
   * session, replacing the previous one. When sign-in fails the stored session
   * is deleted, so the previous account never drives the cart, and the error
   * is rethrown.
   */
  async replaceSession(email: string, credential: PasskeyCredential): Promise<void> {
    this.invalidate(email)
    const sessions = this.sessionsFor(email)
    try {
      await sessions.save(await passkeyLogin([credential]))
    } catch (error) {
      await sessions.clear()
      throw error
    }
  }

  /** Deletes the household's stored session and drops the cached session store. */
  async clearSession(email: string): Promise<void> {
    this.invalidate(email)
    await this.sessionsFor(email).clear()
  }

  private entry(email: string) {
    const key = normalizeEmail(email)
    let entry = this.clients.get(key)
    if (!entry) {
      const credentials = this.credentials
      const sessions = new SessionStore(
        new PgSessionStorage(this.sql, key),
        credentials &&
          (async () => {
            const stored = await credentials.get(key)
            return stored && passkeyLogin(stored)
          }),
      )
      entry = { sessions, client: new WoolworthsClient(sessions) }
      this.clients.set(key, entry)
    }
    return entry
  }
}
