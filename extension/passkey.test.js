import { describe, expect, it, vi } from 'vitest'
import { fetchRegistered, removePasskey, uploadPasskey } from './passkey-api.js'
import { registerPasskey } from './passkey-flow.js'
import {
  AUTHENTICATOR_OPTIONS,
  CancelledError,
  REGISTRATION_TIMEOUT_MS,
  UnauthorizedError,
  describeStatus,
  isTimedOut,
  selectCredential,
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
    expect(calls.slice(-3)).toEqual([
      'WebAuthn.removeVirtualAuthenticator',
      'WebAuthn.disable',
      'detach',
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
    expect(calls.at(-1)).toBe('detach')
  })

  it('cleans up when the upload fails', async () => {
    const { deps, calls } = setup()
    deps.upload = vi.fn().mockRejectedValue(new Error('Server error (500)'))
    await expect(registerPasskey(deps)).rejects.toThrow('Server error (500)')
    expect(calls.slice(-3)).toEqual([
      'WebAuthn.removeVirtualAuthenticator',
      'WebAuthn.disable',
      'detach',
    ])
  })

  it('does not detach when attaching failed', async () => {
    const { deps, debuggerApi } = setup()
    debuggerApi.attach.mockRejectedValue(new Error('Another debugger is attached'))
    await expect(registerPasskey(deps)).rejects.toThrow('Another debugger')
    expect(debuggerApi.detach).not.toHaveBeenCalled()
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
