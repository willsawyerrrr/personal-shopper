import { normalizeServerUrl } from './auth.js'
import { UnauthorizedError } from './passkey-logic.js'

async function call(serverUrl, accessToken, method, path, body, fetchImpl) {
  const response = await fetchImpl(`${normalizeServerUrl(serverUrl)}/admin/household${path}`, {
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
    throw new Error(detail ?? `Server error (${response.status})`)
  }
  return response.status === 204 ? undefined : response.json()
}

/** The household's members: `[{ email, you }]`. */
export async function fetchMembers(serverUrl, accessToken, fetchImpl = fetch) {
  return (await call(serverUrl, accessToken, 'GET', '', undefined, fetchImpl)).members
}

/** Creates a single-use invite: `{ code, expiresAt }`, `expiresAt` in epoch milliseconds. */
export function createInvite(serverUrl, accessToken, fetchImpl = fetch) {
  return call(serverUrl, accessToken, 'POST', '/invites', undefined, fetchImpl)
}

/** Joins the household `code` invites to, discarding the user's own if they were its only member. */
export async function joinHousehold(serverUrl, accessToken, code, fetchImpl = fetch) {
  await call(serverUrl, accessToken, 'POST', '/join', { code: code.trim() }, fetchImpl)
}

/** Moves the user into a new, empty household. */
export async function leaveHousehold(serverUrl, accessToken, fetchImpl = fetch) {
  await call(serverUrl, accessToken, 'POST', '/leave', undefined, fetchImpl)
}
