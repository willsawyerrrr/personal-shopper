/**
 * Shows the options page with registration requested: navigates an open
 * options tab to it and focuses that tab's window, or opens a new tab when
 * none is open. `api` is the `chrome` namespace (`runtime.getURL`,
 * `runtime.getContexts`, `tabs.update`, `tabs.create`, `windows.update`);
 * `getContexts` finds the tab without the `tabs` permission.
 */
export async function openOptionsForRegistration(api) {
  const base = api.runtime.getURL('options.html')
  const url = `${base}?register=1`
  const contexts = await api.runtime.getContexts({ contextTypes: ['TAB'] })
  const existing = contexts.find(({ documentUrl }) => documentUrl?.split(/[?#]/)[0] === base)
  if (!existing) {
    await api.tabs.create({ url })
    return
  }
  await api.tabs.update(existing.tabId, { url, active: true })
  await api.windows.update(existing.windowId, { focused: true })
}
