import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto'
import type { PasskeyCredential } from '../users/credentials.ts'
import {
  mergeCookies,
  parseSetCookies,
  REQUIRED_COOKIES,
  SESSION_COOKIES,
  type StoredCookie,
  type StoredSession,
} from './session.ts'

const WOOLWORTHS_URL = 'https://www.woolworths.com.au'
const AUTH_URL = 'https://auth.woolworths.com.au'
const LOGIN_URL = `${WOOLWORTHS_URL}/auth/login?redirect_uri=${WOOLWORTHS_URL}/auth/callback&path=/`
const ACUL_SDK = '@auth0/auth0-acul-react@1.8.0'
const LOGIN_TIMEOUT_MS = 60_000
const MAX_REDIRECTS = 15
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'

export const PASSKEY_REJECTED_MESSAGE =
  'Woolworths passkey login was rejected — the stored credential may have been removed; run `pnpm register-passkey` again'

/**
 * Signs in to Woolworths over plain HTTP with the stored passkey and returns
 * the resulting cookies (every `REQUIRED_COOKIES` entry, including `w-aref`,
 * plus any Akamai cookies the responses set). It walks the Auth0 login
 * redirects, signs the WebAuthn challenge embedded in the identifier page with
 * the first credential's private key (Ed25519, ES256 or RS256) and posts the
 * assertion. Throws a descriptive error if Akamai blocks a request, the
 * passkey is rejected, or login completes without the required cookies.
 */
export async function passkeyLogin(
  credentials: PasskeyCredential[],
  timeoutMs = LOGIN_TIMEOUT_MS,
): Promise<StoredSession> {
  const [credential] = credentials
  const http = new CookieClient(timeoutMs)

  const identifier = await http.follow(LOGIN_URL)
  const html = await identifier.response.text()
  assertNotBlocked(identifier.response, html)
  const challenge = parseChallenge(html)
  const state = new URL(identifier.url).searchParams.get('state')
  if (!state) {
    throw new Error('Woolworths login page did not carry a state parameter')
  }

  const passkey = buildAssertion(credential!, challenge)
  const submitted = await http.request(identifier.url, {
    method: 'POST',
    body: new URLSearchParams({ passkey, state, 'acul-sdk': ACUL_SDK }),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: AUTH_URL,
      Referer: identifier.url,
    },
  })
  if (submitted.status < 300 || submitted.status >= 400) {
    assertNotBlocked(submitted, await submitted.text())
    throw new Error(PASSKEY_REJECTED_MESSAGE)
  }
  const final = await http.follow(submitted.headers.get('location')!, identifier.url)
  assertNotBlocked(final.response, await final.response.text())

  const cookies = http.cookies.filter((cookie) => SESSION_COOKIES.includes(cookie.name))
  const missing = REQUIRED_COOKIES.filter((name) => !cookies.some((cookie) => cookie.name === name))
  if (missing.length > 0) {
    throw new Error(`Missing cookies after passkey login: ${missing.join(', ')}`)
  }
  return { cookies, capturedAt: new Date().toISOString() }
}

class CookieClient {
  cookies: StoredCookie[] = []

  constructor(private readonly timeoutMs: number) {}

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(this.timeoutMs),
      ...init,
      headers: {
        Accept: 'text/html',
        'Accept-Language': 'en-AU,en;q=0.9',
        'User-Agent': USER_AGENT,
        Cookie: this.cookies.map(({ name, value }) => `${name}=${value}`).join('; '),
        ...init.headers,
      },
    })
    this.cookies = mergeCookies(this.cookies, parseSetCookies(response.headers.getSetCookie()))
    return response
  }

  /** Follows redirects to the final non-redirect response and its URL. */
  async follow(url: string, base?: string): Promise<{ response: Response; url: string }> {
    let current = new URL(url, base).toString()
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
      const response = await this.request(current)
      const location = response.headers.get('location')
      if (response.status < 300 || response.status >= 400 || !location) {
        return { response, url: current }
      }
      await response.body?.cancel()
      current = new URL(location, current).toString()
    }
    throw new Error('Woolworths login redirected too many times')
  }
}

function assertNotBlocked(response: Response, body: string): void {
  const html = response.headers.get('content-type')?.includes('text/html') ?? false
  if (response.status === 403 || !html || /access denied/i.test(body)) {
    throw new Error(
      `Akamai blocked the login request (${response.status}${html ? ' "Access Denied"' : ', non-HTML response'}) — the request fingerprint was refused`,
    )
  }
}

// The identifier page embeds its Auth0 context as `JSON.parse(… atob("<base64>") …)`.
function parseChallenge(html: string): string {
  const encoded = /atob\("([A-Za-z0-9+/=]+)"/.exec(html)?.[1]
  try {
    const context = JSON.parse(Buffer.from(encoded!, 'base64').toString())
    const challenge = context.screen.data.passkey.public_key.challenge
    if (typeof challenge === 'string') {
      return challenge
    }
  } catch {
    // fall through
  }
  throw new Error(
    'Woolworths login page carried no passkey challenge — passkey login may no longer be offered',
  )
}

const base64Url = (data: Buffer): string => data.toString('base64url')

/** Builds the JSON WebAuthn assertion the Auth0 identifier form posts. */
function buildAssertion(credential: PasskeyCredential, challenge: string): string {
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      challenge,
      origin: AUTH_URL,
      crossOrigin: false,
    }),
  )
  // rpIdHash, flags (user present + verified), sign count (a Unix timestamp
  // always increases).
  const authenticatorData = Buffer.concat([
    createHash('sha256').update(new URL(AUTH_URL).hostname).digest(),
    Buffer.from([0x05]),
    Buffer.alloc(4),
  ])
  authenticatorData.writeUInt32BE(Math.floor(Date.now() / 1000), 33)
  const signed = Buffer.concat([
    authenticatorData,
    createHash('sha256').update(clientDataJSON).digest(),
  ])

  const id = Buffer.from(String(credential.credentialId), 'base64')
  return JSON.stringify({
    authenticatorAttachment: 'platform',
    clientExtensionResults: {},
    id: base64Url(id),
    rawId: base64Url(id),
    response: {
      authenticatorData: base64Url(authenticatorData),
      clientDataJSON: base64Url(clientDataJSON),
      signature: base64Url(signAssertion(privateKey(credential), signed)),
      userHandle: base64Url(Buffer.from(String(credential.userHandle), 'base64')),
    },
    type: 'public-key',
  })
}

function privateKey(credential: PasskeyCredential): KeyObject {
  try {
    return createPrivateKey({
      key: Buffer.from(String(credential.privateKey), 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
  } catch (error) {
    throw new Error(
      'Stored passkey has no usable private key — run `pnpm register-passkey` again',
      { cause: error },
    )
  }
}

// Ed25519 signatures are raw; ES256 must be DER (not IEEE P1363) in WebAuthn.
function signAssertion(key: KeyObject, data: Buffer): Buffer {
  switch (key.asymmetricKeyType) {
    case 'ed25519':
      return sign(null, data, key)
    case 'ec':
      return sign('sha256', data, { key, dsaEncoding: 'der' })
    case 'rsa':
      return sign('sha256', data, key)
    default:
      throw new Error(`Unsupported passkey key type: ${key.asymmetricKeyType}`)
  }
}
