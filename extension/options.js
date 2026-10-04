import { clearSession, getSession, isExpired, SERVER_URL, signIn, signOut } from './auth.js'
import { createInvite, fetchMembers, joinHousehold, leaveHousehold } from './household-api.js'
import { fetchRegistered, removePasskey } from './passkey-api.js'
import { describeStatus } from './passkey-logic.js'

const STATE_KEY = 'passkeyState'

async function init() {
  const accountState = document.getElementById('accountState')
  const accountError = document.getElementById('accountError')
  const signInButton = document.getElementById('signIn')
  const signOutButton = document.getElementById('signOut')

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

  signInButton.addEventListener('click', async () => {
    accountError.textContent = ''
    try {
      await signIn()
    } catch (error) {
      accountError.textContent = error.message
    }
    await renderAccount()
    await renderHousehold()
  })

  signOutButton.addEventListener('click', async () => {
    accountError.textContent = ''
    await signOut()
    await renderAccount()
    await renderHousehold()
  })

  const passkeyState = document.getElementById('passkeyState')
  const registerButton = document.getElementById('registerPasskey')
  const cancelButton = document.getElementById('cancelPasskey')
  const removeButton = document.getElementById('removePasskey')

  async function renderPasskey() {
    const { [STATE_KEY]: state } = await chrome.storage.session.get(STATE_KEY)
    const session = await getSession()
    let registered
    let error
    if (!isExpired(session)) {
      try {
        registered = await fetchRegistered(SERVER_URL, session.accessToken)
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

  const householdSection = document.getElementById('household')
  const membersList = document.getElementById('members')
  const inviteState = document.getElementById('inviteState')
  const householdState = document.getElementById('householdState')
  const leaveButton = document.getElementById('leaveHousehold')

  async function renderHousehold() {
    const session = await getSession()
    householdSection.hidden = isExpired(session)
    if (householdSection.hidden) return
    try {
      const members = await fetchMembers(SERVER_URL, session.accessToken)
      membersList.replaceChildren(
        ...members.map(({ email, you }) => {
          const item = document.createElement('li')
          item.textContent = you ? `${email} (you)` : email
          return item
        }),
      )
      leaveButton.hidden = members.length < 2
    } catch (error) {
      householdState.textContent = `Could not load your household: ${error.message}`
      householdState.className = 'error'
    }
  }

  async function householdAction(action) {
    householdState.textContent = ''
    householdState.className = ''
    try {
      const session = await getSession()
      await action(SERVER_URL, session.accessToken)
    } catch (error) {
      householdState.textContent = error.message
      householdState.className = 'error'
    }
    await renderHousehold()
  }

  document.getElementById('createInvite').addEventListener('click', () =>
    householdAction(async (serverUrl, token) => {
      const { code, expiresAt } = await createInvite(serverUrl, token)
      inviteState.textContent = `Code: ${code} (single use, expires ${new Date(expiresAt).toLocaleString()})`
    }),
  )
  document.getElementById('joinHousehold').addEventListener('click', () =>
    householdAction(async (serverUrl, token) => {
      const input = document.getElementById('inviteCode')
      await joinHousehold(serverUrl, token, input.value)
      input.value = ''
      inviteState.textContent = ''
    }),
  )
  leaveButton.addEventListener('click', () =>
    householdAction(async (serverUrl, token) => {
      await leaveHousehold(serverUrl, token)
      inviteState.textContent = ''
    }),
  )

  registerButton.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'passkey/start' })
    await renderPasskey()
  })
  cancelButton.addEventListener('click', () =>
    chrome.runtime.sendMessage({ type: 'passkey/cancel' }),
  )
  removeButton.addEventListener('click', async () => {
    const session = await getSession()
    await chrome.storage.session.remove(STATE_KEY)
    try {
      await removePasskey(SERVER_URL, session.accessToken)
    } catch (error) {
      await chrome.storage.session.set({ [STATE_KEY]: { phase: 'failed', error: error.message } })
    }
    await renderPasskey()
  })
  chrome.storage.session.onChanged.addListener(renderPasskey)
  chrome.storage.local.onChanged.addListener(renderPasskey)

  await renderAccount()
  await renderPasskey()
  await renderHousehold()
}

init()
