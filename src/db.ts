import postgres, { type Sql, type TransactionSql } from 'postgres'
import { normalizeEmail } from './users/email.ts'

export type { Sql }

/** A connection or a transaction on one. */
export type Queryable = Sql | TransactionSql

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
    await createUser(tx, normalized)
    return 'admitted'
  })
}

/** Inserts a user with `email`, already normalised, into a new household of their own. */
async function createUser(
  tx: Queryable,
  email: string,
): Promise<{ id: string; householdId: string } | undefined> {
  const [household] = await tx<{ id: string }[]>`insert into households default values returning id`
  const householdId = (household as { id: string }).id
  const [user] = await tx<{ id: string }[]>`
    insert into users (email, household_id) values (${email}, ${householdId})
    on conflict (email) do nothing
    returning id`
  if (!user) {
    await tx`delete from households where id = ${householdId}`
    return undefined
  }
  return { id: user.id, householdId }
}

async function ensure(sql: Sql, email: string): Promise<{ id: string; householdId: string }> {
  const normalized = normalizeEmail(email)
  const find = async (q: Queryable) => {
    const [row] = await q<{ id: string; household_id: string }[]>`
      select id, household_id from users where email = ${normalized}`
    return row && { id: row.id, householdId: row.household_id }
  }
  const existing = await find(sql)
  if (existing) {
    return existing
  }
  // Losing a race to a concurrent sign-up of the same email finds the winner's row.
  return sql.begin(
    async (tx) =>
      (await createUser(tx, normalized)) ??
      ((await find(tx)) as { id: string; householdId: string }),
  )
}

/** The id of the user with `email`, creating the user (and their household) on first sight. */
export async function ensureUser(sql: Sql, email: string): Promise<string> {
  return (await ensure(sql, email)).id
}

/** The id of the household of the user with `email`, creating the user on first sight. */
export async function ensureHousehold(sql: Sql, email: string): Promise<string> {
  return (await ensure(sql, email)).householdId
}
