import { ensureUser, type Sql } from '../db.ts'
import type { SessionStorage, StoredSession } from '../woolworths/session.ts'
import { normalizeEmail } from './email.ts'

/** A user's Woolworths cookie jar, kept in Postgres. */
export class PgSessionStorage implements SessionStorage {
  constructor(
    private readonly sql: Sql,
    private readonly email: string,
  ) {}

  async load(): Promise<StoredSession | undefined> {
    const [row] = await this.sql<{ cookies: StoredSession['cookies']; captured_at: Date }[]>`
      select s.cookies, s.captured_at from woolworths_sessions s
      join users u on u.id = s.user_id
      where u.email = ${normalizeEmail(this.email)}`
    return row && { cookies: row.cookies, capturedAt: row.captured_at.toISOString() }
  }

  async save(session: StoredSession): Promise<void> {
    const userId = await ensureUser(this.sql, this.email)
    await this.sql`
      insert into woolworths_sessions (user_id, cookies, captured_at)
      values (${userId}, ${this.sql.json(session.cookies as never)}, ${session.capturedAt})
      on conflict (user_id) do update
        set cookies = excluded.cookies, captured_at = excluded.captured_at`
  }
}
