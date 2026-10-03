import { describe, expect, it, vi } from 'vitest'
import {
  buildStartUrl,
  challengeFor,
  exchangeCode,
  isExpired,
  normalizeServerUrl,
  parseRedirect,
  randomString,
} from './auth.js'

describe('PKCE', () => {
  it('derives the RFC 7636 appendix B challenge', async () => {
    expect(await challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    )
  })

  it('generates verifiers of 43 to 128 unreserved characters', () => {
    const verifier = randomString()
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/)
    expect(randomString()).not.toBe(verifier)
  })
})

describe('buildStartUrl', () => {
  it('builds the /auth/start URL', () => {
    const url = new URL(
      buildStartUrl('https://example.test/', {
        redirectUri: 'https://abc.chromiumapp.org/',
        challenge: 'c',
        state: 's',
      }),
    )
    expect(url.origin + url.pathname).toBe('https://example.test/auth/start')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client: 'extension',
      redirect_uri: 'https://abc.chromiumapp.org/',
      code_challenge: 'c',
      code_challenge_method: 'S256',
      state: 's',
    })
  })
})

describe('parseRedirect', () => {
  it('returns the code when state matches', () => {
    expect(parseRedirect('https://abc.chromiumapp.org/?code=xyz&state=s', 's')).toBe('xyz')
  })

  it('rejects a mismatched or missing state', () => {
    expect(() => parseRedirect('https://abc.chromiumapp.org/?code=xyz&state=t', 's')).toThrow(
      /state/,
    )
    expect(() => parseRedirect('https://abc.chromiumapp.org/?code=xyz', 's')).toThrow(/state/)
  })

  it('surfaces server errors and missing codes', () => {
    expect(() =>
      parseRedirect('https://abc.chromiumapp.org/?error=email_not_allowed&state=s', 's'),
    ).toThrow(/email_not_allowed/)
    expect(() => parseRedirect('https://abc.chromiumapp.org/?state=s', 's')).toThrow(/no code/)
  })
})

describe('exchangeCode', () => {
  it('posts the code and verifier and returns the token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'ps_t', expires_at: '2030-01-01T00:00:00Z' }),
    })
    expect(await exchangeCode('https://example.test/', 'code', 'ver', fetchImpl)).toEqual({
      accessToken: 'ps_t',
      expiresAt: '2030-01-01T00:00:00Z',
    })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://example.test/auth/token')
    expect(JSON.parse(init.body)).toEqual({ code: 'code', code_verifier: 'ver' })
  })

  it('throws on a rejected exchange', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400 })
    await expect(exchangeCode('https://example.test', 'c', 'v', fetchImpl)).rejects.toThrow(/400/)
  })
})

describe('session helpers', () => {
  it('treats missing and past-expiry sessions as expired', () => {
    const now = Date.parse('2030-01-01T00:00:00Z')
    expect(isExpired(undefined, now)).toBe(true)
    expect(isExpired({ accessToken: 't', expiresAt: '2029-12-31T00:00:00Z' }, now)).toBe(true)
    expect(isExpired({ accessToken: 't', expiresAt: '2030-06-01T00:00:00Z' }, now)).toBe(false)
  })

  it('strips trailing slashes from the server URL', () => {
    expect(normalizeServerUrl(' https://example.test// ')).toBe('https://example.test')
  })
})
