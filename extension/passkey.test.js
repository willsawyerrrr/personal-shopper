import { describe, expect, it, vi } from 'vitest'
import { fetchRegistered, removePasskey, uploadPasskey } from './passkey-api.js'
import { registerPasskey } from './passkey-flow.js'
import { openOptionsForRegistration } from './options-tab.js'
import { openRegistrationTab } from './passkey-window.js'
import {
  AUTHENTICATOR_OPTIONS,
  CancelledError,
  IncognitoNotAllowedError,
  incognitoWasGranted,
  REGISTRATION_TIMEOUT_MS,
  UnauthorizedError,
  decideAutoRegister,
  describeStatus,
  isTimedOut,
  selectCredential,
  withoutAutoRegister,
} from './passkey-logic.js'

const credential = (overrides = {}) => ({
  credentialId: 'Y3JlZA==',
  isResidentCredential: true,
  rpId: 'auth.woolworths.com.au',
  privateKey: 'a2V5',
  userHandle: 'dXNlcg==',
  signCount: 0,
  ...overrides,
})

describe('selectCredential', () => {
  it('returns the first credential for the Woolworths RP ID with every required field', () => {
    const usable = credential({ credentialId: 'b3Ro' })
    expect(
      selectCredential([
        credential({ rpId: 'example.com' }),
        credential({ privateKey: '' }),
        credential({ userHandle: undefined }),
        usable,
        credential(),
      ]),
    ).toBe(usable)
  })

  it('returns nothing when none is usable', () => {
    expect(selectCredential([])).toBeUndefined()
    expect(selectCredential(undefined)).toBeUndefined()
    expect(selectCredential([null, credential({ rpId: 'example.com' })])).toBeUndefined()
  })
})

describe('isTimedOut', () => {
  it('times out after the registration window', () => {
    expect(isTimedOut(1000, 1000 + REGISTRATION_TIMEOUT_MS)).toBe(false)
    expect(isTimedOut(1000, 1001 + REGISTRATION_TIMEOUT_MS)).toBe(true)
  })
})

describe('describeStatus', () => {
  it('describes each phase', () => {
    expect(describeStatus({ phase: 'registering' }, false)).toMatchObject({ busy: true })
    expect(describeStatus({ phase: 'uploading' })).toMatchObject({ busy: true })
    expect(describeStatus({ phase: 'failed', error: 'nope' })).toMatchObject({
      variant: 'error',
      text: expect.stringContaining('nope'),
      busy: false,
    })
    expect(describeStatus({ phase: 'cancelled' })).toMatchObject({ variant: 'error' })
    expect(describeStatus({ phase: 'needsIncognito' })).toMatchObject({
      text: expect.stringContaining('Allow in Incognito'),
      busy: false,
      incognitoHelp: true,
    })
  })

  it('announces Incognito access once granted', () => {
    expect(describeStatus({ phase: 'incognitoReady' })).toMatchObject({
      text: 'Incognito access enabled — press Register passkey.',
      variant: 'success',
      busy: false,
    })
  })

  it('detects Incognito access granted while waiting for it', async () => {
    const needs = { phase: 'needsIncognito' }
    expect(await incognitoWasGranted(needs, async () => true)).toBe(true)
    expect(await incognitoWasGranted(needs, async () => false)).toBe(false)
    const isAllowed = vi.fn(async () => true)
    expect(await incognitoWasGranted({ phase: 'failed' }, isAllowed)).toBe(false)
    expect(await incognitoWasGranted(undefined, isAllowed)).toBe(false)
    expect(isAllowed).not.toHaveBeenCalled()
  })

  it('falls back to the server answer', () => {
    expect(describeStatus({ phase: 'idle' }, true)).toMatchObject({ variant: 'success' })
    expect(describeStatus(undefined, false).text).toBe('No passkey registered.')
    expect(describeStatus(undefined, undefined).text).toBe('')
  })
})

