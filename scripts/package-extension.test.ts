import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isRuntimeFile,
  packageExtension,
  serverOrigin,
  storeManifest,
} from './package-extension.ts'

const AUTH = "export const SERVER_URL = 'https://app.example.test/'\n"

describe('serverOrigin', () => {
  it('reads the origin of SERVER_URL', () => {
    expect(serverOrigin(AUTH)).toBe('https://app.example.test')
  })

  it('throws without a SERVER_URL', () => {
    expect(() => serverOrigin('')).toThrow('SERVER_URL')
  })
})

describe('storeManifest', () => {
  it('drops the key and narrows host permissions', () => {
    const manifest = storeManifest(
      {
        name: 'x',
        version: '1.2.3',
        key: 'abc',
        permissions: ['storage'],
        host_permissions: ['http://*/*', 'https://*.willsawyerrrr.dev/*'],
      },
      'https://app.example.test',
    )
    expect(manifest).toEqual({
      name: 'x',
      version: '1.2.3',
      permissions: ['storage'],
      host_permissions: ['https://app.example.test/*', 'https://*.woolworths.com.au/*'],
    })
  })
})

describe('isRuntimeFile', () => {
  it.each(['popup.js', 'popup.html', 'icons/icon-16.png'])('ships %s', (path) => {
    expect(isRuntimeFile(path)).toBe(true)
  })

  it.each(['manifest.json', 'README.md', 'auth.test.js', 'store/listing.md'])(
    'omits %s',
    (path) => {
      expect(isRuntimeFile(path)).toBe(false)
    },
  )
})

describe('packageExtension', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'package-extension-'))
    const source = join(dir, 'extension')
    mkdirSync(join(source, 'icons'), { recursive: true })
    mkdirSync(join(source, 'store'))
    writeFileSync(join(source, 'manifest.json'), JSON.stringify({ version: '2.0.0', key: 'k' }))
    writeFileSync(join(source, 'auth.js'), AUTH)
    writeFileSync(join(source, 'auth.test.js'), '')
    writeFileSync(join(source, 'README.md'), '')
    writeFileSync(join(source, 'icons', 'icon-16.png'), '')
    writeFileSync(join(source, 'store', 'listing.md'), '')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true })
  })

  it('zips the runtime files with the store manifest', () => {
    const output = join(dir, 'out', 'extension.zip')
    packageExtension(join(dir, 'extension'), output)
    const names = execFileSync('unzip', ['-Z1', output], { encoding: 'utf8' })
      .split('\n')
      .filter((name) => name && !name.endsWith('/'))
      .sort()
    expect(names).toEqual(['auth.js', 'icons/icon-16.png', 'manifest.json'])
    const manifest = JSON.parse(
      execFileSync('unzip', ['-p', output, 'manifest.json'], { encoding: 'utf8' }),
    )
    expect(manifest).toEqual({
      version: '2.0.0',
      host_permissions: ['https://app.example.test/*', 'https://*.woolworths.com.au/*'],
    })
  })
})
