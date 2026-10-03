import type { FastifyRequest } from 'fastify'
import type { LoginFailureDetail } from './google.ts'
import type { TokenRecord, TokenStore } from './tokens.ts'

/**
 * Why a request was rejected, logged as `reason` on every auth failure:
 *
 * - `missing_authorization`: no `Authorization` header and no session cookie.
 * - `unsupported_scheme`: the header's scheme is not `Bearer`.
 * - `empty_token`: the credentials are empty.
 * - `invalid_token`: the token is not one the server issued, or was revoked.
 * - `expired_token`: the token was issued by the server but has expired.
 * - `email_not_allowed`: a valid sign-in or token for an email not in `ALLOWED_EMAILS`.
 * - `invalid_state`: the Google callback's `state` is unknown, expired or already used.
 * - `login_failed`: Google sign-in did not complete (see `detail`).
 * - `invalid_request`: `/auth/start` called with missing or malformed parameters.
 * - `invalid_grant`: `/auth/token` called with an unknown, used or expired code, or a wrong verifier.
 */
export type AuthFailureReason =
  | 'missing_authorization'
  | 'unsupported_scheme'
  | 'empty_token'
  | 'invalid_token'
  | 'expired_token'
  | 'email_not_allowed'
  | 'invalid_state'
  | 'login_failed'
  | 'invalid_request'
  | 'invalid_grant'

export type AuthScheme = 'Bearer' | 'Basic' | 'cookie' | 'other' | 'none'

export interface AuthFailure {
  reason: AuthFailureReason
  authScheme: AuthScheme
  /** The supplied credential; only ever used to derive diagnostics, never logged. */
  token?: string
  /** A fixed, non-sensitive explanation of a `login_failed`. */
  detail?: LoginFailureDetail
}

export const SESSION_COOKIE = 'ps_admin_session'

export type Authentication =
  { ok: true; record: TokenRecord; token: string } | { ok: false; failure: AuthFailure }

function parseAuthorization(header: string): { scheme: AuthScheme; credentials: string } {
  const space = header.indexOf(' ')
  const word = space === -1 ? header : header.slice(0, space)
  const credentials = space === -1 ? '' : header.slice(space + 1)
  // Only known scheme words are reported: a header without a scheme is
  // itself the credential, so echoing its first word would leak it.
  const scheme = /^bearer$/i.test(word) ? 'Bearer' : /^basic$/i.test(word) ? 'Basic' : 'other'
  return { scheme, credentials }
}

/**
 * Authenticates a request by its `Authorization: Bearer <token>` header or,
 * with `acceptCookie`, the admin session cookie when there is no header.
 * Tokens for an email outside `allowedEmails` are rejected.
 */
export async function authenticate(
  request: FastifyRequest,
  tokens: TokenStore,
  allowedEmails: readonly string[],
  acceptCookie: boolean,
): Promise<Authentication> {
  const header = request.headers.authorization
  const cookie = acceptCookie ? readCookie(request.headers.cookie, SESSION_COOKIE) : undefined
  let scheme: AuthScheme
  let credentials: string
  if (header !== undefined) {
    ;({ scheme, credentials } = parseAuthorization(header))
    if (scheme !== 'Bearer') {
      return { ok: false, failure: { reason: 'unsupported_scheme', authScheme: scheme } }
    }
  } else if (cookie !== undefined) {
    scheme = 'cookie'
    credentials = cookie
  } else {
    return { ok: false, failure: { reason: 'missing_authorization', authScheme: 'none' } }
  }
  if (credentials.trim() === '') {
    return {
      ok: false,
      failure: { reason: 'empty_token', authScheme: scheme, token: credentials },
    }
  }
  const check = await tokens.verify(credentials)
  if (!check.ok) {
    return {
      ok: false,
      failure: { reason: check.reason, authScheme: scheme, token: credentials },
    }
  }
  if (!allowedEmails.includes(check.record.email)) {
    return {
      ok: false,
      failure: { reason: 'email_not_allowed', authScheme: scheme, token: credentials },
    }
  }
  return { ok: true, record: check.record, token: credentials }
}

export function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1]
}

/**
 * Logs a single structured `warn` describing an auth rejection. It carries
 * the shape of the supplied token (length, whitespace) but never the token,
 * a code, an ID token, a secret, or any header or cookie.
 */
export function logAuthFailure(request: FastifyRequest, failure: AuthFailure): void {
  const { token } = failure
  request.log.warn(
    {
      reason: failure.reason,
      ...(failure.detail ? { detail: failure.detail } : {}),
      route: request.routeOptions.url ?? requestPath(request),
      method: request.method,
      authScheme: failure.authScheme,
      tokenLength: token?.length ?? 0,
      hasSurroundingWhitespace: token !== undefined && token !== token.trim(),
      userAgent: request.headers['user-agent'],
      ip: request.ip,
      reqId: request.id,
    },
    'auth rejected',
  )
}

export function requestPath(request: FastifyRequest): string {
  return request.url.split('?')[0] ?? request.url
}
