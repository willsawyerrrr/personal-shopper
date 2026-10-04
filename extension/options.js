import { clearSession, getSession, isExpired, signIn, signOut } from './auth.js'
import { fetchRegistered, removePasskey } from './passkey-api.js'
import { describeStatus } from './passkey-logic.js'

const STATE_KEY = 'passkeyState'

async function init() {
  const serverUrlInput = document.getElementById('serverUrl')
  const status = document.getElementById('status')
  const accountState = document.getElementById('accountState')
  const accountError = document.getElementById('accountError')
  const signInButton = document.getElementById('signIn')
  const signOutButton = document.getElementById('signOut')

  const { serverUrl } = await chrome.storage.local.get('serverUrl')
  if (serverUrl) serverUrlInput.value = serverUrl

  async function renderAccount() {
    const session = await getSession()
    const signedIn = !isExpired(session)
    if (session && !signedIn) await clearSession()
    accountState.textContent = signedIn
      ? `Signed in. Session expires ${new Date(session.expiresAt).toLocaleString()}.`
      : 'Not signed in.'
    signInButton.hidden = signedIn
    signOutButton.hidden = !signedIn
  }

  async function currentServerUrl() {
    const url = serverUrlInput.value.trim()
    if (!url) throw new Error('Enter and save your server URL first.')
    await chrome.storage.local.set({ serverUrl: url })
    return url
  }

  document.getElementById('form').addEventListener('submit', async (event) => {
    event.preventDefault()
    await chrome.storage.local.set({ serverUrl: serverUrlInput.value.trim() })
    status.textContent = 'Saved.'
    setTimeout(() => (status.textContent = ''), 2000)
  })

  signInButton.addEventListener('click', async () => {
    accountError.textContent = ''
    try {
      await signIn(await currentServerUrl())
    } catch (error) {
      accountError.textContent = error.message
    }
    await renderAccount()
  })

  signOutButton.addEventListener('click', async () => {
    accountError.textContent = ''
    await signOut((await chrome.storage.local.get('serverUrl')).serverUrl ?? '')
    await renderAccount()
  })

  const passkeyState = document.getElementById('passkeyState')
  const registerButton = document.getElementById('registerPasskey')
  const cancelButton = document.getElementById('cancelPasskey')
  const removeButton = document.getElementById('removePasskey')

  async function renderPasskey() {
    const { [STATE_KEY]: state } = await chrome.storage.session.get(STATE_KEY)
    const session = await getSession()
    const { serverUrl } = await chrome.storage.local.get('serverUrl')
    let registered
    let error
    if (serverUrl && !isExpired(session)) {
      try {
        registered = await fetchRegistered(serverUrl, session.accessToken)
      } catch (caught) {
        error = caught.message
      }
    }
    const status = error
      ? { text: `Could not check your passkey: ${error}`, variant: 'error', busy: false }
      : describeStatus(state, registered)
    passkeyState.textContent = status.text
    passkeyState.className = status.variant
    registerButton.hidden = status.busy
    registerButton.disabled = registered === undefined
    registerButton.textContent = registered ? 'Replace passkey' : 'Register passkey'
    cancelButton.hidden = !status.busy
    removeButton.hidden = status.busy || !registered
  }

  registerButton.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'passkey/start' })
    await renderPasskey()
  })
  cancelButton.addEventListener('click', () =>
    chrome.runtime.sendMessage({ type: 'passkey/cancel' }),
  )
  removeButton.addEventListener('click', async () => {
    const session = await getSession()
    const { serverUrl } = await chrome.storage.local.get('serverUrl')
    await chrome.storage.session.remove(STATE_KEY)
    try {
      await removePasskey(serverUrl, session.accessToken)
    } catch (error) {
      await chrome.storage.session.set({ [STATE_KEY]: { phase: 'failed', error: error.message } })
    }
    await renderPasskey()
  })
  chrome.storage.session.onChanged.addListener(renderPasskey)
  chrome.storage.local.onChanged.addListener(renderPasskey)

  await renderAccount()
  await renderPasskey()
}

init()
