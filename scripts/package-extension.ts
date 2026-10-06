import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EXTENSION_DIR = join(ROOT, 'extension')
const OUTPUT = join(ROOT, 'dist', 'extension.zip')

type Manifest = Record<string, unknown>

/** Reads the hosted server's origin from the extension's `SERVER_URL`. */
export function serverOrigin(authSource: string): string {
  const match = /export const SERVER_URL = '([^']+)'/.exec(authSource)
  if (!match?.[1]) {
    throw new Error('SERVER_URL not found in auth.js')
  }
  return new URL(match[1]).origin
}

/**
 * The manifest the Web Store build ships: no pinned `key` (the store assigns
 * the ID) and host access narrowed to the hosted server and the Woolworths
 * login; the web app content script runs on that origin.
 */
export function storeManifest(manifest: Manifest, origin: string): Manifest {
  const { key: _key, content_scripts: contentScripts, ...rest } = manifest
  return {
    ...rest,
    ...(Array.isArray(contentScripts) && {
      content_scripts: contentScripts.map((script: object) => ({
        ...script,
        matches: [`${origin}/*`],
      })),
    }),
    host_permissions: [`${origin}/*`, 'https://*.woolworths.com.au/*'],
  }
}

/** Whether an `extension/` entry (relative path) is shipped in the store build. */
export function isRuntimeFile(path: string): boolean {
  return (
    path !== 'manifest.json' &&
    path !== 'README.md' &&
    !path.endsWith('.test.js') &&
    !path.startsWith('store/')
  )
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  )
}

/** Writes the store build of `extension/` to `output` as a zip. */
export function packageExtension(extensionDir = EXTENSION_DIR, output = OUTPUT): void {
  const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8')) as Manifest
  const origin = serverOrigin(readFileSync(join(extensionDir, 'auth.js'), 'utf8'))
  const staging = mkdtempSync(join(tmpdir(), 'extension-'))
  try {
    for (const file of listFiles(extensionDir)) {
      const path = relative(extensionDir, file)
      if (isRuntimeFile(path)) {
        mkdirSync(dirname(join(staging, path)), { recursive: true })
        cpSync(file, join(staging, path))
      }
    }
    writeFileSync(
      join(staging, 'manifest.json'),
      `${JSON.stringify(storeManifest(manifest, origin), null, 2)}\n`,
    )
    mkdirSync(dirname(output), { recursive: true })
    rmSync(output, { force: true })
    execFileSync('zip', ['-X', '-r', output, '.'], { cwd: staging, stdio: 'ignore' })
  } finally {
    rmSync(staging, { recursive: true })
  }
}

if (import.meta.main) {
  packageExtension()
  console.log(`Wrote ${relative(ROOT, OUTPUT)}`)
}
