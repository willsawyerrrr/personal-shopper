import { clearSession, getSession, isExpired, SERVER_URL } from './auth.js'
import { uploadPasskey, verifyPasskey } from './passkey-api.js'
import { registerPasskey } from './passkey-flow.js'
import {
  CancelledError,
  IncognitoNotAllowedError,
  UnauthorizedError,
  verifyWithRetries,
} from './passkey-logic.js'
import { openOptionsForRegistration } from './options-tab.js'
import { openRegistrationTab } from './passkey-window.js'

const STATE_KEY = 'passkeyState'
const PROTOCOL_VERSION = '1.3'

let running
let verification

const setState = (state) => chrome.storage.session.set({ [STATE_KEY]: state })

const debuggerApi = {
  attach: (tabId) => chrome.debugger.attach({ tabId }, PROTOCOL_VERSION),
  detach: (tabId) => chrome.debugger.detach({ tabId }),
  send: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params),
}

/**
 * Has the server sign in with the stored passkey a few seconds after it was
 * saved, once the registration window has closed, and records the outcome.
 * A failure is reported only after the retries, so a passkey Woolworths is
 * still accepting never shows an error.
 */
async function verify(accessToken) {
  verification?.abort()
  const controller = new AbortController()
  verification = { abort: () => controller.abort() }
  const current = verification
  await setState({ phase: 'verifying' })
  try {
    await verifyWithRetries({
      verify: () => verifyPasskey(SERVER_URL, accessToken),
      signal: controller.signal,
    })
    await setState({ phase: 'verified' })
  } catch (error) {
    if (error instanceof CancelledError) return
    if (error instanceof UnauthorizedError) await clearSession()
    await setState({ phase: 'unverified', error: error.message })
  } finally {
    if (verification === current) verification = undefined
  }
}

async function start({ normalWindow } = {}) {
  if (running) return
  verification?.abort()
  const controller = new AbortController()
  const abort = () => controller.abort()
  running = { abort }
  let tabId
  let opened
  const onDetach = (source) => source.tabId === tabId && abort()
  const onRemoved = (id) => id === tabId && abort()
  try {
    const session = await getSession()
    if (isExpired(session)) {
      await setState({ phase: 'failed', error: 'Sign in first' })
      return
    }
    chrome.debugger.onDetach.addListener(onDetach)
    chrome.tabs.onRemoved.addListener(onRemoved)
    await setState({ phase: 'registering' })
    await registerPasskey({
      openTab: async () => {
        opened = await openRegistrationTab({ api: chrome, normalWindow })
        return (tabId = opened.tabId)
      },
      close: () => opened?.close(),
      navigate: (id, url) => chrome.tabs.update(id, { url }),
      debuggerApi,
      upload: (credential) => uploadPasskey(SERVER_URL, session.accessToken, credential),
      signal: controller.signal,
      onPhase: (phase) => setState({ phase }),
    })
    void verify(session.accessToken)
  } catch (error) {
    if (error instanceof UnauthorizedError) await clearSession()
    await setState(
      error instanceof CancelledError
        ? { phase: 'cancelled' }
        : error instanceof IncognitoNotAllowedError
          ? { phase: 'needsIncognito' }
          : { phase: 'failed', error: error.message },
    )
  } finally {
    chrome.debugger.onDetach.removeListener(onDetach)
    chrome.tabs.onRemoved.removeListener(onRemoved)
    running = undefined
  }
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'passkey/start') void start({ normalWindow: message.normalWindow })
  if (message?.type === 'passkey/cancel') running?.abort()
  if (message?.type === 'passkey/verify') {
    void getSession().then((session) => {
      if (isExpired(session)) return setState({ phase: 'failed', error: 'Sign in first' })
      return verify(session.accessToken)
    })
  }
  if (message?.type === 'options/open' && sender.tab && sender.origin === SERVER_URL) {
    void openOptionsForRegistration(chrome)
  }
})

// A worker restart loses the registration, so a state left in progress is stale.
chrome.storage.session.get(STATE_KEY).then(({ [STATE_KEY]: state }) => {
  if (state?.phase === 'registering' || state?.phase === 'uploading') {
    void setState({ phase: 'failed', error: 'Registration was interrupted' })
  } else if (state?.phase === 'verifying') {
    void setState({ phase: 'unverified', error: 'the check was interrupted' })
  }
})
