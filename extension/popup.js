import { clearSession, getSession, isExpired, normalizeServerUrl, signIn } from './auth.js'

const PRODUCT_PATTERN = /woolworths\.com\.au\/shop\/productdetails\/(\d+)/
const WOOLWORTHS_URL = 'https://www.woolworths.com.au/'

function cleanTitle(title) {
  return (title || '').split('|')[0].trim()
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  return tab
}

async function getPageTitle(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.title,
  })
  return result
}

function setStatus(status, text, variant) {
  status.textContent = text
  status.classList.toggle('error', variant === 'error')
  status.classList.toggle('success', variant === 'success')
}

async function init() {
  const status = document.getElementById('status')
  const form = document.getElementById('form')
  const openWoolworths = document.getElementById('openWoolworths')
  const adminLink = document.getElementById('adminLink')

  const signInButton = document.getElementById('signIn')

  const { serverUrl } = await chrome.storage.local.get('serverUrl')
  if (serverUrl) {
    adminLink.href = `${normalizeServerUrl(serverUrl)}/admin`
    adminLink.hidden = false
  }

  const tab = await getActiveTab()
  if (!tab.url || !PRODUCT_PATTERN.test(tab.url)) {
    setStatus(status, 'Open a Woolworths product page to add an item.')
    form.hidden = true
    openWoolworths.hidden = false
    openWoolworths.addEventListener('click', () => {
      chrome.tabs.create({ url: WOOLWORTHS_URL })
    })
    return
  }

  if (!serverUrl) {
    setStatus(status, "Set your server URL in the extension's options first.")
    form.hidden = true
    return
  }

  let session = await getSession()
  if (isExpired(session)) await clearSession()

  function showSignIn(message) {
    setStatus(status, message, message.startsWith('Sign-in') ? 'error' : undefined)
    form.hidden = true
    signInButton.hidden = false
  }

  signInButton.addEventListener('click', async () => {
    signInButton.disabled = true
    try {
      session = await signIn(serverUrl)
      signInButton.hidden = true
      form.hidden = false
      setStatus(status, '')
    } catch (error) {
      showSignIn(`Sign-in failed: ${error.message}`)
    }
    signInButton.disabled = false
  })

  if (isExpired(session)) {
    showSignIn('Sign in to add items.')
  }

  document.getElementById('url').value = tab.url
  document.getElementById('name').value = cleanTitle(await getPageTitle(tab.id))
  document.getElementById('word').focus()

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    setStatus(status, 'Adding…')
    const body = JSON.stringify({
      word: document.getElementById('word').value,
      url: tab.url,
      name: document.getElementById('name').value,
      quantity: Number(document.getElementById('quantity').value) || 1,
    })
    try {
      const response = await fetch(`${normalizeServerUrl(serverUrl)}/admin/items`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${session.accessToken}`,
        },
        body,
      })
      if (response.status === 401) {
        await clearSession()
        showSignIn('Session expired. Sign in again.')
      } else if (response.ok) {
        setStatus(status, 'Added.', 'success')
      } else {
        setStatus(status, `Failed (${response.status})`, 'error')
      }
    } catch (error) {
      setStatus(status, `Failed: ${error.message}`, 'error')
    }
  })
}

init()
