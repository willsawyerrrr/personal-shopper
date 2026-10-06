// Runs on the web app's pages. Marks the page so it knows the extension is
// installed, and opens the options page for the web app's "Register passkey"
// link (content scripts cannot call `chrome.runtime.openOptionsPage`).
document.documentElement.dataset.extensionInstalled = ''
document.addEventListener('click', (event) => {
  if (event.target instanceof Element && event.target.closest('[data-open-extension-options]')) {
    event.preventDefault()
    void chrome.runtime.sendMessage({ type: 'options/open' })
  }
})
