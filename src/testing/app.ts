import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { AppConfig } from '../config.ts'
import { CLIENT_ID, CLIENT_SECRET, type FakeGoogle, type IdTokenOverrides } from './google.ts'

export const IOS_REDIRECT = 'dev.willsawyerrrr.personalshopper://auth'
export const EXTENSION_REDIRECT = 'https://abcdefghijklmnop.chromiumapp.org/'

export function testConfig(dir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    logLevel: 'silent',
    trustProxy: false,
    googleClientId: CLIENT_ID,
    googleClientSecret: CLIENT_SECRET,
    allowedEmails: ['me@example.com'],
    publicBaseUrl: 'https://shop.example.com',
    allowedClientRedirects: [IOS_REDIRECT, EXTENSION_REDIRECT],
    tokenStorePath: `${dir}/tokens.json`,
    itemsPath: `${dir}/items.yml`,
    sessionPath: `${dir}/session.json`,
    sessionKeepAliveIntervalMs: 0,
    passkeyCredentialsPath: 'passkey-credentials.json',
    remindersSync: undefined,
    ...overrides,
  }
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

/** Signs in through the browser flow and returns the session cookie (`name=value`). */
export async function signInWeb(
  app: FastifyInstance,
  google: FakeGoogle,
  overrides: IdTokenOverrides = {},
): Promise<string> {
  const login = await app.inject({ method: 'GET', url: '/auth/google/login' })
  const { code, state } = google.approve(String(login.headers.location), overrides)
  const callback = await app.inject({
    method: 'GET',
    url: `/auth/google/callback?${new URLSearchParams({ code, state })}`,
  })
  return String(callback.headers['set-cookie']).split(';')[0] ?? ''
}

/** Signs in through the API-client flow and returns the bearer token. */
export async function signInClient(
  app: FastifyInstance,
  google: FakeGoogle,
  options: { client?: string; redirectUri?: string; overrides?: IdTokenOverrides } = {},
): Promise<string> {
  const { verifier, challenge } = pkcePair()
  const start = await app.inject({
    method: 'GET',
    url: `/auth/start?${new URLSearchParams({
      client: options.client ?? 'ios',
      redirect_uri: options.redirectUri ?? IOS_REDIRECT,
      code_challenge: challenge,
      state: 'client-state',
    })}`,
  })
  const { code, state } = google.approve(String(start.headers.location), options.overrides)
  const callback = await app.inject({
    method: 'GET',
    url: `/auth/google/callback?${new URLSearchParams({ code, state })}`,
  })
  const authCode = new URL(String(callback.headers.location)).searchParams.get('code')
  const token = await app.inject({
    method: 'POST',
    url: '/auth/token',
    payload: { code: authCode, code_verifier: verifier },
  })
  return (token.json() as { access_token: string }).access_token
}
