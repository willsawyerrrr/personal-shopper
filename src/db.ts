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

/** Serialises sign-ups so concurrent ones cannot exceed the user cap. */
const SIGNUP_LOCK = 293_001

/**
 * Admits the user with `email`: an existing user always, a new one only while
 * there are fewer than `maxUsers` users, in which case it is created.
 */
export async function admitUser(
  sql: Sql,
  email: string,
  maxUsers: number,
): Promise<'admitted' | 'closed'> {
  const normalized = normalizeEmail(email)
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${SIGNUP_LOCK})`
    const [existing] = await tx`select 1 from users where email = ${normalized}`
    if (existing) {
      return 'admitted'
    }
    const [counted] = await tx<{ count: string }[]>`select count(*)::text as count from users`
    if (Number(counted?.count) >= maxUsers) {
      return 'closed'
    }
    await tx`insert into users (email) values (${normalized})`
    return 'admitted'
  })
}

/** The id of the user with `email`, creating the user on first sight. */
export async function ensureUser(sql: Sql, email: string): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    insert into users (email) values (${normalizeEmail(email)})
    on conflict (email) do update set email = excluded.email
    returning id`
  return (user as { id: string }).id
}
