import { clearSession, getSession, isExpired, signIn, signOut } from './auth.js'

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

  await renderAccount()
}

init()
