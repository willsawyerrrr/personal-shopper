import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  displayCase,
  ItemStore,
  itemSubtitle,
  itemTitle,
  parseItemsYaml,
  resolveItem,
  sortItems,
  type ItemsConfig,
} from './items.ts'
import { createTestDb } from './testing/db.ts'

describe('resolveItem', () => {
  const items: ItemsConfig = [
    { id: '1', words: ['milk'], candidates: [{ stockcode: 123456, quantity: 1 }] },
  ]

  it('matches an exact word', () => {
    expect(resolveItem(items, 'milk')).toBe(items[0])
  })

  it('normalizes case and surrounding whitespace', () => {
    expect(resolveItem(items, '  Milk  ')).toBe(items[0])
  })

  it('returns undefined for an unmapped term', () => {
    expect(resolveItem(items, 'bread')).toBeUndefined()
  })
})

describe('parseItemsYaml', () => {
  it('parses a word-keyed YAML mapping file into an item', () => {
    const [item] = parseItemsYaml('milk:\n  stockcode: 123456\n  quantity: 1\n')
    expect(item).toMatchObject({
      words: ['milk'],
      candidates: [{ stockcode: 123456, quantity: 1 }],
    })
  })

  it('treats an empty file as no items', () => {
    expect(parseItemsYaml('')).toEqual([])
  })

  it('ignores fields other than stockcode, quantity, listing and alternatives', () => {
    const [item] = parseItemsYaml('milk:\n  stockcode: 1\n  quantity: 2\n  name: Milk\n')
    expect(item).not.toHaveProperty('name')
  })

  it('parses alternatives as further candidates', () => {
    const yaml =
      'bars:\n  stockcode: 1\n  quantity: 1\n  alternatives:\n    - stockcode: 2\n      quantity: 4\n'
    const [item] = parseItemsYaml(yaml)
    expect(item?.candidates).toEqual([
      { stockcode: 1, quantity: 1 },
      { stockcode: 2, quantity: 4 },
    ])
  })

  it('groups words sharing an identical stockcode, quantity and alternatives set', () => {
    const yaml =
      'milk:\n  stockcode: 1\n  quantity: 1\n"full cream milk":\n  stockcode: 1\n  quantity: 1\n'
    const items = parseItemsYaml(yaml)
    expect(items).toHaveLength(1)
    expect(items[0]?.words).toEqual(['milk', 'full cream milk'])
  })
})

describe('displayCase', () => {
  it.each([
    ['milk', 'Milk'],
    ['full cream milk', 'Full Cream Milk'],
    ["ben & jerry's", "Ben & Jerry's"],
    ['7up', '7up'],
    ['coca-cola', 'Coca-Cola'],
    ['  two  spaces', '  Two  Spaces'],
    ['école', 'École'],
    ['', ''],
  ])('%j -> %j', (word, expected) => {
    expect(displayCase(word)).toBe(expected)
  })
})

describe('itemTitle', () => {
  const item = { id: '1', words: ['milk'], candidates: [{ stockcode: 1, quantity: 1 }] }

  it('is the name, else the listing, else the first word display-cased', () => {
    expect(itemTitle(item)).toBe('Milk')
    expect(itemTitle({ ...item, listing: 'Full Cream Milk 2L' })).toBe('Full Cream Milk 2L')
    expect(itemTitle({ ...item, listing: 'Full Cream Milk 2L', name: 'Milk' })).toBe('Milk')
  })
})

describe('itemSubtitle', () => {
  const item = { id: '1', words: ['milk'], candidates: [{ stockcode: 1, quantity: 1 }] }

  it('is the listing only when a name replaces it as the title', () => {
    expect(itemSubtitle({ ...item, listing: 'Full Cream Milk 2L' })).toBeUndefined()
    expect(itemSubtitle({ ...item, listing: 'Full Cream Milk 2L', name: 'Milk' })).toBe(
      'Full Cream Milk 2L',
    )
  })
})

describe('sortItems', () => {
  it('orders by title, ignoring case, then by stockcode and quantity', () => {
    const items: ItemsConfig = [
      { id: '1', words: ['bread'], candidates: [{ stockcode: 2, quantity: 1 }] },
      { id: '2', words: ['milk'], candidates: [{ stockcode: 1, quantity: 1 }] },
      { id: '3', words: ['apple'], candidates: [{ stockcode: 3, quantity: 1 }] },
    ]
    expect(sortItems(items).map((item) => item.words[0])).toEqual(['apple', 'bread', 'milk'])
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
    await expect(store.load('nobody@example.com')).resolves.toEqual([])
  })

  it('round-trips items in order, with listings', async () => {
    const items: ItemsConfig = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        words: ['milk'],
        candidates: [{ stockcode: 123456, quantity: 1 }],
        listing: 'Maleny Dairies Full Cream 2L',
      },
      {
        id: '22222222-2222-2222-2222-222222222222',
        words: ['bread'],
        candidates: [{ stockcode: 2, quantity: 3 }],
      },
    ]
    await store.save('me@example.com', items)
    const loaded = await store.load('me@example.com')
    expect(loaded).toEqual(items)
  })

  it('round-trips an item with several words and candidates', async () => {
    const items: ItemsConfig = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        words: ['big garbage bags', 'large garbage bags'],
        candidates: [
          { stockcode: 1, quantity: 1 },
          { stockcode: 2, quantity: 4 },
        ],
      },
    ]
    await store.save('me@example.com', items)
    expect(await store.load('me@example.com')).toEqual(items)
  })

  it('round-trips display names', async () => {
    const items: ItemsConfig = [
      {
        id: '11111111-1111-1111-1111-111111111111',
        words: ['milk'],
        candidates: [{ stockcode: 1, quantity: 1 }],
        name: 'Milk',
      },
    ]
    await store.save('me@example.com', items)
    expect(await store.load('me@example.com')).toEqual(items)
  })

  it('replaces the previous items on save', async () => {
    await store.save('me@example.com', [
      {
        id: '11111111-1111-1111-1111-111111111111',
        words: ['milk'],
        candidates: [{ stockcode: 1, quantity: 1 }],
      },
    ])
    await store.save('me@example.com', [
      {
        id: '22222222-2222-2222-2222-222222222222',
        words: ['bread'],
        candidates: [{ stockcode: 2, quantity: 1 }],
      },
    ])
    const loaded = await store.load('me@example.com')
    expect(loaded.map((item) => item.words)).toEqual([['bread']])
  })

  it('keeps each user their own items, whatever the email casing', async () => {
    await store.save('Me@Example.com', [
      {
        id: '11111111-1111-1111-1111-111111111111',
        words: ['milk'],
        candidates: [{ stockcode: 1, quantity: 1 }],
      },
    ])
    await store.save('you@example.com', [
      {
        id: '22222222-2222-2222-2222-222222222222',
        words: ['milk'],
        candidates: [{ stockcode: 9, quantity: 2 }],
      },
    ])
    const mine = await store.load('me@example.com')
    expect(mine.map((item) => item.candidates)).toEqual([[{ stockcode: 1, quantity: 1 }]])
    const yours = await store.load('YOU@example.com')
    expect(yours.map((item) => item.candidates)).toEqual([[{ stockcode: 9, quantity: 2 }]])
  })
})
