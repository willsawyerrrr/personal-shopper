import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from '../testing/db.ts'
import {
  CredentialStore,
  credentialsStored,
  parseCredentials,
  parseEncryptionKey,
} from './credentials.ts'

const credentials = [{ credentialId: 'abc', privateKey: 'super-secret-key' }]

describe('CredentialStore', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  let key: Buffer
  let store: CredentialStore

  beforeEach(async () => {
    db = await createTestDb()
    key = randomBytes(32)
    store = new CredentialStore(db.sql, key)
  })

  afterEach(async () => {
    await db.close()
  })

  it('round-trips a user credential', async () => {
    await store.put('me@example.com', credentials)
    await expect(store.get('ME@example.com')).resolves.toEqual(credentials)
  })

  it('returns undefined for a user without one', async () => {
    await expect(store.get('nobody@example.com')).resolves.toBeUndefined()
  })

  it('stores only ciphertext in the database', async () => {
    await store.put('me@example.com', credentials)
    const [row] = await db.sql<{ encrypted: Buffer }[]>`select encrypted from passkey_credentials`
    const stored = (row as { encrypted: Buffer }).encrypted
    expect(stored.includes('super-secret-key')).toBe(false)
    expect(stored.includes('credentialId')).toBe(false)
    expect(stored.length).toBeGreaterThan(28)
  })

  it('encrypts with a fresh IV on every put', async () => {
    await store.put('me@example.com', credentials)
    const [first] = await db.sql<{ encrypted: Buffer }[]>`select encrypted from passkey_credentials`
    await store.put('me@example.com', credentials)
    const [second] = await db.sql<
      { encrypted: Buffer }[]
    >`select encrypted from passkey_credentials`
    expect(first?.encrypted.equals((second as { encrypted: Buffer }).encrypted)).toBe(false)
  })

  it('keeps each user their own credential', async () => {
    await store.put('me@example.com', credentials)
    await store.put('you@example.com', [{ credentialId: 'other' }])
    await expect(store.get('you@example.com')).resolves.toEqual([{ credentialId: 'other' }])
    await expect(store.get('me@example.com')).resolves.toEqual(credentials)
  })

  it('fails to read with a different key, without echoing the content', async () => {
    await store.put('me@example.com', credentials)
    const error = await new CredentialStore(db.sql, randomBytes(32))
      .get('me@example.com')
      .catch((caught: Error) => caught)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('CREDENTIALS_ENCRYPTION_KEY')
    expect((error as Error).message).not.toContain('super-secret-key')
  })

  it('deletes a credential and tolerates deleting none', async () => {
    await store.put('me@example.com', credentials)
    await store.delete('me@example.com')
    await store.delete('me@example.com')
    await expect(store.get('me@example.com')).resolves.toBeUndefined()
  })

  it('refuses to store an empty credential list', async () => {
    await expect(store.put('me@example.com', [])).rejects.toThrow('non-empty')
  })

  it('reports whether any credential is stored', async () => {
    await expect(credentialsStored(db.sql)).resolves.toBe(false)
    await store.put('me@example.com', credentials)
    await expect(credentialsStored(db.sql)).resolves.toBe(true)
  })
})

describe('parseEncryptionKey', () => {
  it('accepts 32 bytes as base64 or hex', () => {
    const key = randomBytes(32)
    expect(parseEncryptionKey(key.toString('base64'))).toEqual(key)
    expect(parseEncryptionKey(key.toString('hex'))).toEqual(key)
  })

  it('rejects any other length', () => {
    expect(() => parseEncryptionKey(randomBytes(16).toString('base64'))).toThrow('32 bytes')
  })
})

describe('parseCredentials', () => {
  it.each([[[]], [{}], ['x']])('rejects %j', (value) => {
    expect(() => parseCredentials(value)).toThrow('non-empty')
  })
})
