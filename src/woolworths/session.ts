import { readFile, writeFile } from 'node:fs/promises'

export const REQUIRED_COOKIES = [
  'w-rctx',
  'wow-auth-token',
  'prodwow-auth-token',
  'bm_sv',
  '_abck',
  'ak_bmsc',
] as const

export interface StoredCookie {
  name: string
  value: string
}

export interface StoredSession {
  cookies: StoredCookie[]
  capturedAt: string
}

// wow-auth-token and prodwow-auth-token are short-lived JWTs (~1hr); treat
// anything older as stale rather than let a cart call fail on an expired token.
const SESSION_LIFETIME_MS = 55 * 60 * 1000

export class SessionStore {
  constructor(private readonly path: string) {}

  async load(): Promise<StoredSession> {
    const raw = await readFile(this.path, 'utf8')
    return JSON.parse(raw) as StoredSession
  }

  async save(session: StoredSession): Promise<void> {
    await writeFile(this.path, JSON.stringify(session, null, 2), 'utf8')
  }

  isExpired(session: StoredSession): boolean {
    return Date.now() - Date.parse(session.capturedAt) > SESSION_LIFETIME_MS
  }

  toCookieHeader(session: StoredSession): string {
    return session.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  }
}