describe('passkey API', () => {
  const ok = (body) => vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => body })

  it('uploads the credential with the bearer token', async () => {
    const fetchImpl = ok({ registered: true })
    await uploadPasskey('https://example.test/', 't', credential(), fetchImpl)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://example.test/woolworths/passkey')
    expect(init.method).toBe('PUT')
    expect(init.headers.Authorization).toBe('Bearer t')
    expect(JSON.parse(init.body)).toEqual(credential())
  })

  it('reads and removes the registration', async () => {
    expect(await fetchRegistered('https://example.test', 't', ok({ registered: true }))).toBe(true)
    const fetchImpl = ok({ registered: false })
    await removePasskey('https://example.test', 't', fetchImpl)
    expect(fetchImpl.mock.calls[0][1].method).toBe('DELETE')
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined()
  })

  it('maps 401 to an unauthorized error and surfaces server messages', async () => {
    await expect(
      fetchRegistered('https://example.test', 't', vi.fn().mockResolvedValue({ status: 401 })),
    ).rejects.toBeInstanceOf(UnauthorizedError)
    const rejected = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: 'bad credential' }),
    })
    await expect(uploadPasskey('https://example.test', 't', {}, rejected)).rejects.toThrow(
      'bad credential (400)',
    )
    const broken = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error('not json')
      },
    })
    await expect(removePasskey('https://example.test', 't', broken)).rejects.toThrow(
      'Server error (500)',
    )
  })
})

describe('registerPasskey', () => {
  function setup({ credentialsByPoll = [[credential()]], aborted = false } = {}) {
    const controller = new AbortController()
    if (aborted) controller.abort()
    const polls = [...credentialsByPoll]
    const calls = []
    const debuggerApi = {
      attach: vi.fn(async () => calls.push('attach')),
      detach: vi.fn(async () => calls.push('detach')),
      send: vi.fn(async (_tabId, method) => {
        calls.push(method)
        if (method === 'WebAuthn.addVirtualAuthenticator') return { authenticatorId: 'auth-1' }
        if (method === 'WebAuthn.getCredentials') {
          return { credentials: polls.length > 1 ? polls.shift() : polls[0] }
        }
        return {}
      }),
    }
    const deps = {
      openTab: vi.fn(async () => 7),
      close: vi.fn(async () => calls.push('close')),
      navigate: vi.fn(async () => calls.push('navigate')),
      debuggerApi,
      upload: vi.fn(async () => calls.push('upload')),
      signal: controller.signal,
      onPhase: vi.fn(),
      sleep: vi.fn(async () => {}),
      now: () => 0,
    }
    return { deps, calls, controller, debuggerApi }
  }

  it('registers the authenticator, waits for a credential, uploads it and cleans up', async () => {
    const { deps, calls, debuggerApi } = setup({ credentialsByPoll: [[], [], [credential()]] })
    await registerPasskey(deps)
    expect(calls).toEqual([
      'attach',
      'WebAuthn.enable',
      'WebAuthn.addVirtualAuthenticator',
      'navigate',
      'WebAuthn.getCredentials',
      'WebAuthn.getCredentials',
      'WebAuthn.getCredentials',
      'upload',
      'WebAuthn.removeVirtualAuthenticator',
      'WebAuthn.disable',
      'detach',
      'close',
    ])
    expect(debuggerApi.send).toHaveBeenCalledWith(7, 'WebAuthn.addVirtualAuthenticator', {
      options: AUTHENTICATOR_OPTIONS,
    })
    expect(debuggerApi.send).toHaveBeenCalledWith(7, 'WebAuthn.removeVirtualAuthenticator', {
      authenticatorId: 'auth-1',
    })
    expect(deps.upload).toHaveBeenCalledWith(credential())
    expect(deps.onPhase).toHaveBeenCalledWith('uploading')
  })

  it('ignores credentials for other relying parties', async () => {
    const { deps } = setup({
      credentialsByPoll: [[credential({ rpId: 'example.com' })], [credential()]],
    })
    await registerPasskey(deps)
    expect(deps.upload).toHaveBeenCalledWith(credential())
  })

  it('cleans up and reports cancellation', async () => {
    const { deps, calls, controller } = setup({ credentialsByPoll: [[]] })
    deps.sleep = vi.fn(async () => controller.abort())
    await expect(registerPasskey(deps)).rejects.toBeInstanceOf(CancelledError)
    expect(deps.upload).not.toHaveBeenCalled()
    expect(calls.slice(-4)).toEqual([
      'WebAuthn.removeVirtualAuthenticator',
      'WebAuthn.disable',
      'detach',
      'close',
    ])
  })

  it('reports cancellation when the debugger is detached mid-command', async () => {
    const { deps, controller, debuggerApi } = setup({ credentialsByPoll: [[]] })
    const send = debuggerApi.send.getMockImplementation()
    debuggerApi.send.mockImplementation(async (tabId, method, params) => {
      if (method === 'WebAuthn.getCredentials') {
        controller.abort()
        throw new Error('Detached while handling command')
      }
      return send(tabId, method, params)
    })
    await expect(registerPasskey(deps)).rejects.toBeInstanceOf(CancelledError)
  })

  it('times out and cleans up', async () => {
    const { deps, calls } = setup({ credentialsByPoll: [[]] })
    let time = 0
    deps.now = () => (time += REGISTRATION_TIMEOUT_MS)
    await expect(registerPasskey(deps)).rejects.toThrow(/Timed out/)
    expect(calls.slice(-2)).toEqual(['detach', 'close'])
  })

  it('cleans up when the upload fails', async () => {
    const { deps, calls } = setup()
    deps.upload = vi.fn().mockRejectedValue(new Error('Server error (500)'))
    await expect(registerPasskey(deps)).rejects.toThrow('Server error (500)')
    expect(calls.slice(-4)).toEqual([
      'WebAuthn.removeVirtualAuthenticator',
      'WebAuthn.disable',
      'detach',
      'close',
    ])
  })

  it('does not detach when attaching failed', async () => {
    const { deps, debuggerApi } = setup()
    debuggerApi.attach.mockRejectedValue(new Error('Another debugger is attached'))
    await expect(registerPasskey(deps)).rejects.toThrow('Another debugger')
    expect(debuggerApi.detach).not.toHaveBeenCalled()
    expect(deps.close).toHaveBeenCalledOnce()
  })

  it('does not close anything when opening the tab failed', async () => {
    const { deps } = setup()
    deps.openTab = vi.fn().mockRejectedValue(new IncognitoNotAllowedError())
    await expect(registerPasskey(deps)).rejects.toBeInstanceOf(IncognitoNotAllowedError)
    expect(deps.close).not.toHaveBeenCalled()
  })

  it('closes after the debugger is detached mid-command', async () => {
    const { deps, controller, debuggerApi, calls } = setup({ credentialsByPoll: [[]] })
    const send = debuggerApi.send.getMockImplementation()
    debuggerApi.send.mockImplementation(async (tabId, method, params) => {
      if (method === 'WebAuthn.getCredentials') {
        controller.abort()
        throw new Error('Detached while handling command')
      }
      return send(tabId, method, params)
    })
    await expect(registerPasskey(deps)).rejects.toBeInstanceOf(CancelledError)
    expect(calls.at(-1)).toBe('close')
  })

  it('finishes cleanup even when removing the authenticator fails', async () => {
    const { deps, debuggerApi } = setup()
    const send = debuggerApi.send.getMockImplementation()
    debuggerApi.send.mockImplementation(async (tabId, method, params) => {
      if (method === 'WebAuthn.removeVirtualAuthenticator') throw new Error('gone')
      return send(tabId, method, params)
    })
    await registerPasskey(deps)
    expect(debuggerApi.detach).toHaveBeenCalledWith(7)
  })
})

