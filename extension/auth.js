const VERIFIER_LENGTH = 64

export function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

export function randomString(byteLength = VERIFIER_LENGTH) {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)))
}

/** Returns `base64url(SHA-256(verifier))` without padding. */
export async function challengeFor(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64url(new Uint8Array(digest))
}

export function normalizeServerUrl(serverUrl) {
  return serverUrl.trim().replace(/\/+$/, '')
}

export function buildStartUrl(serverUrl, { redirectUri, challenge, state }) {
  const params = new URLSearchParams({
    client: 'extension',
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  })
  return `${normalizeServerUrl(serverUrl)}/auth/start?${params}`
}

/** Returns the authorization code from the redirect URL; throws if `state` differs or the server reported an error. */
export function parseRedirect(redirectUrl, expectedState) {
  const params = new URL(redirectUrl).searchParams
  if (params.get('state') !== expectedState) throw new Error('Sign-in state did not match')
  const error = params.get('error')
  if (error) throw new Error(`Sign-in failed: ${error}`)
  const code = params.get('code')
  if (!code) throw new Error('Sign-in returned no code')
  return code
}

export function isExpired(session, now = Date.now()) {
  return !session?.accessToken || Date.parse(session.expiresAt) <= now
}

export async function getSession() {
  const { accessToken, expiresAt } = await chrome.storage.local.get(['accessToken', 'expiresAt'])
  return accessToken ? { accessToken, expiresAt } : undefined
}

export async function clearSession() {
  await chrome.storage.local.remove(['accessToken', 'expiresAt'])
}

export async function exchangeCode(serverUrl, code, verifier, fetchImpl = fetch) {
  const response = await fetchImpl(`${normalizeServerUrl(serverUrl)}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier }),
  })
  if (!response.ok) throw new Error(`Token exchange failed (${response.status})`)
  const { access_token: accessToken, expires_at: expiresAt } = await response.json()
  if (!accessToken) throw new Error('Token exchange returned no token')
  return { accessToken, expiresAt }
}

export async function signIn(serverUrl) {
  const verifier = randomString()
  const state = randomString(32)
  const redirectUrl = await chrome.identity.launchWebAuthFlow({
    interactive: true,
    url: buildStartUrl(serverUrl, {
      redirectUri: chrome.identity.getRedirectURL(),
      challenge: await challengeFor(verifier),
      state,
    }),
  })
  const code = parseRedirect(redirectUrl, state)
  const session = await exchangeCode(serverUrl, code, verifier)
  await chrome.storage.local.set(session)
  return session
}

export async function signOut(serverUrl, fetchImpl = fetch) {
  const session = await getSession()
  await clearSession()
  if (!session) return
  try {
    await fetchImpl(`${normalizeServerUrl(serverUrl)}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.accessToken}` },
    })
  } catch {
    // Already signed out locally; the server token expires on its own.
  }
}
