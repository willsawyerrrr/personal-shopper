import { createHash, generateKeyPairSync, verify } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadCredentials, passkeyLogin, PASSKEY_REJECTED_MESSAGE } from './passkey.ts'
import { REQUIRED_COOKIES } from './session.ts'

const AUTH_PAGE = 'https://auth.woolworths.com.au/u/login/identifier?state=st8'
const CHALLENGE = 'Y2hhbGxlbmdl'
const identifierHtml = `<html><script>JSON.parse(decodeURIComponent(escape(atob("${Buffer.from(
  JSON.stringify({ screen: { data: { passkey: { public_key: { challenge: CHALLENGE } } } } }),
).toString('base64')}"))))</script></html>`

function html(body: string, init: { status?: number; headers?: [string, string][] } = {}) {
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' })
  for (const [name, value] of init.headers ?? []) {
    headers.append(name, value)
  }
  return new Response(body, { status: init.status ?? 200, headers })
}

const redirect = (location: string, cookies: string[] = []) =>
  html('', {
    status: 302,
    headers: [['location', location], ...cookies.map((c): [string, string] => ['set-cookie', c])],
  })

const allCookies = [...REQUIRED_COOKIES].map((name) => `${name}=${name}-v; Path=/; HttpOnly`)

function credentialFor(type: 'ed25519' | 'ec') {
  const { privateKey, publicKey } =
    type === 'ed25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    publicKey,
    credential: {
      credentialId: Buffer.from('cred-id').toString('base64'),
      userHandle: Buffer.from('user').toString('base64'),
      privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    },
  }
}