describe('openRegistrationTab', () => {
  function setup({ allowed = true, windowTabs = [{ id: 9 }] } = {}) {
    const api = {
      extension: { isAllowedIncognitoAccess: vi.fn(async () => allowed) },
      windows: {
        create: vi.fn(async () => ({ id: 3, tabs: windowTabs })),
        remove: vi.fn(async () => {}),
      },
      tabs: { create: vi.fn(async () => ({ id: 5 })) },
    }
    return api
  }

  it('opens an Incognito window and removes it on close', async () => {
    const api = setup()
    const { tabId, close } = await openRegistrationTab({ api })
    expect(api.windows.create).toHaveBeenCalledWith({ incognito: true, url: 'about:blank' })
    expect(tabId).toBe(9)
    expect(api.windows.remove).not.toHaveBeenCalled()
    await close()
    expect(api.windows.remove).toHaveBeenCalledWith(3)
    expect(api.tabs.create).not.toHaveBeenCalled()
  })

  it('tolerates the window already being closed', async () => {
    const api = setup()
    api.windows.remove.mockRejectedValue(new Error('No window with id: 3'))
    const { close } = await openRegistrationTab({ api })
    await expect(close()).resolves.toBeUndefined()
  })

  it('removes a window that has no tab', async () => {
    const api = setup({ windowTabs: [] })
    await expect(openRegistrationTab({ api })).rejects.toThrow('Incognito window')
    expect(api.windows.remove).toHaveBeenCalledWith(3)
  })

  it('asks for Incognito access instead of opening any window', async () => {
    const api = setup({ allowed: false })
    await expect(openRegistrationTab({ api })).rejects.toBeInstanceOf(IncognitoNotAllowedError)
    expect(api.windows.create).not.toHaveBeenCalled()
    expect(api.tabs.create).not.toHaveBeenCalled()
  })

  it('opens a normal tab on request, without checking Incognito access', async () => {
    const api = setup({ allowed: false })
    const { tabId, close } = await openRegistrationTab({ api, normalWindow: true })
    expect(tabId).toBe(5)
    expect(api.tabs.create).toHaveBeenCalledWith({ url: 'about:blank' })
    await close()
    expect(api.windows.remove).not.toHaveBeenCalled()
    expect(api.extension.isAllowedIncognitoAccess).not.toHaveBeenCalled()
  })
})

