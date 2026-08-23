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

  const { serverUrl, sharedSecret } = await chrome.storage.local.get(['serverUrl', 'sharedSecret'])
  if (!serverUrl || !sharedSecret) {
    setStatus(status, "Set your server URL and secret in the extension's options first.")
    form.hidden = true
    return
  }

  document.getElementById('url').value = tab.url
  document.getElementById('name').value = cleanTitle(await getPageTitle(tab.id))
  document.getElementById('word').focus()

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    setStatus(status, 'Adding…')
    const body = new URLSearchParams({
      word: document.getElementById('word').value,
      url: tab.url,
      name: document.getElementById('name').value,
      quantity: document.getElementById('quantity').value || '1',
    })
    try {
      const response = await fetch(`${serverUrl.replace(/\/$/, '')}/admin/items`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${btoa(`admin:${sharedSecret}`)}`,
        },
        body,
      })
      if (response.ok) {
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