describe('passkey login', () => {
  let dir: string
  let path: string
  const fetchMock = vi.fn<typeof fetch>()

  async function writeCredential(credential: unknown) {
    await writeFile(path, JSON.stringify([credential]))
  }

  beforeEach(async () => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-passkey-'))
    path = join(dir, 'credentials.json')
    await writeCredential(credentialFor('ed25519').credential)
  })

  afterEach(async () => {
    vi.unstubAllGlobals()
    await rm(dir, { recursive: true })
  })

  it('loads stored credentials', async () => {
    await writeFile(path, JSON.stringify([{ credentialId: 'abc' }]))
    await expect(loadCredentials(path)).resolves.toEqual([{ credentialId: 'abc' }])
  })

  it.each([
    ['missing', () => join(dir, 'nope.json'), 'register-passkey'],
    ['empty', async () => (await writeFile(path, '[]'), path), 'non-empty'],
  ])('rejects %s credentials', async (_, resolve, message) => {
    await expect(loadCredentials(await resolve())).rejects.toThrow(message)
  })

  function mockLogin(postResponse: () => Response, finalResponse = () => html('<html></html>')) {
    fetchMock
      .mockResolvedValueOnce(
        redirect('https://auth.woolworths.com.au/authorize?x=1', ['ak_bmsc=akamai; Path=/']),
      )
      .mockResolvedValueOnce(redirect('/u/login/identifier?state=st8'))
      .mockResolvedValueOnce(html(identifierHtml))
      .mockImplementationOnce(async () => postResponse())
      .mockImplementationOnce(async () => finalResponse())
  }

  const successfulPost = () =>
    redirect('https://www.woolworths.com.au/auth/callback?code=1', allCookies)

  it.each(['ed25519', 'ec'] as const)(
    'signs the challenge with a %s key and returns the session cookies',
    async (type) => {
      const { credential, publicKey } = credentialFor(type)
      await writeCredential(credential)
      mockLogin(successfulPost)

      const session = await passkeyLogin(path)

      expect(session.cookies.map((c) => c.name).sort()).toEqual(
        [...REQUIRED_COOKIES, 'ak_bmsc'].sort(),
      )
      const [url, init] = fetchMock.mock.calls[3]!
      expect(url).toBe(AUTH_PAGE)
      expect(init).toMatchObject({ method: 'POST' })
      const form = init!.body as URLSearchParams
      expect(form.get('state')).toBe('st8')
      expect(form.get('acul-sdk')).toContain('auth0-acul-react')
      const passkey = JSON.parse(form.get('passkey')!)
      expect(passkey.id).toBe(Buffer.from('cred-id').toString('base64url'))
      const { authenticatorData, clientDataJSON, signature } = passkey.response
      const clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString())
      expect(clientData).toEqual({
        type: 'webauthn.get',
        challenge: CHALLENGE,
        origin: 'https://auth.woolworths.com.au',
        crossOrigin: false,
      })
      const authData = Buffer.from(authenticatorData, 'base64url')
      expect(authData.subarray(0, 32)).toEqual(
        createHash('sha256').update('auth.woolworths.com.au').digest(),
      )
      expect(authData[32]).toBe(0x05)
      const signed = Buffer.concat([
        authData,
        createHash('sha256').update(Buffer.from(clientDataJSON, 'base64url')).digest(),
      ])
      const sig = Buffer.from(signature, 'base64url')
      expect(
        type === 'ed25519'
          ? verify(null, signed, publicKey, sig)
          : verify('sha256', signed, { key: publicKey, dsaEncoding: 'der' }, sig),
      ).toBe(true)
    },
  )

  it('sends cookies set by earlier responses', async () => {
    mockLogin(successfulPost)
    await passkeyLogin(path)
    const headers = fetchMock.mock.calls[1]![1]!.headers as Record<string, string>
    expect(headers.Cookie).toBe('ak_bmsc=akamai')
  })

  it('does not require the Akamai cookies', async () => {
    mockLogin(successfulPost)
    const session = await passkeyLogin(path)
    expect(session.cookies.map((c) => c.name)).not.toContain('_abck')
  })

  it('drops cookies the server deletes', async () => {
    mockLogin(() => redirect('/auth/callback', [...allCookies, 'ak_bmsc=; Max-Age=0; Path=/']))
    const session = await passkeyLogin(path)
    expect(session.cookies.map((c) => c.name)).not.toContain('ak_bmsc')
  })

  it('reports a rejected passkey when the auth page is shown again', async () => {
    mockLogin(() => html(identifierHtml))
    await expect(passkeyLogin(path)).rejects.toThrow(PASSKEY_REJECTED_MESSAGE)
  })

  it('reports an Akamai block on the login page', async () => {
    fetchMock.mockResolvedValueOnce(html('<h1>Access Denied</h1>', { status: 403 }))
    await expect(passkeyLogin(path)).rejects.toThrow('Akamai blocked')
  })

  it('reports an Akamai block with a non-HTML response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{}', { headers: { 'content-type': 'application/json' } }),
    )
    await expect(passkeyLogin(path)).rejects.toThrow('non-HTML')
  })

  it('reports a login page without a passkey challenge', async () => {
    fetchMock.mockResolvedValueOnce(html('<html></html>'))
    await expect(passkeyLogin(path)).rejects.toThrow('no passkey challenge')
  })

  it('reports a login page without a state', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect('https://auth.woolworths.com.au/u/login/identifier'))
      .mockResolvedValueOnce(html(identifierHtml))
    await expect(passkeyLogin(path)).rejects.toThrow('state')
  })

  it('reports an Akamai block after submitting the passkey', async () => {
    mockLogin(() => html('Access Denied', { status: 403 }))
    await expect(passkeyLogin(path)).rejects.toThrow('Akamai blocked')
  })

  it('reports an unusable private key', async () => {
    await writeCredential({ credentialId: 'a', userHandle: 'b', privateKey: 'AAAA' })
    mockLogin(successfulPost)
    await expect(passkeyLogin(path)).rejects.toThrow('no usable private key')
  })

  it('reports an unsupported key type', async () => {
    const { privateKey } = generateKeyPairSync('x25519')
    await writeCredential({
      credentialId: 'a',
      userHandle: 'b',
      privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    })
    mockLogin(successfulPost)
    await expect(passkeyLogin(path)).rejects.toThrow('Unsupported passkey key type')
  })

  it('names the required cookies still missing after login', async () => {
    mockLogin(() =>
      redirect(
        '/auth/callback',
        allCookies.filter((cookie) => !cookie.startsWith('w-aref')),
      ),
    )
    await expect(passkeyLogin(path)).rejects.toThrow('Missing cookies after passkey login: w-aref')
  })

  it('gives up on a redirect loop', async () => {
    fetchMock.mockImplementation(async () => redirect('https://www.woolworths.com.au/loop'))
    await expect(passkeyLogin(path)).rejects.toThrow('too many times')
  })
})
