import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { selectCredential } from './passkey.ts'

const script = readFileSync(
  new URL(
    '../ios/Packages/PersonalShopperKit/Sources/PersonalShopperKit/Resources/passkey-authenticator.js',
    import.meta.url,
  ),
  'utf8',
)

const ORIGIN = 'https://auth.woolworths.com.au'
const RP_ID = 'auth.woolworths.com.au'

interface Posted {
  rpId: string
  credentialId: string
  userHandle: string
  privateKey: string
}
interface Created {
  id: string
  rawId: ArrayBuffer
  type: string
  authenticatorAttachment: string
  getClientExtensionResults: () => object
  response: {
    clientDataJSON: ArrayBuffer
    attestationObject: ArrayBuffer
    getTransports: () => string[]
    getAuthenticatorData: () => ArrayBuffer
    getPublicKey: () => ArrayBuffer
    getPublicKeyAlgorithm: () => number
  }
}
interface Asserted {
  id: string
  response: {
    clientDataJSON: ArrayBuffer
    authenticatorData: ArrayBuffer
    signature: ArrayBuffer
    userHandle: ArrayBuffer
  }
}
interface Container {
  create: (options: object) => Promise<Created>
  get: (options: object) => Promise<Asserted>
}

/** Runs the script against a fake page and returns what it installed. */
function load({ native = true, container = true } = {}) {
  const posted: Posted[] = []
  const original = {
    create: vi.fn(async () => 'native-create'),
    get: vi.fn(async () => 'native-get'),
  }
  const navigator: { credentials?: Container } = container
    ? { credentials: { ...original } as unknown as Container }
    : {}
  const window: Record<string, unknown> = {
    webkit: { messageHandlers: { passkey: { postMessage: (m: Posted) => posted.push(m) } } },
  }
  window.top = window
  if (native) {
    window.PublicKeyCredential = Object.assign(function () {}, {
      isUserVerifyingPlatformAuthenticatorAvailable: async () => false,
      isConditionalMediationAvailable: async () => true,
    })
  }
  new Function('navigator', 'location', 'window', script)(
    navigator,
    new URL(`${ORIGIN}/u/login`),
    window,
  )
  const PublicKeyCredential = window.PublicKeyCredential as PublicKeyCredentialStatics &
    (new () => object)
  return { credentials: navigator.credentials!, original, posted, PublicKeyCredential }
}

interface PublicKeyCredentialStatics {
  isUserVerifyingPlatformAuthenticatorAvailable: () => Promise<boolean>
  isConditionalMediationAvailable: () => Promise<boolean>
  isPasskeyPlatformAuthenticatorAvailable: () => Promise<boolean>
  getClientCapabilities: () => Promise<Record<string, boolean>>
  parseCreationOptionsFromJSON: (json: object) => {
    challenge: Uint8Array
    user: { id: Uint8Array }
  }
  parseRequestOptionsFromJSON: (json: object) => {
    challenge: Uint8Array
    allowCredentials: { id: Uint8Array }[]
  }
}

const challenge = Uint8Array.from([1, 2, 3, 4])
const creationOptions = (overrides = {}) => ({
  publicKey: {
    challenge,
    rp: { id: RP_ID, name: 'Woolworths' },
    user: { id: Uint8Array.from([9, 8, 7]), name: 'a', displayName: 'a' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    ...overrides,
  },
})

/** A minimal CBOR reader for the maps, byte/text strings and ints the script emits. */
function cbor(data: Uint8Array): { value: unknown; end: number } {
  const major = data[0]! >> 5
  let length = data[0]! & 0x1f
  let at = 1
  if (length === 24) length = data[at++]!
  else if (length === 25) length = (data[at++]! << 8) | data[at++]!
  switch (major) {
    case 0:
      return { value: length, end: at }
    case 1:
      return { value: -1 - length, end: at }
    case 2:
      return { value: data.slice(at, at + length), end: at + length }
    case 3:
      return { value: Buffer.from(data.slice(at, at + length)).toString(), end: at + length }
    case 5: {
      const map = new Map<unknown, unknown>()
      for (let i = 0; i < length; i++) {
        const key = cbor(data.slice(at))
        at += key.end
        const value = cbor(data.slice(at))
        at += value.end
        map.set(key.value, value.value)
      }
      return { value: map, end: at }
    }
  }
  throw new Error(`unexpected CBOR major type ${major}`)
}

const bytes = (buffer: ArrayBuffer) => new Uint8Array(buffer)

function parseAuthData(authData: Uint8Array) {
  const idLength = (authData[53]! << 8) | authData[54]!
  const credentialId = authData.slice(55, 55 + idLength)
  const key = cbor(authData.slice(55 + idLength)).value as Map<number, unknown>
  return { credentialId, key, flags: authData[32]!, signCount: authData.slice(33, 37) }
}

const publicKeyFrom = (key: Map<number, unknown>) =>
  createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: Buffer.from(key.get(-2) as Uint8Array).toString('base64url'),
      y: Buffer.from(key.get(-3) as Uint8Array).toString('base64url'),
    },
    format: 'jwk',
  })

