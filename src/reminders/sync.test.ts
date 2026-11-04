import { describe, expect, it, vi } from 'vitest'
import type { ItemsConfig } from '../items.ts'
import type { QueuedReminder, RemindersClient } from './client.ts'
import { syncReminders, type SyncLogger } from './sync.ts'

function recordingLogger(): { logger: SyncLogger; warnings: string[]; errors: string[] } {
  const warnings: string[] = []
  const errors: string[] = []
  const logger: SyncLogger = {
    info: () => {},
    warn: (msg) => warnings.push(msg),
    error: (msg) => errors.push(msg),
  }
  return { logger, warnings, errors }
}

const items: ItemsConfig = [
  { id: 'milk-id', words: ['milk'], candidates: [{ stockcode: 123456, quantity: 1 }] },
]

function reminder(title: string): QueuedReminder {
  return { url: `https://example.com/${title}.ics`, etag: 'etag', title }
}

describe('syncReminders', () => {
  it('adds a mapped item to the Personal Shopper cart and dequeues the reminder', async () => {
    const milk = reminder('milk')
    const reminders: RemindersClient = {
      listPending: vi.fn().mockResolvedValue([milk]),
      remove: vi.fn().mockResolvedValue(undefined),
    }
    const addToCart = vi.fn().mockResolvedValue(undefined)
    const { logger } = recordingLogger()

    await syncReminders(reminders, items, addToCart, logger)

    expect(addToCart).toHaveBeenCalledWith('milk-id')
    expect(reminders.remove).toHaveBeenCalledWith(milk)
  })

  it('leaves an unmapped reminder queued', async () => {
    const bread = reminder('bread')
    const reminders: RemindersClient = {
      listPending: vi.fn().mockResolvedValue([bread]),
      remove: vi.fn(),
    }
    const addToCart = vi.fn()
    const { logger, warnings } = recordingLogger()

    await syncReminders(reminders, items, addToCart, logger)

    expect(addToCart).not.toHaveBeenCalled()
    expect(reminders.remove).not.toHaveBeenCalled()
    expect(warnings).toEqual([expect.stringContaining('bread')])
  })

  it('leaves a reminder queued when adding to the cart fails, and keeps processing others', async () => {
    const milk = reminder('milk')
    const reminders: RemindersClient = {
      listPending: vi.fn().mockResolvedValue([milk, milk]),
      remove: vi.fn(),
    }
    const addToCart = vi.fn().mockRejectedValue(new Error('database down'))
    const { logger, errors } = recordingLogger()

    await syncReminders(reminders, items, addToCart, logger)

    expect(addToCart).toHaveBeenCalledTimes(2)
    expect(reminders.remove).not.toHaveBeenCalled()
    expect(errors).toHaveLength(2)
  })
})
