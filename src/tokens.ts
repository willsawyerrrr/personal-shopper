import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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

export const DEFAULT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000
export const WEB_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Expired records are kept this long so a stale token reports `expired_token`. */
const EXPIRED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** Sliding-expiry bumps are written to disk at most this often per token. */
const PERSIST_INTERVAL_MS = 60 * 60 * 1000
const SESSION_ID_LENGTH = 16

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Opaque bearer tokens (32 random bytes) stored as SHA-256 hashes in a JSON
 * file, written atomically. Each use slides the token's expiry forward by its
 * lifetime.
 */
export class TokenStore {
  private records = new Map<string, TokenRecord>()
  private loaded = false
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  /** Reads the file, treating a missing one as empty; a corrupt one throws. */
  async load(): Promise<void> {
    if (this.loaded) {
      return
    }
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      this.loaded = true
      return
    }
    const parsed = JSON.parse(text) as { tokens?: TokenRecord[] }
    if (!Array.isArray(parsed.tokens)) {
      throw new Error(`${this.path} is not a token store`)
    }
    this.records = new Map(parsed.tokens.map((record) => [record.hash, record]))
    this.loaded = true
  }

  /** Mints a token for `email`; `ttlMs` is also the sliding window. */
  async issue(
    email: string,
    client: TokenClient,
    ttlMs: number = DEFAULT_TOKEN_TTL_MS,
  ): Promise<{ token: string; expiresAt: number }> {
    await this.load()
    const token = `ps_${randomBytes(32).toString('base64url')}`
    const now = this.now()
    const record: TokenRecord = {
      hash: hashToken(token),
      email,
      client,
      createdAt: now,
      lastUsedAt: now,
      expiresAt: now + ttlMs,
    }
    for (const [hash, existing] of this.records) {
      if (existing.expiresAt + EXPIRED_RETENTION_MS < now) {
        this.records.delete(hash)
      }
    }
    this.records.set(record.hash, record)
    await this.persist()
    return { token, expiresAt: record.expiresAt }
  }

  /** Checks `token` and, if valid, slides its expiry forward. */
  async verify(token: string): Promise<TokenCheck> {
    await this.load()
    const record = this.records.get(hashToken(token))
    if (!record) {
      return { ok: false, reason: 'invalid_token' }
    }
    const now = this.now()
    if (record.expiresAt <= now) {
      return { ok: false, reason: 'expired_token' }
    }
    const ttlMs = record.expiresAt - record.lastUsedAt
    const stale = now - record.lastUsedAt >= PERSIST_INTERVAL_MS
    record.expiresAt = now + ttlMs
    record.lastUsedAt = now
    if (stale) {
      this.persist().catch(this.onError)
    }
    return { ok: true, record }
  }

  /** Revokes the presented token; returns whether it existed. */
  async revoke(token: string): Promise<boolean> {
    return this.revokeHash(hashToken(token))
  }

  /** Revokes the session whose `id` came from `list`. */
  async revokeById(id: string): Promise<boolean> {
    await this.load()
    const match = [...this.records.keys()].find(
      (hash) => id.length === SESSION_ID_LENGTH && hash.startsWith(id),
    )
    return match !== undefined && this.revokeHash(match)
  }

  /** Unexpired sessions, newest first. */
  async list(): Promise<SessionSummary[]> {
    await this.load()
    const now = this.now()
    return [...this.records.values()]
      .filter((record) => record.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ hash, ...rest }) => ({ id: hash.slice(0, SESSION_ID_LENGTH), ...rest }))
  }

  /** Resolves once every queued write has finished. */
  async flush(): Promise<void> {
    await this.writing
  }

  sessionId(record: TokenRecord): string {
    return record.hash.slice(0, SESSION_ID_LENGTH)
  }

  private async revokeHash(hash: string): Promise<boolean> {
    await this.load()
    if (!this.records.delete(hash)) {
      return false
    }
    await this.persist()
    return true
  }

  // Writes are chained so a slow one never lands after a newer snapshot.
  private persist(): Promise<void> {
    const write = this.writing.then(async () => {
      const temp = `${this.path}.tmp`
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(temp, JSON.stringify({ tokens: [...this.records.values()] }), {
        mode: 0o600,
      })
      await rename(temp, this.path)
    })
    this.writing = write.catch(() => {})
    return write
  }
}
