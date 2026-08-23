const PRODUCT_PATTERN = /woolworths\.com\.au\/shop\/productdetails\/(\d+)/

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

async function init() {
  const status = document.getElementById('status')
  const form = document.getElementById('form')

  const tab = await getActiveTab()
  if (!tab.url || !PRODUCT_PATTERN.test(tab.url)) {
    status.textContent = 'Open a Woolworths product page first.'
    form.hidden = true
    return
  }

  const { serverUrl, sharedSecret } = await chrome.storage.local.get(['serverUrl', 'sharedSecret'])
  if (!serverUrl || !sharedSecret) {
    status.textContent = "Set your server URL and secret in the extension's options first."
    form.hidden = true
    return
  }

  document.getElementById('url').value = tab.url
  document.getElementById('name').value = cleanTitle(await getPageTitle(tab.id))
  document.getElementById('word').focus()

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    status.textContent = 'Adding…'
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
      status.textContent = response.ok ? 'Added.' : `Failed (${response.status})`
    } catch (error) {
      status.textContent = `Failed: ${error.message}`
    }
  })
}

init()