describe('passkey authenticator script', () => {
  it('creates a none-attested ES256 credential', async () => {
    const { credentials } = load()
    const created = await credentials.create(creationOptions())

    expect(created.type).toBe('public-key')
    expect(created.authenticatorAttachment).toBe('platform')
    expect(created.getClientExtensionResults()).toEqual({})
    expect(created.id).toBe(Buffer.from(created.rawId).toString('base64url'))
    expect(created.response.getTransports()).toContain('internal')
    expect(created.response.getPublicKeyAlgorithm()).toBe(-7)

    const clientData = JSON.parse(Buffer.from(created.response.clientDataJSON).toString())
    expect(clientData).toEqual({
      type: 'webauthn.create',
      challenge: Buffer.from(challenge).toString('base64url'),
      origin: ORIGIN,
      crossOrigin: false,
    })

    const attestation = cbor(bytes(created.response.attestationObject)).value as Map<
      string,
      unknown
    >
    expect(attestation.get('fmt')).toBe('none')
    expect(attestation.get('attStmt')).toEqual(new Map())
    const authData = attestation.get('authData') as Uint8Array
    expect(Buffer.from(authData.slice(0, 32))).toEqual(createHash('sha256').update(RP_ID).digest())
    const parsed = parseAuthData(authData)
    expect(parsed.flags).toBe(0x45)
    expect(authData.slice(37, 53)).toEqual(new Uint8Array(16))
    expect(Buffer.from(parsed.credentialId).toString('base64url')).toBe(created.id)
    expect(authData).toEqual(bytes(created.response.getAuthenticatorData()))
    expect(parsed.key.get(1)).toBe(2)
    expect(parsed.key.get(3)).toBe(-7)
    expect(parsed.key.get(-1)).toBe(1)

    const spki = createPublicKey({
      key: Buffer.from(created.response.getPublicKey()),
      format: 'der',
      type: 'spki',
    })
    expect(publicKeyFrom(parsed.key).export({ format: 'der', type: 'spki' })).toEqual(
      spki.export({ format: 'der', type: 'spki' }),
    )
  })

  it('posts a credential the server accepts, whose key signs for the COSE public key', async () => {
    const { credentials, posted } = load()
    const created = await credentials.create(creationOptions())

    expect(posted).toHaveLength(1)
    const [credential] = posted as [Posted]
    expect(credential.rpId).toBe(RP_ID)
    expect(Buffer.from(credential.credentialId, 'base64').toString('base64url')).toBe(created.id)
    expect(Buffer.from(credential.userHandle, 'base64')).toEqual(Buffer.from([9, 8, 7]))
    expect(selectCredential(credential)).toEqual({ ok: true, credential })

    const authData = (
      cbor(bytes(created.response.attestationObject)).value as Map<string, Uint8Array>
    ).get('authData')!
    const data = Buffer.from('signed by the server')
    const key = createPrivateKey({
      key: Buffer.from(credential.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    })
    expect(key.asymmetricKeyType).toBe('ec')
    const signature = sign('sha256', data, { key, dsaEncoding: 'der' })
    expect(verify('sha256', data, publicKeyFrom(parseAuthData(authData).key), signature)).toBe(true)
  })

  it('answers get with an assertion signed by the created key', async () => {
    const { credentials } = load()
    const created = await credentials.create(creationOptions())
    const publicKey = createPublicKey({
      key: Buffer.from(created.response.getPublicKey()),
      format: 'der',
      type: 'spki',
    })

    for (const allowCredentials of [[], [{ type: 'public-key', id: created.rawId }]]) {
      const asserted = await credentials.get({
        publicKey: { challenge, rpId: RP_ID, allowCredentials },
      })
      expect(asserted.id).toBe(created.id)
      const clientDataJSON = Buffer.from(asserted.response.clientDataJSON)
      expect(JSON.parse(clientDataJSON.toString())).toMatchObject({
        type: 'webauthn.get',
        origin: ORIGIN,
      })
      const authData = Buffer.from(asserted.response.authenticatorData)
      expect(authData.subarray(0, 32)).toEqual(createHash('sha256').update(RP_ID).digest())
      expect(authData[32]).toBe(0x05)
      expect(Buffer.from(asserted.response.userHandle)).toEqual(Buffer.from([9, 8, 7]))
      const signed = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()])
      expect(verify('sha256', signed, publicKey, Buffer.from(asserted.response.signature))).toBe(
        true,
      )
    }
  })

  it('rejects get when no matching passkey exists', async () => {
    const { credentials } = load()
    await expect(credentials.get({ publicKey: { challenge, rpId: RP_ID } })).rejects.toMatchObject({
      name: 'NotAllowedError',
    })
    await credentials.create(creationOptions())
    await expect(
      credentials.get({ publicKey: { challenge, rpId: 'example.com' } }),
    ).rejects.toMatchObject({ name: 'NotAllowedError' })
    await expect(
      credentials.get({
        publicKey: {
          challenge,
          rpId: RP_ID,
          allowCredentials: [{ type: 'public-key', id: Buffer.from('x') }],
        },
      }),
    ).rejects.toMatchObject({ name: 'NotAllowedError' })
  })

  it('rejects creation without ES256', async () => {
    const { credentials, posted } = load()
    await expect(
      credentials.create(
        creationOptions({ pubKeyCredParams: [{ type: 'public-key', alg: -257 }] }),
      ),
    ).rejects.toMatchObject({ name: 'NotSupportedError' })
    expect(posted).toEqual([])
  })

  it('defaults the RP ID to the page host', async () => {
    const { credentials, posted } = load()
    await credentials.create(creationOptions({ rp: { name: 'Woolworths' } }))
    expect(posted[0]?.rpId).toBe(RP_ID)
  })

  it('leaves non-public-key requests to the browser', async () => {
    const { credentials, original } = load()
    await expect(credentials.create({ password: true })).resolves.toBe('native-create')
    await expect(credentials.get({ password: true })).resolves.toBe('native-get')
    expect(original.create).toHaveBeenCalledOnce()
    expect(original.get).toHaveBeenCalledOnce()
  })

  it('reports a platform authenticator without conditional mediation', async () => {
    const { PublicKeyCredential } = load()
    await expect(PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()).resolves.toBe(
      true,
    )
    await expect(PublicKeyCredential.isConditionalMediationAvailable()).resolves.toBe(false)
  })

  it.each([
    ['a browser without PublicKeyCredential', { native: false }],
    ['a browser without navigator.credentials', { native: false, container: false }],
  ])('defines the WebAuthn surface pages detect in %s', async (_name, env) => {
    const { credentials, PublicKeyCredential } = load(env)
    expect(typeof PublicKeyCredential).toBe('function')
    await expect(PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()).resolves.toBe(
      true,
    )
    await expect(PublicKeyCredential.isConditionalMediationAvailable()).resolves.toBe(false)
    await expect(PublicKeyCredential.isPasskeyPlatformAuthenticatorAvailable()).resolves.toBe(true)
    await expect(PublicKeyCredential.getClientCapabilities()).resolves.toMatchObject({
      passkeyPlatformAuthenticator: true,
      userVerifyingPlatformAuthenticator: true,
      conditionalCreate: false,
      conditionalGet: false,
    })
    expect(await credentials.create(creationOptions())).toBeInstanceOf(PublicKeyCredential)
  })

  it('serialises credentials with toJSON', async () => {
    const { credentials } = load({ native: false })
    const created = (await credentials.create(creationOptions())) as unknown as {
      toJSON: () => Record<string, Record<string, unknown>>
    } & Created
    const json = created.toJSON()
    expect(json).toMatchObject({
      id: created.id,
      rawId: created.id,
      type: 'public-key',
      authenticatorAttachment: 'platform',
      clientExtensionResults: {},
    })
    expect(Buffer.from(json.response!.attestationObject as string, 'base64url')).toEqual(
      Buffer.from(created.response.attestationObject),
    )
    expect(json.response).toMatchObject({
      publicKeyAlgorithm: -7,
      transports: ['internal', 'hybrid'],
    })

    const asserted = (await credentials.get({
      publicKey: { challenge, rpId: RP_ID },
    })) as unknown as {
      toJSON: () => Record<string, Record<string, string>>
    } & Asserted
    expect(asserted.toJSON().response!.signature).toBe(
      Buffer.from(asserted.response.signature).toString('base64url'),
    )
  })

  it('parses options from JSON', () => {
    const { PublicKeyCredential } = load({ native: false })
    const b64 = Buffer.from([1, 2, 3]).toString('base64url')
    const creation = PublicKeyCredential.parseCreationOptionsFromJSON({
      challenge: b64,
      user: { id: b64 },
    })
    expect(Buffer.from(creation.challenge)).toEqual(Buffer.from([1, 2, 3]))
    expect(Buffer.from(creation.user.id)).toEqual(Buffer.from([1, 2, 3]))
    const request = PublicKeyCredential.parseRequestOptionsFromJSON({
      challenge: b64,
      allowCredentials: [{ type: 'public-key', id: b64 }],
    })
    expect(Buffer.from(request.allowCredentials[0]!.id)).toEqual(Buffer.from([1, 2, 3]))
  })
})
