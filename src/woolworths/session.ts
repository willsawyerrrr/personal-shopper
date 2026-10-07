const BASE_URL = 'https://www.woolworths.com.au'

const REFRESH_COOKIE = 'w-aref'

export const REQUIRED_COOKIES = [
  'w-rctx',
  'wow-auth-token',
  'prodwow-auth-token',
  REFRESH_COOKIE,
] as const

/** Akamai Bot Manager cookies; kept when present but not needed for a valid session. */
const OPTIONAL_COOKIES = ['bm_sv', '_abck', 'ak_bmsc'] as const

export const SESSION_COOKIES: readonly string[] = [...REQUIRED_COOKIES, ...OPTIONAL_COOKIES]

export interface StoredCookie {
  name: string
  value: string
}

export interface StoredSession {
  cookies: StoredCookie[]
  capturedAt: string
}

export const SESSION_EXPIRED_MESSAGE =
  'Woolworths session expired — run `pnpm passkey-login` (or `pnpm capture-session`) to refresh it'

export class SessionRejectedError extends Error {}

/** Where a user's session is kept. */
export interface SessionStorage {
  /** The stored session, or `undefined` when there is none. */
  load(): Promise<StoredSession | undefined>
  save(session: StoredSession): Promise<void>
  /** Deletes the stored session, if any. */
  clear(): Promise<void>
}

// wow-auth-token and prodwow-auth-token are short-lived JWTs (~1hr); treat
// anything older as due for a refresh rather than let a cart call fail on an
// expired token.
const SESSION_LIFETIME_MS = 55 * 60 * 1000

export class SessionStore {
  private refreshing: Promise<StoredSession> | undefined

  /**
   * `login`, when given, runs whenever the heartbeat refresh is rejected and
   * resolves to a fresh session, or `undefined` when no passkey is available.
   */
  constructor(
    private readonly storage: SessionStorage,
    private readonly login?: () => Promise<StoredSession | undefined>,
  ) {}

  /** The stored session; throws the session-expired error when there is none. */
  async load(): Promise<StoredSession> {
    const session = await this.find()
    if (!session) {
      throw new SessionRejectedError(SESSION_EXPIRED_MESSAGE)
    }
    return session
  }

  /** The stored session, or `undefined` when there is none. */
  find(): Promise<StoredSession | undefined> {
    return this.storage.load()
  }

  save(session: StoredSession): Promise<void> {
    return this.storage.save(session)
  }

  clear(): Promise<void> {
    return this.storage.clear()
  }

  isExpired(session: StoredSession): boolean {
    return Date.now() - Date.parse(session.capturedAt) > SESSION_LIFETIME_MS
  }

  toCookieHeader(session: StoredSession): string {
    return session.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  }

  /**
   * Calls `GET /auth/heartbeat` with the stored cookies and persists every
   * re-issued cookie, including the rotated `w-aref`. Concurrent calls share
   * one request (and one fallback login), since each call rotates `w-aref`.
   * A non-200, `refreshed: false`, or a response without a new `w-aref` is a
   * rejection: with a `login` configured it signs in again and persists the
   * result, otherwise (or when `login` finds no passkey) it throws the session-expired error.
   */
  refresh(session: StoredSession): Promise<StoredSession> {
    this.refreshing ??= this.heartbeatOrLogin(session).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  private async heartbeatOrLogin(session: StoredSession): Promise<StoredSession> {
    try {
      return await this.heartbeat(session)
    } catch (error) {
      if (!(error instanceof SessionRejectedError) || !this.login) {
        throw error
      }
      const fresh = await this.login()
      if (!fresh) {
        throw error
      }
      await this.save(fresh)
      return fresh
    }
  }

  private async heartbeat(session: StoredSession): Promise<StoredSession> {
    const response = await fetch(`${BASE_URL}/auth/heartbeat`, {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Referer: `${BASE_URL}/`,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Cookie: this.toCookieHeader(session),
      },
    })
    if (!response.ok) {
      throw new SessionRejectedError(SESSION_EXPIRED_MESSAGE)
    }
    const body = (await response.json().catch(() => undefined)) as
      { refreshed?: boolean } | undefined
    const issued = parseSetCookies(response.headers.getSetCookie())
    if (body?.refreshed !== true || !issued.some((cookie) => cookie.name === REFRESH_COOKIE)) {
      throw new SessionRejectedError(SESSION_EXPIRED_MESSAGE)
    }
    const refreshed: StoredSession = {
      cookies: mergeCookies(session.cookies, issued),
      capturedAt: new Date().toISOString(),
    }
    await this.save(refreshed)
    return refreshed
  }
}

export interface IssuedCookie extends StoredCookie {
  remove: boolean
}

export function parseSetCookies(headers: string[]): IssuedCookie[] {
  return headers.flatMap((header) => {
    const [pair = '', ...attributes] = header.split(';')
    const separator = pair.indexOf('=')
    if (separator <= 0) {
      return []
    }
    const maxAge = attributes
      .map((attribute) => /^\s*max-age\s*=\s*(-?\d+)/i.exec(attribute)?.[1])
      .find((value) => value !== undefined)
    const value = pair.slice(separator + 1).trim()
    return [
      {
        name: pair.slice(0, separator).trim(),
        value,
        remove: value === '' || (maxAge !== undefined && Number(maxAge) <= 0),
      },
    ]
  })
}

export function mergeCookies(existing: StoredCookie[], issued: IssuedCookie[]): StoredCookie[] {
  const jar = new Map(existing.map((cookie) => [cookie.name, cookie.value]))
  for (const { name, value, remove } of issued) {
    if (remove) {
      jar.delete(name)
    } else {
      jar.set(name, value)
    }
  }
  return [...jar].map(([name, value]) => ({ name, value }))
}
