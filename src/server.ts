import { buildApp } from './app.ts'
import { loadConfig } from './config.ts'
import { connect } from './db.ts'
import { HouseholdStore } from './households.ts'
import { ItemStore } from './items.ts'
import { ICloudRemindersClient } from './reminders/client.ts'
import { syncReminders } from './reminders/sync.ts'
import { CredentialStore, credentialsStored } from './users/credentials.ts'
import { importLegacyFiles } from './users/import.ts'
import { UserWoolworths } from './users/woolworths.ts'
import { PickupClient } from './woolworths/pickup.ts'

const config = loadConfig()
const { ownerEmail } = config
const sql = connect(config.databaseUrl)

// The passkey fallback is opt-in: without credentials an expired session just
// fails until it is re-captured by hand. Stored credentials are useless
// without the key, so their presence makes it mandatory.
if (!config.credentialsEncryptionKey && (await credentialsStored(sql))) {
  throw new Error('CREDENTIALS_ENCRYPTION_KEY is required when passkey credentials exist')
}
const credentials = config.credentialsEncryptionKey
  ? new CredentialStore(sql, config.credentialsEncryptionKey)
  : undefined
const imported = await importLegacyFiles(sql, config.legacyFiles, ownerEmail, credentials)

const woolworths = new UserWoolworths(sql, credentials)
const app = buildApp(config, {
  sql,
  cart: (email) => woolworths.clientFor(email),
  lookup: (email) => woolworths.clientFor(email),
  pickup: new PickupClient(),
  ...(credentials && {
    passkeys: { credentials, sessions: woolworths },
  }),
})
app.addHook('onClose', () => sql.end())
if (imported.length > 0) {
  app.log.info({ imported }, 'imported single-user files into the owner')
}

if (config.sessionKeepAliveIntervalMs > 0) {
  // Users with no stored session have nothing to keep alive.
  const keepAlive = async (email: string): Promise<void> => {
    const sessions = woolworths.sessionsFor(email)
    const session = await sessions.find()
    if (session) {
      await sessions.refresh(session)
    }
  }
  setInterval(
    () =>
      void (async () => {
        // Members of a household share a session, so one of them stands for it.
        const emails = new Set([
          ...(ownerEmail ? [ownerEmail] : []),
          ...(await app.tokens.emails()),
        ])
        for (const email of await new HouseholdStore(sql).onePerHousehold([...emails])) {
          await keepAlive(email).catch((error: unknown) => app.log.error(error))
        }
      })().catch((error: unknown) => app.log.error(error)),
    config.sessionKeepAliveIntervalMs,
  )
}

if (config.remindersSync) {
  const { icloudUsername, icloudAppSpecificPassword, listName, intervalMs } = config.remindersSync
  const reminders = new ICloudRemindersClient(icloudUsername, icloudAppSpecificPassword, listName)
  const itemStore = new ItemStore(sql)
  // `loadConfig` requires an owner whenever the sync is enabled.
  const owner = ownerEmail as string
  const runSync = async (): Promise<void> => {
    const items = await itemStore.load(owner)
    await syncReminders(reminders, items, woolworths.clientFor(owner), app.log)
  }
  setInterval(() => void runSync().catch((error: unknown) => app.log.error(error)), intervalMs)
  void runSync().catch((error: unknown) => app.log.error(error))
}

app.listen({ port: config.port, host: '0.0.0.0' })
