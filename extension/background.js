import { clearSession, getSession, isExpired, SERVER_URL } from './auth.js'
import { uploadPasskey } from './passkey-api.js'
import { registerPasskey } from './passkey-flow.js'
import { CancelledError, IncognitoNotAllowedError, UnauthorizedError } from './passkey-logic.js'
import { openRegistrationTab } from './passkey-window.js'

const STATE_KEY = 'passkeyState'
const PROTOCOL_VERSION = '1.3'

let running

const setState = (state) => chrome.storage.session.set({ [STATE_KEY]: state })

const debuggerApi = {
  attach: (tabId) => chrome.debugger.attach({ tabId }, PROTOCOL_VERSION),
  detach: (tabId) => chrome.debugger.detach({ tabId }),
  send: (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params),
}

async function start({ normalWindow } = {}) {
  if (running) return
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
    await setState({ phase: 'idle' })
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

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'passkey/start') void start({ normalWindow: message.normalWindow })
  if (message?.type === 'passkey/cancel') running?.abort()
  if (message?.type === 'options/open') void chrome.runtime.openOptionsPage()
})

// A worker restart loses the registration, so a state left in progress is stale.
chrome.storage.session.get(STATE_KEY).then(({ [STATE_KEY]: state }) => {
  if (state?.phase === 'registering' || state?.phase === 'uploading') {
    void setState({ phase: 'failed', error: 'Registration was interrupted' })
  }
})
