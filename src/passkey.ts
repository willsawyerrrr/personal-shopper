import { createPrivateKey } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { authenticate, logAuthFailure } from './auth.ts'
import type { TokenStore } from './tokens.ts'
import type { CredentialStore, PasskeyCredential } from './users/credentials.ts'

/** Per-client-IP limit on the passkey routes, shared with the web app's remove button. */
export const PASSKEY_RATE_LIMIT = { max: 10, timeWindow: '1 minute' }
const PASSKEY_RP_ID = 'auth.woolworths.com.au'
const SUPPORTED_KEY_TYPES = ['ed25519', 'ec', 'rsa']

/** How the passkey routes change a household's stored Woolworths session. */
export interface PasskeySessions {
  /** Signs in with `credential` and stores the result as the household's session. */
  replaceSession(email: string, credential: PasskeyCredential): Promise<void>
  /** Deletes the household's stored session. */
  clearSession(email: string): Promise<void>
}

/** What the passkey routes need: the encrypted store and the household session they keep in step with it. */
export interface PasskeyOptions {
  credentials: CredentialStore
  sessions: PasskeySessions
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

/** Removes `email`'s stored passkey credential and their household's stored Woolworths session. */
export async function removePasskey(
  email: string,
  { credentials, sessions }: PasskeyOptions,
): Promise<void> {
  await credentials.delete(email)
  await sessions.clearSession(email)
}

/**
 * Registers `PUT`, `GET` and `DELETE /woolworths/passkey`, which store,
 * report on and remove the Woolworths passkey of the user the bearer token
 * belongs to. Authorised by a bearer token only, never the web session
 * cookie. Credential content is never logged. `PUT` signs in with the
 * credential at once and replaces the household's stored session with the
 * result; when that fails it answers `502`, keeps the credential and leaves
 * the household with no stored session. `DELETE` also deletes the stored
 * session.
 */
export async function registerPasskey(
  app: FastifyInstance,
  tokens: TokenStore,
  options: PasskeyOptions,
): Promise<void> {
  const { credentials, sessions } = options
  await app.register(async (routes) => {
    const emails = new WeakMap<FastifyRequest, string>()
    const rateLimit = PASSKEY_RATE_LIMIT

    routes.addHook('onRequest', async (request, reply) => {
      const result = await authenticate(request, tokens, false)
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
      try {
        await sessions.replaceSession(email, selected.credential)
      } catch (error) {
        request.log.warn({ err: error }, 'woolworths passkey sign-in failed')
        const reason = error instanceof Error ? error.message : String(error)
        return reply.code(502).send({
          error: `passkey saved, but signing in to Woolworths with it failed: ${reason}`,
        })
      }
      request.log.info('woolworths passkey registered')
      return { registered: true }
    })

    routes.get('/woolworths/passkey', { config: { rateLimit } }, async (request) => ({
      registered: await credentials.has(emails.get(request) as string),
    }))

    routes.delete('/woolworths/passkey', { config: { rateLimit } }, async (request) => {
      await removePasskey(emails.get(request) as string, options)
      request.log.info('woolworths passkey removed')
      return { registered: false }
    })
  })
}
