import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CartStore } from './cart-store.ts'
import { ItemStore, type Item } from './items.ts'
import { itemIdFor, seedItems } from './testing/app.ts'
import { createTestDb } from './testing/db.ts'

const YAML = 'milk:\n  stockcode: 1\n  quantity: 1\nbread:\n  stockcode: 2\n  quantity: 1\n'

describe('CartStore', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  let store: CartStore
  let milk: string
  let bread: string

  beforeEach(async () => {
    db = await createTestDb()
    store = new CartStore(db.sql)
    await seedItems(db.sql, YAML)
    milk = await itemIdFor(db.sql, 'milk')
    bread = await itemIdFor(db.sql, 'bread')
  })

  afterEach(() => db.close())

  it('adds one at a time, incrementing the count', async () => {
    expect(await store.add('me@example.com', milk)).toBe(1)
    expect(await store.add('ME@example.com', milk)).toBe(2)
    await store.add('me@example.com', bread)
    expect(await store.list('me@example.com')).toEqual([
      { itemId: milk, count: 2 },
      { itemId: bread, count: 1 },
    ])
  })

  it("refuses an item that is not in the user's household", async () => {
    await seedItems(db.sql, YAML, 'you@example.com')
    expect(await store.add('you@example.com', milk)).toBeUndefined()
    expect(await store.add('nobody@example.com', milk)).toBeUndefined()
    expect(await store.list('you@example.com')).toEqual([])
  })

  it('is shared by the members of a household and separate from others', async () => {
    await seedItems(db.sql, YAML, 'you@example.com')
    await store.add('you@example.com', await itemIdFor(db.sql, 'milk', 'you@example.com'))
    expect(await store.list('me@example.com')).toEqual([])
  })

  it('removes an entry, reporting whether it was there', async () => {
    await store.add('me@example.com', milk)
    expect(await store.remove('me@example.com', milk)).toBe(true)
    expect(await store.remove('me@example.com', milk)).toBe(false)
    expect(await store.list('me@example.com')).toEqual([])
  })

  it('removes some of a count, deleting the entry once none is left', async () => {
    for (let i = 0; i < 3; i++) {
      await store.add('me@example.com', milk)
    }
    await store.remove('me@example.com', milk, 2)
    expect(await store.list('me@example.com')).toEqual([{ itemId: milk, count: 1 }])
    await store.remove('me@example.com', milk, 5)
    expect(await store.list('me@example.com')).toEqual([])
  })

  it('clears the cart', async () => {
    await store.add('me@example.com', milk)
    await store.add('me@example.com', bread)
    await store.clear('me@example.com')
    expect(await store.list('me@example.com')).toEqual([])
  })

  it('keeps the entries of items that survive an items save and drops the rest', async () => {
    await store.add('me@example.com', milk)
    await store.add('me@example.com', bread)
    const items = new ItemStore(db.sql)
    const [first, ...rest] = await items.load('me@example.com')
    await items.save('me@example.com', [{ ...(first as Item), name: 'Renamed' }])
    const kept = (first as Item).id
    expect(await store.list('me@example.com')).toEqual([{ itemId: kept, count: 1 }])
    expect(rest).toHaveLength(1)
    await items.save('me@example.com', [])
    expect(await store.list('me@example.com')).toEqual([])
  })
})
