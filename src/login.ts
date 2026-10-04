import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  authenticate,
  logAuthFailure,
  sessionCookie,
  type AuthFailure,
  type AuthFailureReason,
} from './auth.ts'
import type { AppConfig } from './config.ts'
import { admitUser, type Sql } from './db.ts'
import { LoginError, type GoogleOAuth } from './google.ts'
import {
  DEFAULT_TOKEN_TTL_MS,
  hashToken,
  TokenLimitError,
  WEB_SESSION_TTL_MS,
  type TokenClient,
  type TokenStore,
} from './tokens.ts'

/** How long a user has to finish the Google consent screen. */
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000
/** How long a client has to redeem its one-time code. */
const AUTH_CODE_TTL_MS = 60 * 1000

const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/
const API_CLIENTS: readonly TokenClient[] = ['ios', 'extension']
const MAX_CLIENT_STATE_LENGTH = 512

type Destination =
  | { kind: 'web' }
  | {
      kind: 'client'
      client: TokenClient
      redirectUri: string
      state: string
      codeChallenge: string
    }

interface PendingLogin {
  destination: Destination
  nonce: string
  verifier: string
  expiresAt: number
}

interface AuthCode {
  email: string
  client: TokenClient
  codeChallenge: string
  expiresAt: number
}

export interface LoginDeps {
  config: AppConfig
  sql: Sql
  tokens: TokenStore
  google: GoogleOAuth
  now: () => number
}

