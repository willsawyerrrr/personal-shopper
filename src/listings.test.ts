import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createListingBackfill, lookupListing } from './listings.ts'

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
  let dir: string
  let path: string

  beforeEach(async () => {
    log.warn.mockClear()
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-'))
    path = join(dir, 'items.yml')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true })
  })

  it('fills only items without a listing and logs failures without throwing', async () => {
    await writeFile(
      path,
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
    await createListingBackfill(path, lookup, log)()
    expect(lookup.listing).toHaveBeenCalledTimes(2)
    const written = await readFile(path, 'utf8')
    expect(written).toContain('listing: Milk 2L')
    expect(written).toContain('listing: Bread')
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('does not overwrite an item whose stockcode changed during the lookup', async () => {
    await writeFile(path, 'milk:\n  stockcode: 1\n  quantity: 1\n')
    const lookup = {
      listing: vi.fn(async () => {
        await writeFile(path, 'milk:\n  stockcode: 7\n  quantity: 1\n')
        return 'Milk 2L'
      }),
    }
    await createListingBackfill(path, lookup, log)()
    expect(await readFile(path, 'utf8')).not.toContain('listing')
  })

  it('runs once for overlapping triggers', async () => {
    await writeFile(path, 'milk:\n  stockcode: 1\n  quantity: 1\n')
    const lookup = { listing: vi.fn().mockResolvedValue('Milk 2L') }
    const backfill = createListingBackfill(path, lookup, log)
    await Promise.all([backfill(), backfill()])
    expect(lookup.listing).toHaveBeenCalledOnce()
  })

  it('does nothing without a lookup', async () => {
    await writeFile(path, 'milk:\n  stockcode: 1\n  quantity: 1\n')
    await createListingBackfill(path, undefined, log)()
    expect(await readFile(path, 'utf8')).not.toContain('listing')
  })

  it('logs a failure to read the items file', async () => {
    await writeFile(path, 'milk: [\n')
    const lookup = { listing: vi.fn() }
    await createListingBackfill(path, lookup, log)()
    expect(log.warn).toHaveBeenCalledOnce()
  })
})
