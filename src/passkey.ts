import { createPrivateKey } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate, logAuthFailure } from './auth.ts'
import type { AppConfig } from './config.ts'
import type { TokenStore } from './tokens.ts'
import type { CredentialStore, PasskeyCredential } from './users/credentials.ts'

const PASSKEY_RATE_LIMIT_MAX = 10
const PASSKEY_RP_ID = 'auth.woolworths.com.au'
const SUPPORTED_KEY_TYPES = ['ed25519', 'ec', 'rsa']

/** What the passkey routes need: the encrypted store and a hook to drop a user's cached session. */
export interface PasskeyOptions {
  credentials: CredentialStore
  /** Called after a user's credential changes, so their next login uses the current one. */
  invalidate: (email: string) => void
}

const text = (value: unknown): value is string => typeof value === 'string' && value !== ''

/** Returns why `credential` cannot be used to sign in to Woolworths, or `undefined` when it can. */
function problemWith(credential: unknown): string | undefined {
  if (typeof credential !== 'object' || credential === null || Array.isArray(credential)) {
    return 'credential must be an object'
  }
  const { rpId, credentialId, userHandle, privateKey } = credential as Record<string, unknown>
  if (rpId !== PASSKEY_RP_ID) {
    return `credential must be for ${PASSKEY_RP_ID}`
  }
  if (!text(credentialId) || !text(userHandle) || !text(privateKey)) {
    return 'credential needs credentialId, userHandle and privateKey'
  }
  try {
    const { asymmetricKeyType } = createPrivateKey({
      key: Buffer.from(privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
    if (!asymmetricKeyType || !SUPPORTED_KEY_TYPES.includes(asymmetricKeyType)) {
      return `unsupported key type: ${asymmetricKeyType}`
    }
  } catch {
    return 'privateKey is not a PKCS#8 private key'
  }
  return undefined
}

/**
 * Picks the credential to store from an upload: the object itself, or the
 * first usable entry of a `WebAuthn.getCredentials` array. Returns the reason
 * it was rejected when there is none.
 */
export function selectCredential(
  body: unknown,
): { ok: true; credential: PasskeyCredential } | { ok: false; error: string } {
  const candidates = Array.isArray(body) ? body : [body]
  let error = 'no credential supplied'
  for (const candidate of candidates) {
    const problem = problemWith(candidate)
    if (!problem) {
      return { ok: true, credential: candidate as PasskeyCredential }
    }
    error = problem
  }
  return { ok: false, error }
}

/**
 * Registers `PUT`, `GET` and `DELETE /woolworths/passkey`, which store,
 * report on and remove the Woolworths passkey of the user the bearer token
 * belongs to. Authorised by a bearer token only, never the web session
 * cookie. Credential content is never logged.
 */
export async function registerPasskey(
  app: FastifyInstance,
  config: AppConfig,
  tokens: TokenStore,
  { credentials, invalidate }: PasskeyOptions,
): Promise<void> {
  await app.register(async (routes) => {
    const emails = new WeakMap<FastifyRequest, string>()
    const rateLimit = { max: PASSKEY_RATE_LIMIT_MAX, timeWindow: '1 minute' }

    routes.addHook('onRequest', async (request, reply) => {
      const result = await authenticate(request, tokens, config.allowedEmails, false)
      if (!result.ok) {
        logAuthFailure(request, result.failure)
        return reply.code(401).send({ error: 'unauthorized' })
      }
      emails.set(request, result.record.email)
    })

    routes.put('/woolworths/passkey', { config: { rateLimit } }, async (request, reply) => {
      const selected = selectCredential(request.body)
      if (!selected.ok) {
        return reply.code(400).send({ error: selected.error })
      }
      const email = emails.get(request) as string
      await credentials.put(email, [selected.credential])
      invalidate(email)
      request.log.info('woolworths passkey registered')
      return { registered: true }
    })

    routes.get('/woolworths/passkey', { config: { rateLimit } }, async (request) => ({
      registered: await credentials.has(emails.get(request) as string),
    }))

    routes.delete('/woolworths/passkey', { config: { rateLimit } }, async (request) => {
      const email = emails.get(request) as string
      await credentials.delete(email)
      invalidate(email)
      request.log.info('woolworths passkey removed')
      return { registered: false }
    })
  })
}