function random(): string {
  return randomBytes(32).toString('base64url')
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

function sweep<T extends { expiresAt: number }>(map: Map<string, T>, now: number): void {
  for (const [key, value] of map) {
    if (value.expiresAt <= now) {
      map.delete(key)
    }
  }
}

/**
 * The server's side of Google sign-in. Browsers and API clients both start at
 * Google; clients then trade the server's one-time code for a bearer token.
 */
export async function registerLogin(app: FastifyInstance, deps: LoginDeps): Promise<void> {
  const { config, sql, tokens, google, now } = deps
  const pending = new Map<string, PendingLogin>()
  const codes = new Map<string, AuthCode>()
  const rateLimit = {
    rateLimit: { max: config.limits.ipRequestsPerMinute, timeWindow: '1 minute' },
  }
  const secureCookie = config.publicBaseUrl.startsWith('https:')

  function begin(destination: Destination, reply: FastifyReply): void {
    const state = random()
    const nonce = random()
    const verifier = random()
    sweep(pending, now())
    pending.set(state, { destination, nonce, verifier, expiresAt: now() + PENDING_LOGIN_TTL_MS })
    reply.redirect(google.authorizationUrl({ state, nonce, codeChallenge: s256(verifier) }))
  }

  function reject(
    request: FastifyRequest,
    reply: FastifyReply,
    failure: AuthFailure,
    status: number,
    destination: Destination | undefined,
  ): void {
    logAuthFailure(request, failure)
    if (destination?.kind === 'client') {
      reply.redirect(clientRedirect(destination, { error: failure.reason }))
      return
    }
    reply.code(status).type('text/html').send(renderError(failure.reason))
  }

  /** Issues a token, or returns undefined when the user already holds the maximum. */
  async function issueOrLimit(
    email: string,
    client: TokenClient,
    ttlMs: number,
  ): Promise<{ token: string; expiresAt: number } | undefined> {
    try {
      return await tokens.issue(email, client, ttlMs)
    } catch (error) {
      if (error instanceof TokenLimitError) {
        return undefined
      }
      throw error
    }
  }

  function invalidRequest(request: FastifyRequest, reply: FastifyReply): void {
    logAuthFailure(request, { reason: 'invalid_request', authScheme: 'none' })
    reply.code(400).send({ error: 'invalid_request' })
  }

  await app.register(async (routes) => {
    routes.get('/auth/google/login', { config: rateLimit }, async (_request, reply) => {
      begin({ kind: 'web' }, reply)
    })

    routes.get<{ Querystring: Record<string, unknown> }>(
      '/auth/start',
      { config: rateLimit },
      async (request, reply) => {
        const { client, redirect_uri, code_challenge, code_challenge_method, state } = request.query
        if (
          typeof redirect_uri !== 'string' ||
          !config.allowedClientRedirects.includes(redirect_uri) ||
          typeof client !== 'string' ||
          !API_CLIENTS.includes(client as TokenClient) ||
          typeof code_challenge !== 'string' ||
          !CODE_CHALLENGE.test(code_challenge) ||
          (code_challenge_method !== undefined && code_challenge_method !== 'S256') ||
          typeof state !== 'string' ||
          state === '' ||
          state.length > MAX_CLIENT_STATE_LENGTH
        ) {
          return invalidRequest(request, reply)
        }
        begin(
          {
            kind: 'client',
            client: client as TokenClient,
            redirectUri: redirect_uri,
            state,
            codeChallenge: code_challenge,
          },
          reply,
        )
      },
    )

    routes.get<{ Querystring: Record<string, unknown> }>(
      '/auth/google/callback',
      { config: rateLimit },
      async (request, reply) => {
        const { code, state, error } = request.query
        // Looked up and removed in one step: a state is good for one callback.
        const login = typeof state === 'string' ? pending.get(state) : undefined
        if (typeof state === 'string') {
          pending.delete(state)
        }
        if (!login || login.expiresAt <= now()) {
          return reject(
            request,
            reply,
            { reason: 'invalid_state', authScheme: 'none' },
            400,
            undefined,
          )
        }
        const { destination } = login
        if (error !== undefined || typeof code !== 'string') {
          return reject(
            request,
            reply,
            { reason: 'login_failed', authScheme: 'none', detail: 'authorization_denied' },
            401,
            destination,
          )
        }
        let email: string
        try {
          ;({ email } = await google.redeem(code, login.verifier, login.nonce))
        } catch (failure) {
          const detail = failure instanceof LoginError ? failure.detail : 'token_exchange_failed'
          return reject(
            request,
            reply,
            { reason: 'login_failed', authScheme: 'none', detail },
            401,
            destination,
          )
        }
        if ((await admitUser(sql, email, config.limits.maxUsers)) === 'closed') {
          return reject(
            request,
            reply,
            { reason: 'signup_closed', authScheme: 'none' },
            403,
            destination,
          )
        }
        if (destination.kind === 'web') {
          const issued = await issueOrLimit(email, 'web', WEB_SESSION_TTL_MS)
          if (!issued) {
            return reject(
              request,
              reply,
              { reason: 'user_limit', authScheme: 'none' },
              403,
              destination,
            )
          }
          const { token } = issued
          return reply
            .header('set-cookie', sessionCookie(token, WEB_SESSION_TTL_MS / 1000, secureCookie))
            .redirect('/')
        }
        const authCode = random()
        sweep(codes, now())
        codes.set(hashToken(authCode), {
          email,
          client: destination.client,
          codeChallenge: destination.codeChallenge,
          expiresAt: now() + AUTH_CODE_TTL_MS,
        })
        return reply.redirect(clientRedirect(destination, { code: authCode }))
      },
    )

    routes.post<{ Body: { code?: unknown; code_verifier?: unknown } | null }>(
      '/auth/token',
      { config: rateLimit },
      async (request, reply) => {
        const code = request.body?.code
        const verifier = request.body?.code_verifier
        if (typeof code !== 'string' || typeof verifier !== 'string') {
          return invalidRequest(request, reply)
        }
        // Removed before any check, so a failed attempt burns the code.
        const key = hashToken(code)
        const entry = codes.get(key)
        codes.delete(key)
        const challenge = Buffer.from(entry?.codeChallenge ?? '')
        const computed = Buffer.from(s256(verifier))
        if (
          !entry ||
          entry.expiresAt <= now() ||
          !CODE_VERIFIER.test(verifier) ||
          challenge.length !== computed.length ||
          !timingSafeEqual(challenge, computed)
        ) {
          logAuthFailure(request, { reason: 'invalid_grant', authScheme: 'none' })
          return reply.code(400).send({ error: 'invalid_grant' })
        }
        const issued = await issueOrLimit(entry.email, entry.client, DEFAULT_TOKEN_TTL_MS)
        if (!issued) {
          logAuthFailure(request, { reason: 'user_limit', authScheme: 'none' })
          return reply.code(403).send({ error: 'user_limit' })
        }
        const { token, expiresAt } = issued
        return reply
          .header('cache-control', 'no-store')
          .send({ access_token: token, expires_at: new Date(expiresAt).toISOString() })
      },
    )

    routes.post('/auth/logout', { config: rateLimit }, async (request, reply) => {
      const result = await authenticate(request, tokens, false)
      if (!result.ok) {
        logAuthFailure(request, result.failure)
        return reply.code(401).send({ error: 'unauthorized' })
      }
      await tokens.revoke(result.token)
      return reply.code(204).send()
    })
  })
}

function clientRedirect(
  destination: Extract<Destination, { kind: 'client' }>,
  params: Record<string, string>,
): string {
  const url = new URL(destination.redirectUri)
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  url.searchParams.set('state', destination.state)
  return url.toString()
}

const MESSAGES: Partial<Record<AuthFailureReason, string>> = {
  invalid_state: 'This sign-in link has expired or was already used.',
  signup_closed: 'Sign-ups are closed. Only existing users can sign in.',
  user_limit: 'Too many active sign-ins. Sign out of another device and try again.',
}

function renderError(reason: AuthFailureReason): string {
  const message = MESSAGES[reason] ?? 'Sign-in with Google did not complete.'
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>personal-shopper — sign-in failed</title>
</head>
<body style="font-family: system-ui, sans-serif; max-width: 360px; margin: 6rem auto; padding: 0 1rem">
  <p>${message}</p>
  <p><a href="/login">Try again</a></p>
</body>
</html>`
}
