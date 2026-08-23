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
    })
  })

  it('reads overrides from the environment', () => {
    const config = loadConfig({
      SHARED_SECRET: 'secret',
      PORT: '4000',
      ITEMS_PATH: '/tmp/items.yml',
      SESSION_PATH: '/tmp/session.json',
    })
    expect(config.port).toBe(4000)
    expect(config.itemsPath).toBe('/tmp/items.yml')
    expect(config.sessionPath).toBe('/tmp/session.json')
  })
})
