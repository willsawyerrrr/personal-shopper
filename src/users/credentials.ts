import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ensureHousehold, type Sql } from '../db.ts'
import { normalizeEmail } from './email.ts'

/** A credential as returned by CDP `WebAuthn.getCredentials`. */
export type PasskeyCredential = Record<string, unknown>

const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32

/** Parses a base64 or hex AES-256 key; throws unless it decodes to 32 bytes. */
export function parseEncryptionKey(value: string): Buffer {
  const trimmed = value.trim()
  const key = /^[0-9a-f]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64')
  if (key.length !== KEY_LENGTH) {
    throw new Error('CREDENTIALS_ENCRYPTION_KEY must be 32 bytes, base64 or hex encoded')
  }
  return key
}

/** Validates decoded credentials: a non-empty array. */
export function parseCredentials(value: unknown): PasskeyCredential[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Passkey credentials must be a non-empty JSON array')
  }
  return value as PasskeyCredential[]
}

/** Whether any user has a stored credential. */
export async function credentialsStored(sql: Sql): Promise<boolean> {
  const [row] = await sql<{ stored: boolean }[]>`
    select exists (select 1 from passkey_credentials) as stored`
  return row?.stored ?? false
}

/**
 * Per-household passkey credentials, shared by the household's members. They are encrypted with AES-256-GCM (IV, auth
 * tag, ciphertext) before they reach the database, so the key never does.
 * Nothing here logs credential content.
 */
export class CredentialStore {
  constructor(
    private readonly sql: Sql,
    private readonly key: Buffer,
  ) {}

  /** The user's credentials, or `undefined` when none are stored. Corrupt data or a wrong key throws. */
  async get(email: string): Promise<PasskeyCredential[] | undefined> {
    const [row] = await this.sql<{ encrypted: Buffer }[]>`
      select c.encrypted from passkey_credentials c
      join users u on u.household_id = c.household_id
      where u.email = ${normalizeEmail(email)}`
    if (!row) {
      return undefined
    }
    try {
      const { encrypted } = row
      const decipher = createDecipheriv('aes-256-gcm', this.key, encrypted.subarray(0, IV_LENGTH))
      decipher.setAuthTag(encrypted.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH))
      const plaintext = Buffer.concat([
        decipher.update(encrypted.subarray(IV_LENGTH + TAG_LENGTH)),
        decipher.final(),
      ])
      return parseCredentials(JSON.parse(plaintext.toString('utf8')))
    } catch (error) {
      throw new Error(
        'Cannot decrypt the stored passkey credentials; check CREDENTIALS_ENCRYPTION_KEY',
        {
          cause: error,
        },
      )
    }
  }

  /** Whether the user has stored credentials, without decrypting them. */
  async has(email: string): Promise<boolean> {
    const [row] = await this.sql<{ stored: boolean }[]>`
      select exists (
        select 1 from passkey_credentials c
        join users u on u.household_id = c.household_id
        where u.email = ${normalizeEmail(email)}
      ) as stored`
    return row?.stored ?? false
  }

  /** Replaces the user's credentials. */
  async put(email: string, credentials: PasskeyCredential[]): Promise<void> {
    parseCredentials(credentials)
    const iv = randomBytes(IV_LENGTH)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(credentials), 'utf8'),
      cipher.final(),
    ])
    const encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
    const householdId = await ensureHousehold(this.sql, email)
    await this.sql`
      insert into passkey_credentials (household_id, encrypted)
      values (${householdId}, ${encrypted})
      on conflict (household_id) do update set encrypted = excluded.encrypted, updated_at = now()`
  }

  /** Removes the user's credentials; a no-op when there are none. */
  async delete(email: string): Promise<void> {
    await this.sql`
      delete from passkey_credentials
      where household_id in (select household_id from users where email = ${normalizeEmail(email)})`
  }
}