describe('decideAutoRegister', () => {
  const ready = { search: '?register=1', signedIn: true, state: undefined, incognitoAllowed: true }

  it('starts when requested, signed in, idle and Incognito is allowed', () => {
    expect(decideAutoRegister(ready)).toEqual({ start: true })
    expect(decideAutoRegister({ ...ready, state: { phase: 'failed', error: 'x' } })).toEqual({
      start: true,
    })
  })

  it('skips without the parameter or with another value', () => {
    for (const search of ['', '?other=1', '?register=0']) {
      expect(decideAutoRegister({ ...ready, search })).toEqual({
        start: false,
        reason: 'not-requested',
      })
    }
  })

  it('skips when signed out', () => {
    expect(decideAutoRegister({ ...ready, signedIn: false })).toEqual({
      start: false,
      reason: 'signed-out',
    })
  })

  it('skips while a registration is running', () => {
    for (const phase of ['registering', 'uploading']) {
      expect(decideAutoRegister({ ...ready, state: { phase } })).toEqual({
        start: false,
        reason: 'running',
      })
    }
  })

  it('skips without Incognito access', () => {
    expect(decideAutoRegister({ ...ready, incognitoAllowed: false })).toEqual({
      start: false,
      reason: 'needs-incognito',
    })
  })
})

describe('withoutAutoRegister', () => {
  it('removes only the register parameter', () => {
    expect(withoutAutoRegister('?register=1')).toBe('')
    expect(withoutAutoRegister('?a=b&register=1')).toBe('?a=b')
    expect(withoutAutoRegister('')).toBe('')
  })
})

describe('openOptionsForRegistration', () => {
  const options = 'chrome-extension://id/options.html'
  const api = (contexts) => ({
    runtime: {
      getURL: (path) => `chrome-extension://id/${path}`,
      getContexts: vi.fn().mockResolvedValue(contexts),
    },
    tabs: { create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
    windows: { update: vi.fn().mockResolvedValue({}) },
  })

  it('opens a new tab when no options tab is open', async () => {
    const chrome = api([{ documentUrl: 'chrome-extension://id/popup.html', tabId: 1, windowId: 1 }])
    await openOptionsForRegistration(chrome)
    expect(chrome.runtime.getContexts).toHaveBeenCalledWith({ contextTypes: ['TAB'] })
    expect(chrome.tabs.create).toHaveBeenCalledWith({ url: `${options}?register=1` })
    expect(chrome.tabs.update).not.toHaveBeenCalled()
  })

  it('reuses and focuses an open options tab, whatever its query', async () => {
    const chrome = api([{ documentUrl: `${options}?x=1#top`, tabId: 7, windowId: 3 }])
    await openOptionsForRegistration(chrome)
    expect(chrome.tabs.update).toHaveBeenCalledWith(7, {
      url: `${options}?register=1`,
      active: true,
    })
    expect(chrome.windows.update).toHaveBeenCalledWith(3, { focused: true })
    expect(chrome.tabs.create).not.toHaveBeenCalled()
  })
})
