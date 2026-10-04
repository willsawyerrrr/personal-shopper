import { parseEncryptionKey } from './users/credentials.ts'
import { normalizeEmail } from './users/email.ts'

export interface RemindersSyncConfig {
  icloudUsername: string
  icloudAppSpecificPassword: string
  listName: string
  intervalMs: number
}

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

export interface LegacyFiles {
  tokens: string
  items: string
  session: string
  passkeyCredentials: string
}

/** Abuse limits; each is overridable by an environment variable. */
export interface Limits {
  /** Total users; a Google account beyond this cannot sign up. */
  maxUsers: number
  /** Items a household may map. */
  maxItemsPerHousehold: number
  /** Unexpired invites a household may hold at once. */
  maxInvitesPerHousehold: number
  /** Unexpired tokens (sign-ins) a user may hold at once. */
  maxTokensPerUser: number
  /** Authenticated requests per minute per user on `/admin` and `/cart`. */
  userRequestsPerMinute: number
  /** Requests per minute per client IP on `/auth/*` and `/cart/items`. */
  ipRequestsPerMinute: number
}

export const DEFAULT_LIMITS: Limits = {
  maxUsers: 50,
  maxItemsPerHousehold: 200,
  maxInvitesPerHousehold: 5,
  maxTokensPerUser: 20,
  userRequestsPerMinute: 120,
  ipRequestsPerMinute: 30,
}

export interface AppConfig {
  port: number
  logLevel: LogLevel
  trustProxy: boolean
  googleClientId: string
  googleClientSecret: string
  /** Origin the server is reached at, without a trailing slash. */
  publicBaseUrl: string
  /** Redirect URIs API clients may pass to `/auth/start`, matched exactly. */
  allowedClientRedirects: string[]
  /** Postgres connection string of the privileged role the server connects as. */
  databaseUrl: string
  /** Files of a single-user deployment, imported into the owner's rows on first start. */
  legacyFiles: LegacyFiles
  /**
   * The user the iCloud Reminders sync, the single-user file import and the
   * `scripts/` CLIs act for by default; required when the Reminders sync is
   * enabled.
   */
  ownerEmail: string | undefined
  limits: Limits
  /** Key encrypting stored passkey credentials; required once any credential exists. */
  credentialsEncryptionKey: Buffer | undefined
  sessionKeepAliveIntervalMs: number
  remindersSync: RemindersSyncConfig | undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config: AppConfig = {
    port: Number(env.PORT ?? 3000),
    logLevel: parseLogLevel(env.LOG_LEVEL),
    // Behind a reverse proxy (Fly) the client IP, which rate limiting keys on,
    // is only in `X-Forwarded-For`; trusting it when exposed directly would
    // let clients spoof it.
    trustProxy: env.TRUST_PROXY === 'true',
    googleClientId: required(env, 'GOOGLE_CLIENT_ID'),
    googleClientSecret: required(env, 'GOOGLE_CLIENT_SECRET'),
    publicBaseUrl: parsePublicBaseUrl(required(env, 'PUBLIC_BASE_URL')),
    allowedClientRedirects: parseList(env.ALLOWED_CLIENT_REDIRECTS ?? DEFAULT_CLIENT_REDIRECT),
    databaseUrl: required(env, 'DATABASE_URL'),
    legacyFiles: {
      tokens: env.TOKEN_STORE_PATH ?? 'tokens.json',
      items: env.ITEMS_PATH ?? 'items.yml',
      session: env.SESSION_PATH ?? 'session.json',
      passkeyCredentials: env.PASSKEY_CREDENTIALS_PATH ?? 'passkey-credentials.json',
    },
    ownerEmail: resolveOwnerEmail(env),
    limits: loadLimits(env),
    credentialsEncryptionKey: env.CREDENTIALS_ENCRYPTION_KEY?.trim()
      ? parseEncryptionKey(env.CREDENTIALS_ENCRYPTION_KEY)
      : undefined,
    // 0 disables the timer; the session then only refreshes on demand.
    sessionKeepAliveIntervalMs: Number(env.SESSION_KEEPALIVE_INTERVAL_MS ?? 6 * 60 * 60 * 1000),
    remindersSync: loadRemindersSyncConfig(env),
  }
  if (config.remindersSync && !config.ownerEmail) {
    throw new Error('REMINDERS_OWNER_EMAIL is required when the Reminders sync is enabled')
  }
  return config
}

/** `REMINDERS_OWNER_EMAIL`, lower-cased; undefined when unset. */
export function resolveOwnerEmail(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const owner = env.REMINDERS_OWNER_EMAIL?.trim()
  return owner ? normalizeEmail(owner) : undefined
}

function loadLimits(env: NodeJS.ProcessEnv): Limits {
  return {
    maxUsers: positiveInt(env, 'MAX_USERS', DEFAULT_LIMITS.maxUsers),
    maxItemsPerHousehold: positiveInt(
      env,
      'MAX_ITEMS_PER_HOUSEHOLD',
      DEFAULT_LIMITS.maxItemsPerHousehold,
    ),
    maxInvitesPerHousehold: positiveInt(
      env,
      'MAX_INVITES_PER_HOUSEHOLD',
      DEFAULT_LIMITS.maxInvitesPerHousehold,
    ),
    maxTokensPerUser: positiveInt(env, 'MAX_TOKENS_PER_USER', DEFAULT_LIMITS.maxTokensPerUser),
    userRequestsPerMinute: positiveInt(
      env,
      'USER_RATE_LIMIT_PER_MINUTE',
      DEFAULT_LIMITS.userRequestsPerMinute,
    ),
    ipRequestsPerMinute: positiveInt(
      env,
      'IP_RATE_LIMIT_PER_MINUTE',
      DEFAULT_LIMITS.ipRequestsPerMinute,
    ),
  }
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim()
  if (!raw) {
    return fallback
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

/** The iOS app's custom URL scheme; the Chrome extension's redirect URI is deployment-specific. */
const DEFAULT_CLIENT_REDIRECT = 'dev.willsawyerrrr.personal-shopper://auth'

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
