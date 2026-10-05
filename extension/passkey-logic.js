export const RP_ID = 'auth.woolworths.com.au'
export const LOGIN_URL = 'https://www.woolworths.com.au/shop/securelogin'
export const REGISTRATION_TIMEOUT_MS = 10 * 60 * 1000
export const POLL_INTERVAL_MS = 1000

/** The virtual authenticator Woolworths' passkey prompt is answered by. */
export const AUTHENTICATOR_OPTIONS = {
  protocol: 'ctap2',
  transport: 'internal',
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: true,
  automaticPresenceSimulation: true,
}

/** The name the registered passkey is given, so it is recognisable in a password manager or account page. */
export const PASSKEY_NAME = 'Personal Shopper'

/**
 * Page script that wraps `navigator.credentials.create` so a `publicKey`
 * request is made with `user.name` and `user.displayName` set to
 * `PASSKEY_NAME`. The options are copied, never mutated, and nothing else
 * (`user.id`, `challenge`, `rp`, `pubKeyCredParams`, `excludeCredentials`) is
 * touched. Other calls, results and errors pass through unchanged.
 */
export const NAME_PASSKEY_SCRIPT = `(() => {
  const credentials = navigator.credentials
  if (!credentials) return
  const create = credentials.create
  credentials.create = function (options) {
    const user = options?.publicKey?.user
    if (user) {
      const name = ${JSON.stringify(PASSKEY_NAME)}
      options = { ...options, publicKey: { ...options.publicKey, user: { ...user, name, displayName: name } } }
    }
    return create.call(this, options)
  }
})()`

const filled = (value) => typeof value === 'string' && value !== ''

/** Returns the first credential the server can sign in with: for Woolworths' RP ID, with an ID, user handle and private key. */
export function selectCredential(credentials) {
  return (credentials ?? []).find(
    (credential) =>
      credential?.rpId === RP_ID &&
      filled(credential.credentialId) &&
      filled(credential.userHandle) &&
      filled(credential.privateKey),
  )
}

/** Whether a registration started at `startedAt` (epoch ms) has run out of time. */
export function isTimedOut(startedAt, now = Date.now()) {
  return now - startedAt > REGISTRATION_TIMEOUT_MS
}

/**
 * Describes a registration state (`{phase, error?}`, phase one of `idle`,
 * `registering`, `uploading`, `needsIncognito`, `incognitoReady`, `failed`, `cancelled`) and the server's answer
 * (`registered`: a boolean, or `undefined` when unknown) for display.
 */
export function describeStatus(state, registered) {
  switch (state?.phase) {
    case 'registering':
      return {
        text: 'Log in to Woolworths in the new window and accept the prompt to create a passkey.',
        variant: 'info',
        busy: true,
      }
    case 'needsIncognito':
      return {
        text: 'Registration opens an Incognito window, where password managers are off. Turn on "Allow in Incognito" for this extension, then register again.',
        variant: 'info',
        busy: false,
        incognitoHelp: true,
      }
    case 'incognitoReady':
      return {
        text: 'Incognito access enabled — press Register passkey.',
        variant: 'success',
        busy: false,
      }
    case 'uploading':
      return { text: 'Saving your passkey…', variant: 'info', busy: true }
    case 'failed':
      return { text: `Passkey error: ${state.error}`, variant: 'error', busy: false }
    case 'cancelled':
      return { text: 'Registration cancelled.', variant: 'error', busy: false }
  }
  if (registered === true) {
    return { text: 'Passkey registered.', variant: 'success', busy: false }
  }
  if (registered === false) {
    return { text: 'No passkey registered.', variant: 'info', busy: false }
  }
  return { text: '', variant: 'info', busy: false }
}

/**
 * Whether a registration waiting on `needsIncognito` can proceed: the extension
 * now has Incognito access, according to `isAllowed` (an async function, e.g.
 * `chrome.extension.isAllowedIncognitoAccess`).
 */
export async function incognitoWasGranted(state, isAllowed) {
  return state?.phase === 'needsIncognito' && (await isAllowed())
}

export class CancelledError extends Error {
  constructor() {
    super('Registration cancelled')
    this.name = 'CancelledError'
  }
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Session expired. Sign in again')
    this.name = 'UnauthorizedError'
  }
}

export class IncognitoNotAllowedError extends Error {
  constructor() {
    super('Incognito access is not allowed for this extension')
    this.name = 'IncognitoNotAllowedError'
  }
}
