import { createHash, randomBytes } from 'node:crypto'
import type { Queryable, Sql } from './db.ts'
import { normalizeEmail } from './users/email.ts'

export const INVITE_TTL_MS = 24 * 60 * 60 * 1000

/** Serialises membership changes, so a household is never deleted while someone joins it. */
const MEMBERSHIP_LOCK = 293_002

/** Thrown by `HouseholdStore.invite` when the household already holds the maximum of unexpired invites. */
export class InviteLimitError extends Error {
  constructor() {
    super('invite limit reached')
  }
}

export type JoinResult = 'joined' | 'invalid_invite' | 'already_member'
export type LeaveResult = 'left' | 'sole_member'

export function hashInvite(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

/**
 * Households: groups of users who share items, a Woolworths session and a
 * passkey credential. Users are looked up by email; a household is deleted,
 * with its data, when its last member leaves it.
 */
export class HouseholdStore {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => number = Date.now,
    private readonly maxInvites: number = Number.POSITIVE_INFINITY,
  ) {}

  /** The emails in the user's household, sorted. */
  async members(email: string): Promise<string[]> {
    const rows = await this.sql<{ email: string }[]>`
      select m.email from users u join users m on m.household_id = u.household_id
      where u.email = ${normalizeEmail(email)}
      order by m.email`
    return rows.map((row) => row.email)
  }

  /**
   * Mints a single-use invite code to the user's household, valid for 24
   * hours. Only its hash is stored. Throws `InviteLimitError` when the
   * household already holds the maximum of unexpired invites.
   */
  async invite(email: string): Promise<{ code: string; expiresAt: number }> {
    const code = randomBytes(16).toString('base64url')
    const now = this.now()
    const expiresAt = now + INVITE_TTL_MS
    await this.sql.begin(async (tx) => {
      const [user] = await tx<{ id: string; household_id: string }[]>`
        select id, household_id from users where email = ${normalizeEmail(email)}`
      const { id, household_id: householdId } = user as { id: string; household_id: string }
      // Serialises this household's invites, so concurrent ones cannot exceed the cap.
      await tx`select 1 from households where id = ${householdId} for update`
      await tx`delete from household_invites where expires_at <= ${now}`
      const [active] = await tx<{ count: string }[]>`
        select count(*)::text as count from household_invites where household_id = ${householdId}`
      if (Number(active?.count) >= this.maxInvites) {
        throw new InviteLimitError()
      }
      await tx`
        insert into household_invites (code_hash, household_id, created_by, created_at, expires_at)
        values (${hashInvite(code)}, ${householdId}, ${id}, ${now}, ${expiresAt})`
    })
    return { code, expiresAt }
  }

  /** The number of unexpired invites the user's household holds. */
  async activeInvites(email: string): Promise<number> {
    const [row] = await this.sql<{ count: string }[]>`
      select count(*)::text as count from household_invites i
      join users u on u.household_id = i.household_id
      where u.email = ${normalizeEmail(email)} and i.expires_at > ${this.now()}`
    return Number(row?.count)
  }

  /**
   * Moves the user into the household `code` invites to, consuming the code.
   * Their previous household, with its data, is deleted when they were its
   * only member.
   */
  async join(email: string, code: string): Promise<JoinResult> {
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${MEMBERSHIP_LOCK})`
      const [invite] = await tx<{ household_id: string }[]>`
        select household_id from household_invites
        where code_hash = ${hashInvite(code.trim())} and expires_at > ${this.now()}`
      if (!invite) {
        return 'invalid_invite'
      }
      const [user] = await tx<{ id: string; household_id: string }[]>`
        select id, household_id from users where email = ${normalizeEmail(email)}`
      const { id, household_id: previous } = user as { id: string; household_id: string }
      if (previous === invite.household_id) {
        return 'already_member'
      }
      await tx`delete from household_invites where code_hash = ${hashInvite(code.trim())}`
      await tx`update users set household_id = ${invite.household_id} where id = ${id}`
      await deleteIfEmpty(tx, previous)
      return 'joined'
    })
  }

  /**
   * Moves the user into a fresh, empty household. A user who is their
   * household's only member has nothing to leave: that is `sole_member`.
   */
  async leave(email: string): Promise<LeaveResult> {
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${MEMBERSHIP_LOCK})`
      const [user] = await tx<{ id: string; household_id: string }[]>`
        select id, household_id from users where email = ${normalizeEmail(email)}`
      const { id, household_id: previous } = user as { id: string; household_id: string }
      const [others] = await tx<{ count: string }[]>`
        select count(*)::text as count from users where household_id = ${previous} and id <> ${id}`
      if (Number(others?.count) === 0) {
        return 'sole_member'
      }
      const [household] = await tx<{ id: string }[]>`
        insert into households default values returning id`
      await tx`update users set household_id = ${(household as { id: string }).id} where id = ${id}`
      return 'left'
    })
  }

  /** One email per household among `emails`, so shared state is visited once. */
  async onePerHousehold(emails: string[]): Promise<string[]> {
    if (emails.length === 0) {
      return []
    }
    const rows = await this.sql<{ email: string }[]>`
      select distinct on (household_id) email from users
      where email in ${this.sql(emails.map(normalizeEmail))}
      order by household_id, email`
    return rows.map((row) => row.email)
  }
}

async function deleteIfEmpty(tx: Queryable, householdId: string): Promise<void> {
  await tx`
    delete from households h where h.id = ${householdId}
    and not exists (select 1 from users where household_id = h.id)`
}
