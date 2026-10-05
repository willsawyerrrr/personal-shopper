import {
  AUTHENTICATOR_OPTIONS,
  CancelledError,
  LOGIN_URL,
  NAME_PASSKEY_SCRIPT,
  POLL_INTERVAL_MS,
  isTimedOut,
  selectCredential,
} from './passkey-logic.js'

/**
 * Registers a Woolworths passkey with a virtual authenticator attached to a
 * new tab or window and uploads it. Resolves once the credential is uploaded; rejects
 * with `CancelledError` when `signal` aborts, and otherwise with the failure.
 * A script naming the passkey `PASSKEY_NAME` is injected into every document the
 * tab loads. The script and authenticator are always removed and the debugger
 * detached.
 *
 * `deps`: `openTab()` opens a blank tab and returns its ID; `navigate(tabId,
 * url)`; `debuggerApi` has `attach(tabId)`, `detach(tabId)` and
 * `send(tabId, method, params)`; `upload(credential)`; `signal`;
 * `onPhase(phase)`; and optionally `close()` (called last on every exit once
 * the tab is open, to close what `openTab` opened), `sleep(ms)` and `now()`.
 */
export async function registerPasskey({
  openTab,
  navigate,
  debuggerApi,
  upload,
  signal,
  onPhase,
  close = async () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now,
}) {
  const tabId = await openTab()
  let attached = false
  let authenticatorId
  let scriptId
  const send = (method, params) => debuggerApi.send(tabId, method, params)
  const checkCancelled = () => {
    if (signal.aborted) throw new CancelledError()
  }
  try {
    await debuggerApi.attach(tabId)
    attached = true
    await send('WebAuthn.enable')
    ;({ authenticatorId } = await send('WebAuthn.addVirtualAuthenticator', {
      options: AUTHENTICATOR_OPTIONS,
    }))
    await send('Page.enable')
    ;({ identifier: scriptId } = await send('Page.addScriptToEvaluateOnNewDocument', {
      source: NAME_PASSKEY_SCRIPT,
    }))
    checkCancelled()
    await navigate(tabId, LOGIN_URL)

    const startedAt = now()
    for (;;) {
      checkCancelled()
      const { credentials } = await send('WebAuthn.getCredentials', { authenticatorId })
      const credential = selectCredential(credentials)
      if (credential) {
        checkCancelled()
        onPhase('uploading')
        await upload(credential)
        return
      }
      if (isTimedOut(startedAt, now())) {
        throw new Error('Timed out waiting for a passkey to be created')
      }
      await sleep(POLL_INTERVAL_MS)
    }
  } catch (error) {
    // Dismissing the debugging bar or closing the tab aborts the signal and
    // makes the pending command fail.
    if (signal.aborted) throw new CancelledError()
    throw error
  } finally {
    if (attached) {
      if (scriptId) {
        await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId }).catch(
          () => {},
        )
      }
      if (authenticatorId) {
        await send('WebAuthn.removeVirtualAuthenticator', { authenticatorId }).catch(() => {})
      }
      await send('WebAuthn.disable').catch(() => {})
      await debuggerApi.detach(tabId).catch(() => {})
    }
    await close()
  }
}
