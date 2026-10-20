import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ItemStore, parseItemsYaml, resolveItem, type ItemsConfig } from './items.ts'
import { createTestDb } from './testing/db.ts'

describe('resolveItem', () => {
  const items: ItemsConfig = {
    milk: { stockcode: 123456, quantity: 1 },
  }

  it('matches an exact key', () => {
    expect(resolveItem(items, 'milk')).toEqual({ stockcode: 123456, quantity: 1 })
  })

  it('normalizes case and surrounding whitespace', () => {
    expect(resolveItem(items, '  Milk  ')).toEqual({ stockcode: 123456, quantity: 1 })
  })

  it('returns undefined for an unmapped term', () => {
    expect(resolveItem(items, 'bread')).toBeUndefined()
  })
})

describe('parseItemsYaml', () => {
  it('parses a YAML mapping file', () => {
    expect(parseItemsYaml('milk:\n  stockcode: 123456\n  quantity: 1\n')).toEqual({
      milk: { stockcode: 123456, quantity: 1 },
    })
  })

  it('treats an empty file as no items', () => {
    expect(parseItemsYaml('')).toEqual({})
  })

  it('ignores fields other than stockcode, quantity and listing', () => {
    expect(parseItemsYaml('milk:\n  stockcode: 1\n  quantity: 2\n  name: Milk\n')).toEqual({
      milk: { stockcode: 1, quantity: 2 },
    })
  })
})

describe('ItemStore', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  let store: ItemStore

  beforeEach(async () => {
    db = await createTestDb()
    store = new ItemStore(db.sql)
  })

  afterEach(async () => {
    await db.close()
  })

  it('reads no items for an unknown user', async () => {
    await expect(store.load('nobody@example.com')).resolves.toEqual({})
  })

  it('round-trips items in order, with listings', async () => {
    const items: ItemsConfig = {
      milk: { stockcode: 123456, quantity: 1, listing: 'Maleny Dairies Full Cream 2L' },
      bread: { stockcode: 2, quantity: 3 },
    }
    await store.save('me@example.com', items)
    const loaded = await store.load('me@example.com')
    expect(loaded).toEqual(items)
    expect(Object.keys(loaded)).toEqual(['milk', 'bread'])
  })

  it('round-trips display names', async () => {
    const items: ItemsConfig = {
      milk: { stockcode: 1, quantity: 1, name: 'Milk' },
      bread: { stockcode: 2, quantity: 1 },
    }
    await store.save('me@example.com', items)
    expect(await store.load('me@example.com')).toEqual(items)
  })

  it('replaces the previous items on save', async () => {
    await store.save('me@example.com', { milk: { stockcode: 1, quantity: 1 } })
    await store.save('me@example.com', { bread: { stockcode: 2, quantity: 1 } })
    await expect(store.load('me@example.com')).resolves.toEqual({
      bread: { stockcode: 2, quantity: 1 },
    })
  })

  it('keeps each user their own items, whatever the email casing', async () => {
    await store.save('Me@Example.com', { milk: { stockcode: 1, quantity: 1 } })
    await store.save('you@example.com', { milk: { stockcode: 9, quantity: 2 } })
    await expect(store.load('me@example.com')).resolves.toEqual({
      milk: { stockcode: 1, quantity: 1 },
    })
    await expect(store.load('YOU@example.com')).resolves.toEqual({
      milk: { stockcode: 9, quantity: 2 },
    })
  })
})
