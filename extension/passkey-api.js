import { normalizeServerUrl } from './auth.js'
import { UnauthorizedError } from './passkey-logic.js'

async function call(serverUrl, accessToken, method, body, fetchImpl) {
  const response = await fetchImpl(`${normalizeServerUrl(serverUrl)}/woolworths/passkey`, {
    method,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (response.status === 401) throw new UnauthorizedError()
  if (!response.ok) {
    const detail = await response.json().then(
      (json) => json?.error,
      () => undefined,
    )
    throw new Error(detail ? `${detail} (${response.status})` : `Server error (${response.status})`)
  }
  return response.json()
}

/** Uploads a credential, replacing any registered one. */
export async function uploadPasskey(serverUrl, accessToken, credential, fetchImpl = fetch) {
  await call(serverUrl, accessToken, 'PUT', credential, fetchImpl)
}

/** Whether the signed-in user has a passkey registered. */
export async function fetchRegistered(serverUrl, accessToken, fetchImpl = fetch) {
  return (await call(serverUrl, accessToken, 'GET', undefined, fetchImpl)).registered === true
}

export async function removePasskey(serverUrl, accessToken, fetchImpl = fetch) {
  await call(serverUrl, accessToken, 'DELETE', undefined, fetchImpl)
}
