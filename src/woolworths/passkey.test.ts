import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REQUIRED_COOKIES } from './session.ts'

const launch = vi.hoisted(() => vi.fn())
vi.mock('playwright', () => ({ chromium: { launch } }))

const { loadCredentials, passkeyLogin } = await import('./passkey.ts')

interface FakeOptions {
  title?: string
  url?: string
  loginRedirects?: boolean
  cookieNames?: readonly string[]
}

function fakeBrowser({
  title = 'Woolworths',
  url: redirectsTo = 'https://auth.woolworths.com.au/u/login',
  loginRedirects = true,
  cookieNames = REQUIRED_COOKIES,
}: FakeOptions = {}) {
  const send = vi
    .fn()
    .mockImplementation(async (method: string) =>
      method === 'WebAuthn.addVirtualAuthenticator' ? { authenticatorId: 'auth-1' } : {},
    )
  let current = 'https://www.woolworths.com.au/shop/securelogin'
  const login = {
    dispatchEvent: vi.fn().mockImplementation(async () => {
      current = redirectsTo
    }),
  }
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    title: vi.fn().mockResolvedValue(title),
    url: vi.fn().mockImplementation(() => current),
    getByText: vi.fn().mockReturnValue({ last: () => login }),
    waitForURL: vi.fn().mockImplementation(async (target: unknown) => {
      if (typeof target !== 'function' && !loginRedirects) {
        throw new Error('timeout')
      }
    }),
  }
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    newCDPSession: vi.fn().mockResolvedValue({ send }),
    cookies: vi.fn().mockResolvedValue(cookieNames.map((name) => ({ name, value: `${name}-v` }))),
  }
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  }
  launch.mockResolvedValue(browser)
  return { browser, page, login, send }
}

describe('passkey login', () => {
  let dir: string
  let path: string

  beforeEach(async () => {
    launch.mockReset()
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-passkey-'))
    path = join(dir, 'credentials.json')
    await writeFile(path, JSON.stringify([{ credentialId: 'abc' }]))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true })
  })

  it('loads stored credentials', async () => {
    await expect(loadCredentials(path)).resolves.toEqual([{ credentialId: 'abc' }])
  })

  it.each([
    ['missing', () => join(dir, 'nope.json'), 'register-passkey'],
    ['empty', async () => (await writeFile(path, '[]'), path), 'non-empty'],
  ])('rejects %s credentials', async (_, resolve, message) => {
    await expect(loadCredentials(await resolve())).rejects.toThrow(message)
  })

  it('logs in with the preloaded passkey and returns the required cookies', async () => {
    const { browser, login, send } = fakeBrowser()

    const session = await passkeyLogin(path)

    expect(launch).toHaveBeenCalledWith(
      expect.objectContaining({ headless: true, channel: 'chrome' }),
    )
    expect(send).toHaveBeenCalledWith('WebAuthn.addCredential', {
      authenticatorId: 'auth-1',
      credential: { credentialId: 'abc' },
    })
    expect(login.dispatchEvent).toHaveBeenCalledWith('click', undefined, { timeout: 5000 })
    expect(session.cookies.map((cookie) => cookie.name).sort()).toEqual(
      [...REQUIRED_COOKIES].sort(),
    )
    expect(browser.close).toHaveBeenCalled()
  })

  it('reports an Akamai block', async () => {
    const { browser } = fakeBrowser({ title: 'Access Denied' })
    await expect(passkeyLogin(path)).rejects.toThrow('Akamai blocked')
    expect(browser.close).toHaveBeenCalled()
  })

  it('reports a rejected passkey when stuck on the auth page', async () => {
    fakeBrowser({ loginRedirects: false })
    await expect(passkeyLogin(path)).rejects.toThrow('passkey login was rejected')
  })

  it('reports an incomplete login elsewhere', async () => {
    fakeBrowser({ loginRedirects: false, url: 'https://www.woolworths.com.au/shop/securelogin' })
    await expect(passkeyLogin(path, 50)).rejects.toThrow('/shop/securelogin')
  })

  it('names the cookies still missing after login', async () => {
    fakeBrowser({ cookieNames: REQUIRED_COOKIES.filter((name) => name !== 'w-aref') })
    await expect(passkeyLogin(path, 10)).rejects.toThrow(
      'Missing cookies after passkey login: w-aref',
    )
  })
})
