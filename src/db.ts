import postgres, { type Sql } from 'postgres'
import { normalizeEmail } from './users/email.ts'

export type { Sql }

/**
 * Connects to Postgres as the privileged role in `url`. The server is the
 * only client of the database. Statements are not prepared, so a pooler in
 * transaction mode (Supabase's) works.
 */
export function connect(url: string): Sql {
  return postgres(url, { prepare: false, onnotice: () => {} })
}

/** The id of the user with `email`, creating the user on first sight. */
export async function ensureUser(sql: Sql, email: string): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    insert into users (email) values (${normalizeEmail(email)})
    on conflict (email) do update set email = excluded.email
    returning id`
  return (user as { id: string }).id
}
