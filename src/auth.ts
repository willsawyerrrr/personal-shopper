import { createHash, timingSafeEqual } from 'node:crypto'
import type { FastifyRequest } from 'fastify'

/**
 * Why a request was rejected, logged as `reason` on every auth failure:
 *
 * - `missing_authorization`: no `Authorization` header (webhook).
 * - `unsupported_scheme`: the header's scheme is not the one the route expects.
 * - `empty_token`: the scheme is right but carries no credentials.
 * - `secret_mismatch`: the supplied credentials differ from the shared secret.
 * - `no_session`: no `Authorization` header and no valid admin session cookie.
 * - `login_failed`: the admin login form was submitted with the wrong secret.
 */
export type AuthFailureReason =
  | 'missing_authorization'
  | 'unsupported_scheme'
  | 'empty_token'
  | 'secret_mismatch'
  | 'no_session'
  | 'login_failed'

export type AuthScheme = 'Bearer' | 'Basic' | 'other' | 'none'

export interface AuthFailure {
  reason: AuthFailureReason
  authScheme: AuthScheme
  /** The supplied credential; only ever used to derive diagnostics, never logged. */
  token?: string
}

/**
 * Compares two secrets in constant time by hashing both to equal-length
 * digests first, so neither the content nor the length leaks through timing.
 */
export function secretsEqual(supplied: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(supplied), digest(expected))
}

function parseAuthorization(header: string): { scheme: AuthScheme; credentials: string } {
  const space = header.indexOf(' ')
  const word = space === -1 ? header : header.slice(0, space)
  const credentials = space === -1 ? '' : header.slice(space + 1)
  // Only known scheme words are reported: a header without a scheme is
  // itself the credential, so echoing its first word would leak it.
  const scheme = /^bearer$/i.test(word) ? 'Bearer' : /^basic$/i.test(word) ? 'Basic' : 'other'
  return { scheme, credentials }
}

function checkCredentials(
  scheme: AuthScheme,
  credentials: string,
  expectedScheme: 'Bearer' | 'Basic',
  isMatch: (credentials: string) => boolean,
): AuthFailure | undefined {
  if (scheme !== expectedScheme) {
    return { reason: 'unsupported_scheme', authScheme: scheme, token: credentials }
  }
  if (credentials.trim() === '') {
    return { reason: 'empty_token', authScheme: scheme, token: credentials }
  }
  return isMatch(credentials)
    ? undefined
    : { reason: 'secret_mismatch', authScheme: scheme, token: credentials }
}

/** Checks the webhook's `Authorization: Bearer <secret>` header. */
export function verifyBearer(header: string | undefined, secret: string): AuthFailure | undefined {
  if (header === undefined) {
    return { reason: 'missing_authorization', authScheme: 'none' }
  }
  const { scheme, credentials } = parseAuthorization(header)
  return checkCredentials(scheme, credentials, 'Bearer', (token) => secretsEqual(token, secret))
}

/**
 * Checks the admin's `Authorization: Basic base64(admin:<secret>)` header.
 * The reported token is the password part.
 */
export function verifyBasic(header: string | undefined, secret: string): AuthFailure | undefined {
  if (header === undefined) {
    return { reason: 'no_session', authScheme: 'none' }
  }
  const { scheme, credentials } = parseAuthorization(header)
  const failure = checkCredentials(scheme, credentials, 'Basic', (encoded) =>
    secretsEqual(Buffer.from(encoded, 'base64').toString(), `admin:${secret}`),
  )
  if (failure?.token === undefined || failure.reason === 'unsupported_scheme') {
    return failure
  }
  const decoded = Buffer.from(failure.token, 'base64').toString()
  return { ...failure, token: decoded.slice(decoded.indexOf(':') + 1) }
}

/**
 * Logs a single structured `warn` describing an auth rejection. It carries
 * the shape of the supplied token (length, whitespace, whether it matches
 * once trimmed) but never the token, the secret, or any header or cookie.
 */
export function logAuthFailure(
  request: FastifyRequest,
  failure: AuthFailure,
  secret: string,
): void {
  const { token } = failure
  request.log.warn(
    {
      reason: failure.reason,
      route: request.routeOptions.url ?? requestPath(request),
      method: request.method,
      authScheme: failure.authScheme,
      tokenLength: token?.length ?? 0,
      hasSurroundingWhitespace: token !== undefined && token !== token.trim(),
      matchesAfterTrim:
        token !== undefined && token.trim() !== '' && secretsEqual(token.trim(), secret),
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
