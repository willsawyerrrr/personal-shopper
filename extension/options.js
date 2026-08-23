async function init() {
  const serverUrlInput = document.getElementById('serverUrl')
  const sharedSecretInput = document.getElementById('sharedSecret')
  const status = document.getElementById('status')

  const { serverUrl, sharedSecret } = await chrome.storage.local.get(['serverUrl', 'sharedSecret'])
  if (serverUrl) serverUrlInput.value = serverUrl
  if (sharedSecret) sharedSecretInput.value = sharedSecret

  document.getElementById('form').addEventListener('submit', async (event) => {
    event.preventDefault()
    await chrome.storage.local.set({
      serverUrl: serverUrlInput.value.trim(),
      sharedSecret: sharedSecretInput.value.trim(),
    })
    status.textContent = 'Saved.'
    setTimeout(() => (status.textContent = ''), 2000)
  })
}

init()
