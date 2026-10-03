import { existsSync } from 'node:fs'
import { buildApp } from './app.ts'
import { loadConfig } from './config.ts'
import { loadItems } from './items.ts'
import { ICloudRemindersClient } from './reminders/client.ts'
import { syncReminders } from './reminders/sync.ts'
import { WoolworthsClient } from './woolworths/client.ts'
import { passkeyLogin } from './woolworths/passkey.ts'
import { SessionStore } from './woolworths/session.ts'

const config = loadConfig()
// The passkey fallback is opt-in: without a registered credential an
// expired session just fails until it is re-captured by hand.
const sessions = new SessionStore(
  config.sessionPath,
  existsSync(config.passkeyCredentialsPath)
    ? () => passkeyLogin(config.passkeyCredentialsPath)
    : undefined,
)
const woolworths = new WoolworthsClient(sessions)
const app = buildApp(config, woolworths)

if (config.sessionKeepAliveIntervalMs > 0) {
  const keepAlive = async (): Promise<void> => {
    await sessions.refresh(await sessions.load())
  }
  setInterval(
    () => void keepAlive().catch((error: unknown) => app.log.error(error)),
    config.sessionKeepAliveIntervalMs,
  )
}

if (config.remindersSync) {
  const { icloudUsername, icloudAppSpecificPassword, listName, intervalMs } = config.remindersSync
  const reminders = new ICloudRemindersClient(icloudUsername, icloudAppSpecificPassword, listName)
  const runSync = async (): Promise<void> => {
    const items = await loadItems(config.itemsPath)
    await syncReminders(reminders, items, woolworths, app.log)
  }
  setInterval(() => void runSync().catch((error: unknown) => app.log.error(error)), intervalMs)
  void runSync().catch((error: unknown) => app.log.error(error))
}

app.listen({ port: config.port, host: '0.0.0.0' })
