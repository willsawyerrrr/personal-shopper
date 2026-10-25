// A software WebAuthn authenticator (ES256, `none` attestation) that answers
// `navigator.credentials.create` and `get` for public-key requests, so the
// page never reaches the system passkey UI. Credentials live in memory for the
// life of the frame; each one created is also posted to the `passkey` native
// message handler, which uploads it.
;(() => {
  const subtle = crypto.subtle
  const encoder = new TextEncoder()
  const credentials = new Map()
  let signCount = 0

  const bytes = (source) =>
    source instanceof ArrayBuffer
      ? new Uint8Array(source)
      : new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
  const concat = (...parts) => {
    const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
    let offset = 0
    for (const part of parts) {
      out.set(part, offset)
      offset += part.length
    }
    return out
  }
  const base64 = (data) => btoa(String.fromCharCode(...bytes(data)))
  const base64url = (data) =>
    base64(data).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
  const unbase64url = (text) =>
    Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
  const sha256 = async (data) => new Uint8Array(await subtle.digest('SHA-256', data))
  const uint32 = (n) => new Uint8Array([n >>> 24, n >>> 16, n >>> 8, n].map((b) => b & 0xff))

  // CBOR: unsigned/negative ints below 24, byte strings and text strings.
  const head = (major, length) =>
    length < 24
      ? Uint8Array.of((major << 5) | length)
      : length < 256
        ? Uint8Array.of((major << 5) | 24, length)
        : Uint8Array.of((major << 5) | 25, length >> 8, length & 0xff)
  const cborBytes = (data) => concat(head(2, data.length), data)
  const cborText = (text) => concat(head(3, text.length), encoder.encode(text))
  const cborInt = (n) => (n >= 0 ? head(0, n) : head(1, -1 - n))

  const cose = (jwk) =>
    concat(
      head(5, 5),
      cborInt(1), cborInt(2),
      cborInt(3), cborInt(-7),
      cborInt(-1), cborInt(1),
      cborInt(-2), cborBytes(unbase64url(jwk.x)),
      cborInt(-3), cborBytes(unbase64url(jwk.y)),
    ) // prettier-ignore

  // WebCrypto signs ECDSA as `r || s`; WebAuthn expects an ASN.1 DER sequence.
  const der = (raw) => {
    const integer = (part) => {
      let i = 0
      while (i < part.length - 1 && part[i] === 0) i++
      const trimmed = part.slice(i)
      const padded = trimmed[0] & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed
      return concat(Uint8Array.of(0x02, padded.length), padded)
    }
    const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)))
    return concat(Uint8Array.of(0x30, body.length), body)
  }

  const buffer = (data) => bytes(data).slice().buffer
  const fail = (name, message) => new DOMException(message, name)
  const publicKeyOf = (options) => {
    const publicKey = options?.publicKey
    return publicKey && typeof publicKey === 'object' ? publicKey : undefined
  }

  const clientData = (type, challenge) =>
    encoder.encode(
      JSON.stringify({
        type,
        challenge: base64url(challenge),
        origin: location.origin,
        crossOrigin: window.top !== window,
      }),
    )

  const credentialObject = (id, response) => ({
    id: base64url(id),
    rawId: buffer(id),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    response,
    getClientExtensionResults: () => ({}),
  })

  const create = async (publicKey) => {
    const params = publicKey.pubKeyCredParams ?? []
    if (params.length > 0 && !params.some((param) => param.alg === -7)) {
      throw fail('NotSupportedError', 'Only ES256 is supported')
    }
    const rpId = publicKey.rp?.id ?? location.hostname
    const userHandle = bytes(publicKey.user.id).slice()
    const id = crypto.getRandomValues(new Uint8Array(32))
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign'])
    const jwk = await subtle.exportKey('jwk', pair.publicKey)
    const spki = new Uint8Array(await subtle.exportKey('spki', pair.publicKey))
    const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey))

    const authenticatorData = concat(
      await sha256(encoder.encode(rpId)),
      Uint8Array.of(0x45), // user present, user verified, attested credential data
      uint32(0),
      new Uint8Array(16), // AAGUID
      Uint8Array.of(id.length >> 8, id.length & 0xff),
      id,
      cose(jwk),
    )
    const attestationObject = concat(
      head(5, 3),
      cborText('fmt'), cborText('none'),
      cborText('attStmt'), head(5, 0),
      cborText('authData'), cborBytes(authenticatorData),
    ) // prettier-ignore
    credentials.set(base64url(id), { rpId, userHandle, privateKey: pair.privateKey })

    window.webkit?.messageHandlers?.passkey?.postMessage({
      rpId,
      credentialId: base64(id),
      userHandle: base64(userHandle),
      privateKey: base64(pkcs8),
    })

    return credentialObject(id, {
      clientDataJSON: buffer(clientData('webauthn.create', publicKey.challenge)),
      attestationObject: buffer(attestationObject),
      getTransports: () => ['internal', 'hybrid'],
      getAuthenticatorData: () => buffer(authenticatorData),
      getPublicKey: () => buffer(spki),
      getPublicKeyAlgorithm: () => -7,
    })
  }

  const get = async (publicKey) => {
    const rpId = publicKey.rpId ?? location.hostname
    const allowed = (publicKey.allowCredentials ?? []).map((entry) => base64url(entry.id))
    const entry = [...credentials].find(
      ([id, credential]) =>
        credential.rpId === rpId && (allowed.length === 0 || allowed.includes(id)),
    )
    if (!entry) throw fail('NotAllowedError', 'No matching passkey')
    const [encodedId, credential] = entry

    const data = clientData('webauthn.get', publicKey.challenge)
    const authenticatorData = concat(
      await sha256(encoder.encode(rpId)),
      Uint8Array.of(0x05), // user present, user verified
      uint32(++signCount),
    )
    const signature = der(
      new Uint8Array(
        await subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          credential.privateKey,
          concat(authenticatorData, await sha256(data)),
        ),
      ),
    )
    return credentialObject(unbase64url(encodedId), {
      clientDataJSON: buffer(data),
      authenticatorData: buffer(authenticatorData),
      signature: buffer(signature),
      userHandle: buffer(credential.userHandle),
    })
  }

  const container = navigator.credentials
  const originalCreate = container.create?.bind(container)
  const originalGet = container.get?.bind(container)
  const intercept = (original, handler) =>
    function (options) {
      const publicKey = publicKeyOf(options)
      return publicKey ? handler(publicKey) : original?.(options)
    }
  container.create = intercept(originalCreate, create)
  container.get = intercept(originalGet, get)

  if (typeof PublicKeyCredential === 'function') {
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => true
    PublicKeyCredential.isConditionalMediationAvailable = async () => false
  }
})()
