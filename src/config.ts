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
  sharedSecret: string
  itemsPath: string
  sessionPath: string
  sessionKeepAliveIntervalMs: number
  passkeyCredentialsPath: string
  remindersSync: RemindersSyncConfig | undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const sharedSecret = env.SHARED_SECRET
  if (!sharedSecret) {
    throw new Error('SHARED_SECRET environment variable is required')
  }
  return {
    port: Number(env.PORT ?? 3000),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    // Behind a reverse proxy (Fly) the client IP, which rate limiting keys on,
    // is only in `X-Forwarded-For`; trusting it when exposed directly would
    // let clients spoof it.
    trustProxy: env.TRUST_PROXY === 'true',
    sharedSecret,
    itemsPath: env.ITEMS_PATH ?? 'items.yml',
    sessionPath: env.SESSION_PATH ?? 'session.json',
    // 0 disables the timer; the session then only refreshes on demand.
    sessionKeepAliveIntervalMs: Number(env.SESSION_KEEPALIVE_INTERVAL_MS ?? 6 * 60 * 60 * 1000),
    passkeyCredentialsPath: env.PASSKEY_CREDENTIALS_PATH ?? 'passkey-credentials.json',
    remindersSync: loadRemindersSyncConfig(env),
  }
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
