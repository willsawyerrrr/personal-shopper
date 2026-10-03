import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const BASE = {
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  ALLOWED_EMAILS: 'me@example.com',
  PUBLIC_BASE_URL: 'https://shop.example.com',
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
      tokenStorePath: 'tokens.json',
      itemsPath: 'items.yml',
      sessionPath: 'session.json',
      sessionKeepAliveIntervalMs: 6 * 60 * 60 * 1000,
      passkeyCredentialsPath: 'passkey-credentials.json',
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
    expect(config.itemsPath).toBe('/tmp/items.yml')
    expect(config.sessionPath).toBe('/tmp/session.json')
    expect(config.sessionKeepAliveIntervalMs).toBe(0)
    expect(config.passkeyCredentialsPath).toBe('/tmp/passkey.json')
    expect(config.tokenStorePath).toBe('/tmp/tokens.json')
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
