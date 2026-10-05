import { IncognitoNotAllowedError } from './passkey-logic.js'

/**
 * Opens the blank tab the registration runs in and returns `{tabId, close}`.
 * Password managers are normally off in Incognito, so the tab opens in a new
 * Incognito window; `close()` removes that window and never rejects. Without
 * Incognito access it rejects with `IncognitoNotAllowedError`, unless
 * `normalWindow` is set, which opens an ordinary tab instead (`close()` then
 * does nothing).
 *
 * `api`: `windows.create`, `windows.remove`, `tabs.create` and
 * `extension.isAllowedIncognitoAccess` of the `chrome` namespace.
 */
export async function openRegistrationTab({ api, normalWindow = false }) {
  if (normalWindow) {
    const tab = await api.tabs.create({ url: 'about:blank' })
    return { tabId: tab.id, close: async () => {} }
  }
  if (!(await api.extension.isAllowedIncognitoAccess())) throw new IncognitoNotAllowedError()
  const win = await api.windows.create({ incognito: true, url: 'about:blank' })
  const close = () => api.windows.remove(win.id).catch(() => {})
  const tabId = win.tabs?.[0]?.id
  if (tabId === undefined) {
    await close()
    throw new Error('Could not open an Incognito window')
  }
  return { tabId, close }
}
