import { resolveItem, type ItemsConfig } from '../items.ts'
import type { RemindersClient } from './client.ts'

export interface SyncLogger {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export async function syncReminders(
  reminders: RemindersClient,
  items: ItemsConfig,
  addToCart: (itemId: string) => Promise<unknown>,
  logger: SyncLogger,
): Promise<void> {
  const pending = await reminders.listPending()
  for (const reminder of pending) {
    const item = resolveItem(items, reminder.title)
    if (!item?.candidates[0]) {
      logger.warn(`no mapping configured for queued reminder "${reminder.title}", leaving queued`)
      continue
    }
    try {
      await addToCart(item.id)
      await reminders.remove(reminder)
      logger.info(`synced queued reminder "${reminder.title}" to the cart`)
    } catch (error) {
      logger.error(
        `failed to sync queued reminder "${reminder.title}": ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}
