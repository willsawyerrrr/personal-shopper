import { describe, expect, it } from 'vitest'
import type { ItemsConfig } from './items.ts'
import {
  applyGroupEdit,
  displayCase,
  groupItems,
  groupTitle,
  parseWords,
  removeGroup,
} from './products.ts'

const items: ItemsConfig = {
  milk: { stockcode: 1, quantity: 1, listing: 'Full Cream Milk 2L' },
  bread: { stockcode: 2, quantity: 1 },
  'full cream milk': { stockcode: 1, quantity: 1 },
  'two milks': { stockcode: 1, quantity: 2 },
}

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

describe('groupItems', () => {
  it('groups by stockcode and quantity, ordered by the first word', () => {
    expect(groupItems(items)).toEqual([
      {
        words: ['milk', 'full cream milk'],
        stockcode: 1,
        quantity: 1,
        listing: 'Full Cream Milk 2L',
      },
      { words: ['bread'], stockcode: 2, quantity: 1 },
      { words: ['two milks'], stockcode: 1, quantity: 2 },
    ])
  })

  it('takes the listing from any word that has one', () => {
    expect(groupItems({ a: { stockcode: 1, quantity: 1 }, b: items.milk! })[0]?.listing).toBe(
      'Full Cream Milk 2L',
    )
  })
})

describe('groupTitle', () => {
  it('is the listing, else the first word display-cased', () => {
    const [milk, bread] = groupItems(items)
    expect(groupTitle(milk!)).toBe('Full Cream Milk 2L')
    expect(groupTitle(bread!)).toBe('Bread')
  })
})

describe('parseWords', () => {
  it('normalises, de-duplicates and drops blanks', () => {
    expect(parseWords(' Milk, milk ,, Full Cream ')).toEqual(['milk', 'full cream'])
    expect(parseWords(['A', 'a', ' '])).toEqual(['a'])
  })

  it('rejects non-string input', () => {
    expect(parseWords([1])).toBeUndefined()
    expect(parseWords(undefined)).toBeUndefined()
  })
})

describe('applyGroupEdit', () => {
  const edit = (fields: Record<string, unknown>) => applyGroupEdit(items, 1, 1, fields)

  it('keeps kept words in place and puts new words after the group', () => {
    const result = edit({ words: ['milk', 'skim'] })
    expect(result.ok && Object.keys(result.items)).toEqual(['milk', 'bread', 'skim', 'two milks'])
  })

  it('removes words dropped from the set', () => {
    const result = edit({ words: 'milk' })
    expect(result.ok && Object.keys(result.items)).toEqual(['milk', 'bread', 'two milks'])
  })

  it('shares the listing across the group and drops it when the stockcode changes', () => {
    const kept = edit({ quantity: 5 })
    expect(kept.ok && kept.items['full cream milk']).toEqual({
      stockcode: 1,
      quantity: 5,
      listing: 'Full Cream Milk 2L',
    })
    const changed = edit({ url: '9' })
    expect(changed.ok && changed.stockcodeChanged).toBe(true)
    expect(changed.ok && changed.items.milk).toEqual({ stockcode: 9, quantity: 1 })
  })

  it('merges into another product with the same stockcode and quantity', () => {
    const result = edit({ quantity: 2 })
    expect(result.ok && result.group.words).toEqual(['milk', 'full cream milk', 'two milks'])
  })

  it('rejects a word used by another product', () => {
    expect(edit({ words: ['bread'] })).toMatchObject({ ok: false, status: 409 })
  })

  it('rejects an empty word set and unknown products', () => {
    expect(edit({ words: [] })).toMatchObject({ ok: false, status: 400 })
    expect(applyGroupEdit(items, 7, 1, {})).toMatchObject({ ok: false, status: 404 })
  })
})

describe('removeGroup', () => {
  it('removes every word of the product', () => {
    expect(Object.keys(removeGroup(items, 1, 1) ?? {})).toEqual(['bread', 'two milks'])
  })

  it('is undefined for an unknown product', () => {
    expect(removeGroup(items, 7, 7)).toBeUndefined()
  })
})
