import { createHash, randomBytes } from 'node:crypto'
import { ensureUser, type Sql } from './db.ts'

export type TokenClient = 'web' | 'ios' | 'extension'

export interface TokenRecord {
  /** SHA-256 of the token, hex; the token itself is never stored. */
  hash: string
  email: string
  client: TokenClient
  createdAt: number
  lastUsedAt: number
  expiresAt: number
}

/** A token record minus its hash, safe to show: `id` is a short hash prefix. */
export interface SessionSummary extends Omit<TokenRecord, 'hash'> {
  id: string
}

export type TokenCheck =
  { ok: true; record: TokenRecord } | { ok: false; reason: 'invalid_token' | 'expired_token' }

/** Thrown by `TokenStore.issue` when the user already holds the maximum of unexpired tokens. */
export class TokenLimitError extends Error {
  constructor() {
    super('token limit reached')
  }
}

export const DEFAULT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000
export const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Expired records are kept this long so a stale token reports `expired_token`. */
const EXPIRED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** Sliding-expiry bumps are written at most this often per token. */
const PERSIST_INTERVAL_MS = 60 * 60 * 1000
const SESSION_ID_LENGTH = 16

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

interface TokenRow {
  hash: string
  email: string
  client: TokenClient
  created_at: string
  last_used_at: string
  expires_at: string
}

function toRecord(row: TokenRow): TokenRecord {
  return {
    hash: row.hash,
    email: row.email,
    client: row.client,
    createdAt: Number(row.created_at),
    lastUsedAt: Number(row.last_used_at),
    expiresAt: Number(row.expires_at),
  }
}

/**
 * Opaque bearer tokens (32 random bytes) stored as SHA-256 hashes in
 * Postgres. Each use slides the token's expiry forward by its lifetime.
 */
export class TokenStore {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => number = Date.now,
    private readonly maxActive: number = Number.POSITIVE_INFINITY,
  ) {}

  /**
   * Mints a token for `email`; `ttlMs` is also the sliding window. Throws
   * `TokenLimitError` when the user already holds the maximum of unexpired tokens.
   */
  async issue(
    email: string,
    client: TokenClient,
    ttlMs: number = DEFAULT_TOKEN_TTL_MS,
  ): Promise<{ token: string; expiresAt: number }> {
    const token = `ps_${randomBytes(32).toString('base64url')}`
    const now = this.now()
    const userId = await ensureUser(this.sql, email)
    const expiresAt = now + ttlMs
    await this.sql.begin(async (tx) => {
      // Serialises this user's issuing, so concurrent sign-ins cannot exceed the cap.
      await tx`select 1 from users where id = ${userId} for update`
      await tx`delete from tokens where expires_at + ${EXPIRED_RETENTION_MS} < ${now}`
      const [active] = await tx<{ count: string }[]>`
        select count(*)::text as count from tokens
        where user_id = ${userId} and expires_at > ${now}`
      if (Number(active?.count) >= this.maxActive) {
        throw new TokenLimitError()
      }
      await tx`
        insert into tokens (hash, user_id, client, created_at, last_used_at, expires_at)
        values (${hashToken(token)}, ${userId}, ${client}, ${now}, ${now}, ${expiresAt})`
    })
    return { token, expiresAt }
  }

  /** Checks `token` and, if valid, slides its expiry forward. */
  async verify(token: string): Promise<TokenCheck> {
    const [row] = await this.sql<TokenRow[]>`
      select t.hash, u.email, t.client, t.created_at, t.last_used_at, t.expires_at
      from tokens t join users u on u.id = t.user_id
      where t.hash = ${hashToken(token)}`
    if (!row) {
      return { ok: false, reason: 'invalid_token' }
    }
    const record = toRecord(row)
    const now = this.now()
    if (record.expiresAt <= now) {
      return { ok: false, reason: 'expired_token' }
    }
    if (now - record.lastUsedAt >= PERSIST_INTERVAL_MS) {
      const expiresAt = now + (record.expiresAt - record.lastUsedAt)
      await this.sql`
        update tokens set last_used_at = ${now}, expires_at = ${expiresAt}
        where hash = ${record.hash}`
      record.lastUsedAt = now
      record.expiresAt = expiresAt
    }
    return { ok: true, record }
  }

  /** Revokes the presented token; returns whether it existed. */
  async revoke(token: string): Promise<boolean> {
    const deleted = await this.sql`delete from tokens where hash = ${hashToken(token)}`
    return deleted.count > 0
  }

  /** Revokes the session whose `id` came from `list`. */
  async revokeById(id: string): Promise<boolean> {
    if (!/^[0-9a-f]+$/.test(id) || id.length !== SESSION_ID_LENGTH) {
      return false
    }
    const deleted = await this.sql`delete from tokens where starts_with(hash, ${id})`
    return deleted.count > 0
  }

  /** Unexpired sessions, newest first. */
  async list(): Promise<SessionSummary[]> {
    const rows = await this.sql<TokenRow[]>`
      select t.hash, u.email, t.client, t.created_at, t.last_used_at, t.expires_at
      from tokens t join users u on u.id = t.user_id
      where t.expires_at > ${this.now()}
      order by t.created_at desc`
    return rows.map(toRecord).map(({ hash, ...rest }) => ({
      id: hash.slice(0, SESSION_ID_LENGTH),
      ...rest,
    }))
  }

  /** The distinct emails with an unexpired session. */
  async emails(): Promise<string[]> {
    return [...new Set((await this.list()).map((session) => session.email))]
  }

  sessionId(record: TokenRecord): string {
    return record.hash.slice(0, SESSION_ID_LENGTH)
  }
}
