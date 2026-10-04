import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const BASE = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  ALLOWED_EMAILS: 'me@example.com',
  PUBLIC_BASE_URL: 'https://shop.example.com',
  DATABASE_URL: 'postgres://db.example.com/postgres',
}

describe('loadConfig', () => {
  it.each(Object.keys(BASE))('throws when %s is missing', (name) => {
    const env: Record<string, string> = { ...BASE }
    delete env[name]
    expect(() => loadConfig(env)).toThrow(`${name} environment variable is required`)
  })

  it('treats a blank required variable as missing', () => {
    expect(() => loadConfig({ ...BASE, GOOGLE_CLIENT_SECRET: '  ' })).toThrow(
      'GOOGLE_CLIENT_SECRET environment variable is required',
    )
  })

  it('applies defaults for optional fields', () => {
    expect(loadConfig(BASE)).toEqual({
      port: 3000,
      logLevel: 'info',
      trustProxy: false,
      googleClientId: 'client-id',
      googleClientSecret: 'client-secret',
      allowedEmails: ['me@example.com'],
      publicBaseUrl: 'https://shop.example.com',
      allowedClientRedirects: ['dev.willsawyerrrr.personalshopper://auth'],
      databaseUrl: 'postgres://db.example.com/postgres',
      legacyFiles: {
        tokens: 'tokens.json',
        items: 'items.yml',
        session: 'session.json',
        passkeyCredentials: 'passkey-credentials.json',
      },
      ownerEmail: 'me@example.com',
      credentialsEncryptionKey: undefined,
      sessionKeepAliveIntervalMs: 6 * 60 * 60 * 1000,
      remindersSync: undefined,
    })
  })

  it('reads overrides from the environment', () => {
    const config = loadConfig({
      ...BASE,
      PORT: '4000',
      TRUST_PROXY: 'true',
      ITEMS_PATH: '/tmp/items.yml',
      SESSION_PATH: '/tmp/session.json',
      SESSION_KEEPALIVE_INTERVAL_MS: '0',
      PASSKEY_CREDENTIALS_PATH: '/tmp/passkey.json',
      TOKEN_STORE_PATH: '/tmp/tokens.json',
    })
    expect(config.port).toBe(4000)
    expect(config.trustProxy).toBe(true)
    expect(config.legacyFiles).toEqual({
      tokens: '/tmp/tokens.json',
      items: '/tmp/items.yml',
      session: '/tmp/session.json',
      passkeyCredentials: '/tmp/passkey.json',
    })
    expect(config.sessionKeepAliveIntervalMs).toBe(0)
  })

  it('makes the first allowed email the owner by default', () => {
    expect(
      loadConfig({ ...BASE, ALLOWED_EMAILS: 'First@Example.com,second@example.com' }).ownerEmail,
    ).toBe('first@example.com')
  })

  it('reads the owner from REMINDERS_OWNER_EMAIL', () => {
    expect(
      loadConfig({
        ...BASE,
        ALLOWED_EMAILS: 'a@example.com,b@example.com',
        REMINDERS_OWNER_EMAIL: ' B@Example.com ',
      }).ownerEmail,
    ).toBe('b@example.com')
  })

  it('reads the credentials encryption key as base64 or hex', () => {
    const key = Buffer.alloc(32, 7)
    expect(
      loadConfig({ ...BASE, CREDENTIALS_ENCRYPTION_KEY: key.toString('base64') })
        .credentialsEncryptionKey,
    ).toEqual(key)
    expect(
      loadConfig({ ...BASE, CREDENTIALS_ENCRYPTION_KEY: key.toString('hex') })
        .credentialsEncryptionKey,
    ).toEqual(key)
  })

  it('rejects a credentials encryption key of the wrong length', () => {
    expect(() => loadConfig({ ...BASE, CREDENTIALS_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(
      'CREDENTIALS_ENCRYPTION_KEY must be 32 bytes',
    )
  })

  it('lower-cases and trims the allowed emails', () => {
    const config = loadConfig({ ...BASE, ALLOWED_EMAILS: ' Me@Example.com, you@example.com ,' })
    expect(config.allowedEmails).toEqual(['me@example.com', 'you@example.com'])
  })

  it('rejects an allowlist with no emails', () => {
    expect(() => loadConfig({ ...BASE, ALLOWED_EMAILS: ' , ' })).toThrow(
      'ALLOWED_EMAILS must list at least one email',
    )
  })

  it('reduces PUBLIC_BASE_URL to its origin', () => {
    expect(
      loadConfig({ ...BASE, PUBLIC_BASE_URL: 'https://shop.example.com/' }).publicBaseUrl,
    ).toBe('https://shop.example.com')
  })

  it.each(['not a url', 'ftp://shop.example.com'])('rejects PUBLIC_BASE_URL %s', (value) => {
    expect(() => loadConfig({ ...BASE, PUBLIC_BASE_URL: value })).toThrow(
      'PUBLIC_BASE_URL must be an absolute http(s) URL',
    )
  })

  it('reads the allowed client redirects as a comma-separated list', () => {
    const config = loadConfig({
      ...BASE,
      ALLOWED_CLIENT_REDIRECTS: 'app://auth, https://abc.chromiumapp.org/',
    })
    expect(config.allowedClientRedirects).toEqual(['app://auth', 'https://abc.chromiumapp.org/'])
  })

  it('reads LOG_LEVEL case-insensitively', () => {
    expect(loadConfig({ ...BASE, LOG_LEVEL: 'Debug' }).logLevel).toBe('debug')
  })

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => loadConfig({ ...BASE, LOG_LEVEL: 'verbose' })).toThrow('LOG_LEVEL must be one of')
  })

  it('leaves reminders sync disabled unless both iCloud credentials are set', () => {
    expect(loadConfig({ ...BASE, ICLOUD_USERNAME: 'me@example.com' }).remindersSync).toBeUndefined()
    expect(
      loadConfig({ ...BASE, ICLOUD_APP_SPECIFIC_PASSWORD: 'abcd-abcd-abcd-abcd' }).remindersSync,
    ).toBeUndefined()
  })

  it('enables reminders sync with defaults once both iCloud credentials are set', () => {
    const config = loadConfig({
      ...BASE,
      ICLOUD_USERNAME: 'me@example.com',
      ICLOUD_APP_SPECIFIC_PASSWORD: 'abcd-abcd-abcd-abcd',
    })
    expect(config.remindersSync).toEqual({
      icloudUsername: 'me@example.com',
      icloudAppSpecificPassword: 'abcd-abcd-abcd-abcd',
      listName: 'Shopping List',
      intervalMs: 5 * 60 * 1000,
    })
  })

  it('reads reminders sync overrides from the environment', () => {
    const config = loadConfig({
      ...BASE,
      ICLOUD_USERNAME: 'me@example.com',
      ICLOUD_APP_SPECIFIC_PASSWORD: 'abcd-abcd-abcd-abcd',
      REMINDERS_LIST_NAME: 'Woolworths Queue',
      REMINDERS_SYNC_INTERVAL_MS: '60000',
    })
    expect(config.remindersSync).toMatchObject({ listName: 'Woolworths Queue', intervalMs: 60000 })
  })
})
