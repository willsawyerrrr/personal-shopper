import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet } from 'jose'

const AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs'
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com']
const REQUEST_TIMEOUT_MS = 10_000
const JWKS_MAX_AGE_MS = 60 * 60 * 1000

/** Why a Google sign-in failed; safe to log, never carries tokens or codes. */
export type LoginFailureDetail =
  | 'authorization_denied'
  | 'token_exchange_failed'
  | 'invalid_id_token'
  | 'nonce_mismatch'
  | 'email_unverified'

export class LoginError extends Error {
  constructor(readonly detail: LoginFailureDetail) {
    super(detail)
  }
}

export interface GoogleOptions {
  clientId: string
  clientSecret: string
  /** `${PUBLIC_BASE_URL}/auth/google/callback`. */
  redirectUri: string
  fetch?: typeof fetch
  now?: () => number
}

export interface AuthorizationParams {
  state: string
  nonce: string
  codeChallenge: string
}

/** Google as an OAuth 2.0 / OpenID Connect provider: authorization code flow with PKCE. */
export class GoogleOAuth {
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private jwks: { keys: JSONWebKeySet; fetchedAt: number } | undefined

  constructor(private readonly options: GoogleOptions) {
    this.fetch = options.fetch ?? fetch
    this.now = options.now ?? Date.now
  }

  authorizationUrl({ state, nonce, codeChallenge }: AuthorizationParams): string {
    const url = new URL(AUTHORIZATION_ENDPOINT)
    url.search = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: this.options.redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state,
      nonce,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    }).toString()
    return url.toString()
  }

  /**
   * Redeems the authorization `code` and returns the verified email from the
   * ID token: signature (Google's JWKS), `iss`, `aud`, `exp`, `nonce` and
   * `email_verified` are all checked.
   */
  async redeem(code: string, codeVerifier: string, nonce: string): Promise<{ email: string }> {
    const idToken = await this.exchange(code, codeVerifier)
    const claims = await this.verifyIdToken(idToken)
    if (claims.nonce !== nonce) {
      throw new LoginError('nonce_mismatch')
    }
    if (claims.email_verified !== true || typeof claims.email !== 'string') {
      throw new LoginError('email_unverified')
    }
    return { email: claims.email.toLowerCase() }
  }

  private async exchange(code: string, codeVerifier: string): Promise<string> {
    let body: unknown
    try {
      const response = await this.fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          redirect_uri: this.options.redirectUri,
          grant_type: 'authorization_code',
          code_verifier: codeVerifier,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error('rejected')
      }
      body = await response.json()
    } catch {
      throw new LoginError('token_exchange_failed')
    }
    const idToken = (body as { id_token?: unknown } | null)?.id_token
    if (typeof idToken !== 'string') {
      throw new LoginError('token_exchange_failed')
    }
    return idToken
  }

  private async verifyIdToken(idToken: string): Promise<Record<string, unknown>> {
    const verify = async (keys: JSONWebKeySet) =>
      (
        await jwtVerify(idToken, createLocalJWKSet(keys), {
          issuer: ISSUERS,
          audience: this.options.clientId,
          algorithms: ['RS256'],
          currentDate: new Date(this.now()),
        })
      ).payload
    try {
      try {
        return await verify(await this.keys(false))
      } catch (error) {
        // Google rotates keys; an unknown `kid` may just mean the cache is stale.
        if (!(error instanceof errors.JWKSNoMatchingKey)) {
          throw error
        }
        return await verify(await this.keys(true))
      }
    } catch {
      throw new LoginError('invalid_id_token')
    }
  }

  private async keys(refresh: boolean): Promise<JSONWebKeySet> {
    if (!refresh && this.jwks && this.now() - this.jwks.fetchedAt < JWKS_MAX_AGE_MS) {
      return this.jwks.keys
    }
    const response = await this.fetch(JWKS_URI, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!response.ok) {
      throw new Error('jwks fetch failed')
    }
    const keys = (await response.json()) as JSONWebKeySet
    this.jwks = { keys, fetchedAt: this.now() }
    return keys
  }
}
