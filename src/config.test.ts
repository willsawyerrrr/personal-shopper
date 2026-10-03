import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

describe('loadConfig', () => {
  it('throws when SHARED_SECRET is missing', () => {
    expect(() => loadConfig({})).toThrow('SHARED_SECRET environment variable is required')
  })

  it('applies defaults for optional fields', () => {
    const config = loadConfig({ SHARED_SECRET: 'secret' })
    expect(config).toEqual({
      port: 3000,
      sharedSecret: 'secret',
      itemsPath: 'items.yml',
      sessionPath: 'session.json',
      sessionKeepAliveIntervalMs: 6 * 60 * 60 * 1000,
      passkeyCredentialsPath: 'passkey-credentials.json',
      remindersSync: undefined,
    })
  })

  it('reads overrides from the environment', () => {
    const config = loadConfig({
      SHARED_SECRET: 'secret',
      PORT: '4000',
      ITEMS_PATH: '/tmp/items.yml',
      SESSION_PATH: '/tmp/session.json',
      SESSION_KEEPALIVE_INTERVAL_MS: '0',
      PASSKEY_CREDENTIALS_PATH: '/tmp/passkey.json',
    })
    expect(config.port).toBe(4000)
    expect(config.itemsPath).toBe('/tmp/items.yml')
    expect(config.sessionPath).toBe('/tmp/session.json')
    expect(config.sessionKeepAliveIntervalMs).toBe(0)
    expect(config.passkeyCredentialsPath).toBe('/tmp/passkey.json')
  })

  it('leaves reminders sync disabled unless both iCloud credentials are set', () => {
    expect(
      loadConfig({ SHARED_SECRET: 'secret', ICLOUD_USERNAME: 'me@example.com' }).remindersSync,
    ).toBeUndefined()
    expect(
      loadConfig({ SHARED_SECRET: 'secret', ICLOUD_APP_SPECIFIC_PASSWORD: 'abcd-abcd-abcd-abcd' })
        .remindersSync,
    ).toBeUndefined()
  })

  it('enables reminders sync with defaults once both iCloud credentials are set', () => {
    const config = loadConfig({
      SHARED_SECRET: 'secret',
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
      SHARED_SECRET: 'secret',
      ICLOUD_USERNAME: 'me@example.com',
      ICLOUD_APP_SPECIFIC_PASSWORD: 'abcd-abcd-abcd-abcd',
      REMINDERS_LIST_NAME: 'Woolworths Queue',
      REMINDERS_SYNC_INTERVAL_MS: '60000',
    })
    expect(config.remindersSync).toMatchObject({ listName: 'Woolworths Queue', intervalMs: 60000 })
  })
})
