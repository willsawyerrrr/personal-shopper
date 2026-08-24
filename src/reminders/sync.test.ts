import { describe, expect, it, vi } from 'vitest'
import type { ItemsConfig } from '../items.ts'
import type { CartClient } from '../woolworths/client.ts'
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

const items: ItemsConfig = { milk: { stockcode: 123456, quantity: 1 } }

function reminder(title: string): QueuedReminder {
  return { url: `https://example.com/${title}.ics`, etag: 'etag', title }
}

describe('syncReminders', () => {
  it('adds a mapped item to the cart and dequeues the reminder', async () => {
    const milk = reminder('milk')
    const reminders: RemindersClient = {
      listPending: vi.fn().mockResolvedValue([milk]),
      remove: vi.fn().mockResolvedValue(undefined),
    }
    const cart: CartClient = { addToCart: vi.fn().mockResolvedValue(undefined) }
    const { logger } = recordingLogger()

    await syncReminders(reminders, items, cart, logger)

    expect(cart.addToCart).toHaveBeenCalledWith(123456, 1)
    expect(reminders.remove).toHaveBeenCalledWith(milk)
  })

  it('leaves an unmapped reminder queued', async () => {
    const bread = reminder('bread')
    const reminders: RemindersClient = {
      listPending: vi.fn().mockResolvedValue([bread]),
      remove: vi.fn(),
    }
    const cart: CartClient = { addToCart: vi.fn() }
    const { logger, warnings } = recordingLogger()

    await syncReminders(reminders, items, cart, logger)

    expect(cart.addToCart).not.toHaveBeenCalled()
    expect(reminders.remove).not.toHaveBeenCalled()
    expect(warnings).toEqual([expect.stringContaining('bread')])
  })

  it('leaves a reminder queued when the cart call fails, and keeps processing others', async () => {
    const milk = reminder('milk')
    const reminders: RemindersClient = {
      listPending: vi.fn().mockResolvedValue([milk, milk]),
      remove: vi.fn(),
    }
    const cart: CartClient = { addToCart: vi.fn().mockRejectedValue(new Error('session expired')) }
    const { logger, errors } = recordingLogger()

    await syncReminders(reminders, items, cart, logger)

    expect(cart.addToCart).toHaveBeenCalledTimes(2)
    expect(reminders.remove).not.toHaveBeenCalled()
    expect(errors).toHaveLength(2)
  })
})
