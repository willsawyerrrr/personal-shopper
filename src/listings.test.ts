import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ItemStore } from './items.ts'
import { ItemStore as Items } from './items.ts'
import { createListingBackfill, lookupListing } from './listings.ts'
import { seedItems } from './testing/app.ts'
import { createTestDb } from './testing/db.ts'

const log = { warn: vi.fn() }

describe('lookupListing', () => {
  beforeEach(() => log.warn.mockClear())

  it('returns the looked-up listing', async () => {
    const lookup = { listing: vi.fn().mockResolvedValue('Milk 2L') }
    await expect(lookupListing(lookup, 1, log)).resolves.toBe('Milk 2L')
  })

  it('logs a failure and returns undefined', async () => {
    const lookup = { listing: vi.fn().mockRejectedValue(new Error('boom')) }
    await expect(lookupListing(lookup, 1, log)).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('returns undefined without a lookup', async () => {
    await expect(lookupListing(undefined, 1, log)).resolves.toBeUndefined()
  })
})

describe('createListingBackfill', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  let items: ItemStore
  const EMAIL = 'me@example.com'

  beforeEach(async () => {
    log.warn.mockClear()
    db = await createTestDb()
    items = new Items(db.sql)
  })

  afterEach(async () => {
    await db.close()
  })

  it('fills only items without a listing and logs failures without throwing', async () => {
    await seedItems(
      db.sql,
      'milk:\n  stockcode: 1\n  quantity: 1\nbread:\n  stockcode: 2\n  quantity: 1\n  listing: Bread\neggs:\n  stockcode: 3\n  quantity: 1\n',
    )
    const lookup = {
      listing: vi.fn(async (stockcode: number) => {
        if (stockcode === 3) {
          throw new Error('boom')
        }
        return 'Milk 2L'
      }),
    }
    await createListingBackfill(items, EMAIL, lookup, log)()
    expect(lookup.listing).toHaveBeenCalledTimes(2)
    const written = await items.load(EMAIL)
    expect(written.milk?.listing).toBe('Milk 2L')
    expect(written.bread?.listing).toBe('Bread')
    expect(written.eggs?.listing).toBeUndefined()
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('does not overwrite an item whose stockcode changed during the lookup', async () => {
    await seedItems(db.sql, 'milk:\n  stockcode: 1\n  quantity: 1\n')
    const lookup = {
      listing: vi.fn(async () => {
        await seedItems(db.sql, 'milk:\n  stockcode: 7\n  quantity: 1\n')
        return 'Milk 2L'
      }),
    }
    await createListingBackfill(items, EMAIL, lookup, log)()
    expect((await items.load(EMAIL)).milk?.listing).toBeUndefined()
  })

  it('runs once for overlapping triggers', async () => {
    await seedItems(db.sql, 'milk:\n  stockcode: 1\n  quantity: 1\n')
    const lookup = { listing: vi.fn().mockResolvedValue('Milk 2L') }
    const backfill = createListingBackfill(items, EMAIL, lookup, log)
    await Promise.all([backfill(), backfill()])
    expect(lookup.listing).toHaveBeenCalledOnce()
  })

  it('does nothing without a lookup', async () => {
    await seedItems(db.sql, 'milk:\n  stockcode: 1\n  quantity: 1\n')
    await createListingBackfill(items, EMAIL, undefined, log)()
    expect((await items.load(EMAIL)).milk?.listing).toBeUndefined()
  })

  it('only touches the given user', async () => {
    await seedItems(db.sql, 'milk:\n  stockcode: 1\n  quantity: 1\n')
    await seedItems(db.sql, 'milk:\n  stockcode: 1\n  quantity: 1\n', 'you@example.com')
    const lookup = { listing: vi.fn().mockResolvedValue('Milk 2L') }
    await createListingBackfill(items, EMAIL, lookup, log)()
    expect((await items.load('you@example.com')).milk?.listing).toBeUndefined()
  })

  it('logs a failure to read the items', async () => {
    const lookup = { listing: vi.fn() }
    const broken = { load: vi.fn().mockRejectedValue(new Error('down')) } as unknown as ItemStore
    await createListingBackfill(broken, EMAIL, lookup, log)()
    expect(log.warn).toHaveBeenCalledOnce()
  })
})
