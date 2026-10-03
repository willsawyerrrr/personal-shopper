export interface RemindersSyncConfig {
  icloudUsername: string
  icloudAppSpecificPassword: string
  listName: string
  intervalMs: number
}

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export interface AppConfig {
  port: number
  logLevel: LogLevel
  trustProxy: boolean
  googleClientId: string
  googleClientSecret: string
  /** Lower-cased Google account emails allowed to sign in. */
  allowedEmails: string[]
  /** Origin the server is reached at, without a trailing slash. */
  publicBaseUrl: string
  /** Redirect URIs API clients may pass to `/auth/start`, matched exactly. */
  allowedClientRedirects: string[]
  tokenStorePath: string
  itemsPath: string
  sessionPath: string
  sessionKeepAliveIntervalMs: number
  passkeyCredentialsPath: string
  remindersSync: RemindersSyncConfig | undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: Number(env.PORT ?? 3000),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    // Behind a reverse proxy (Fly) the client IP, which rate limiting keys on,
    // is only in `X-Forwarded-For`; trusting it when exposed directly would
    // let clients spoof it.
    trustProxy: env.TRUST_PROXY === 'true',
    googleClientId: required(env, 'GOOGLE_CLIENT_ID'),
    googleClientSecret: required(env, 'GOOGLE_CLIENT_SECRET'),
    allowedEmails: parseAllowedEmails(required(env, 'ALLOWED_EMAILS')),
    publicBaseUrl: parsePublicBaseUrl(required(env, 'PUBLIC_BASE_URL')),
    allowedClientRedirects: parseList(env.ALLOWED_CLIENT_REDIRECTS ?? DEFAULT_CLIENT_REDIRECT),
    tokenStorePath: env.TOKEN_STORE_PATH ?? 'tokens.json',
    itemsPath: env.ITEMS_PATH ?? 'items.yml',
    sessionPath: env.SESSION_PATH ?? 'session.json',
    // 0 disables the timer; the session then only refreshes on demand.
    sessionKeepAliveIntervalMs: Number(env.SESSION_KEEPALIVE_INTERVAL_MS ?? 6 * 60 * 60 * 1000),
    passkeyCredentialsPath: env.PASSKEY_CREDENTIALS_PATH ?? 'passkey-credentials.json',
    remindersSync: loadRemindersSyncConfig(env),
  }
}

/** The iOS app's custom URL scheme; the Chrome extension's redirect URI is deployment-specific. */
const DEFAULT_CLIENT_REDIRECT = 'dev.willsawyerrrr.personalshopper://auth'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) {
    throw new Error(`${name} environment variable is required`)
  }
  return value
}

function parseList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function parseAllowedEmails(value: string): string[] {
  const emails = parseList(value).map((email) => email.toLowerCase())
  if (emails.length === 0) {
    throw new Error('ALLOWED_EMAILS must list at least one email')
  }
  return emails
}

function parsePublicBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('PUBLIC_BASE_URL must be an absolute http(s) URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('PUBLIC_BASE_URL must be an absolute http(s) URL')
  }
  return url.origin
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (!value) {
    return 'info'
  }
  const level = LOG_LEVELS.find((candidate) => candidate === value.toLowerCase())
  if (!level) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`)
  }
  return level
}

// Syncing the offline-queue Reminders list (see docs/architecture.md) needs
// an iCloud app-specific password, so it's opt-in — deployments that don't
// set these two vars just skip it.
function loadRemindersSyncConfig(env: NodeJS.ProcessEnv): RemindersSyncConfig | undefined {
  const icloudUsername = env.ICLOUD_USERNAME
  const icloudAppSpecificPassword = env.ICLOUD_APP_SPECIFIC_PASSWORD
  if (!icloudUsername || !icloudAppSpecificPassword) {
    return undefined
  }
  return {
    icloudUsername,
    icloudAppSpecificPassword,
    listName: env.REMINDERS_LIST_NAME ?? 'Shopping List',
    intervalMs: Number(env.REMINDERS_SYNC_INTERVAL_MS ?? 5 * 60 * 1000),
  }
}
