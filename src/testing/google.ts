import { createHash, randomBytes } from 'node:crypto'
import { importJWK, SignJWT, type CryptoKey, type JWK } from 'jose'
import { inject } from 'vitest'

export const CLIENT_ID = 'test-client-id.apps.googleusercontent.com'
export const CLIENT_SECRET = 'test-client-secret'

export interface IdTokenOverrides {
  email?: string
  emailVerified?: boolean | string
  audience?: string
  issuer?: string
  /** Replaces the nonce Google would echo back from the authorization request. */
  nonce?: string
  /** Seconds from now; negative for an already-expired token. */
  expiresIn?: number
  /** Sign with a key that is not in Google's JWKS. */
  signWithOtherKey?: boolean
}

interface IssuedCode {
  overrides: IdTokenOverrides
  nonce: string
  codeChallenge: string
  redirectUri: string
}

async function loadKeyPair(index: number): Promise<{ publicJwk: JWK; privateKey: CryptoKey }> {
  const pair = inject('googleKeyPairs')[index]
  if (!pair) throw new Error(`missing test key pair ${index}`)
  return {
    publicJwk: pair.publicJwk,
    privateKey: (await importJWK(pair.privateJwk, 'RS256')) as CryptoKey,
  }
}

/** A stand-in for Google's authorization, token and JWKS endpoints, served through a `fetch` mock. */
export class FakeGoogle {
  readonly requests: { url: string; body?: URLSearchParams }[] = []
  tokenEndpointDown = false
  private readonly issued = new Map<string, IssuedCode>()

  private constructor(
    private privateKey: CryptoKey,
    private readonly otherKey: CryptoKey,
    private jwks: { keys: JWK[] },
    private readonly now: () => number,
  ) {}

  static async create(now: () => number = Date.now): Promise<FakeGoogle> {
    const [{ publicJwk, privateKey }, other] = await Promise.all([loadKeyPair(0), loadKeyPair(1)])
    const jwk = { ...publicJwk, kid: 'key-1', alg: 'RS256', use: 'sig' }
    return new FakeGoogle(privateKey, other.privateKey, { keys: [jwk] }, now)
  }

  /** Rotates Google's signing key: the old one stops verifying, a new `kid` is published. */
  async rotateKey(): Promise<void> {
    const { publicJwk, privateKey } = await loadKeyPair(2)
    this.jwks = { keys: [{ ...publicJwk, kid: 'key-2', alg: 'RS256', use: 'sig' }] }
    this.privateKey = privateKey
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input)
    const body = init?.body instanceof URLSearchParams ? init.body : undefined
    this.requests.push({ url, ...(body ? { body } : {}) })
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      return Response.json(this.jwks)
    }
    if (url === 'https://oauth2.googleapis.com/token' && body) {
      return this.token(body)
    }
    return new Response('not found', { status: 404 })
  }

  /** Plays the user approving the consent screen: returns what Google redirects back with. */
  approve(
    authorizationUrl: string,
    overrides: IdTokenOverrides = {},
  ): { code: string; state: string } {
    const url = new URL(authorizationUrl)
    const param = (name: string) => url.searchParams.get(name) ?? ''
    expectParam(url, 'client_id', CLIENT_ID)
    expectParam(url, 'response_type', 'code')
    expectParam(url, 'scope', 'openid email')
    expectParam(url, 'code_challenge_method', 'S256')
    const code = randomBytes(16).toString('hex')
    this.issued.set(code, {
      overrides,
      nonce: param('nonce'),
      codeChallenge: param('code_challenge'),
      redirectUri: param('redirect_uri'),
    })
    return { code, state: param('state') }
  }

  private async token(body: URLSearchParams): Promise<Response> {
    const code = body.get('code') ?? ''
    const issued = this.issued.get(code)
    this.issued.delete(code)
    const verifier = body.get('code_verifier') ?? ''
    if (
      this.tokenEndpointDown ||
      !issued ||
      body.get('client_id') !== CLIENT_ID ||
      body.get('client_secret') !== CLIENT_SECRET ||
      body.get('grant_type') !== 'authorization_code' ||
      body.get('redirect_uri') !== issued.redirectUri ||
      createHash('sha256').update(verifier).digest('base64url') !== issued.codeChallenge
    ) {
      return Response.json({ error: 'invalid_grant' }, { status: 400 })
    }
    return Response.json({
      access_token: 'google-access-token',
      id_token: await this.idToken(issued),
    })
  }

  private async idToken({ overrides, nonce }: IssuedCode): Promise<string> {
    const issuedAt = Math.floor(this.now() / 1000)
    return new SignJWT({
      email: overrides.email ?? 'me@example.com',
      email_verified: overrides.emailVerified ?? true,
      nonce: overrides.nonce ?? nonce,
    })
      .setProtectedHeader({ alg: 'RS256', kid: this.kid() })
      .setIssuer(overrides.issuer ?? 'https://accounts.google.com')
      .setAudience(overrides.audience ?? CLIENT_ID)
      .setSubject('1234567890')
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + (overrides.expiresIn ?? 3600))
      .sign(overrides.signWithOtherKey ? this.otherKey : this.privateKey)
  }

  private kid(): string {
    return this.jwks.keys[0]?.kid ?? ''
  }
}

function expectParam(url: URL, name: string, expected: string): void {
  if (url.searchParams.get(name) !== expected) {
    throw new Error(
      `authorization URL has ${name}=${url.searchParams.get(name)}, expected ${expected}`,
    )
  }
}
