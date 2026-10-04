import { describe, expect, it } from 'vitest'
import type { ItemsConfig } from './items.ts'
import {
  applyGroupEdit,
  displayCase,
  groupItems,
  groupSubtitle,
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

describe('groupItems names', () => {
  it('takes the name from the first word that has one', () => {
    const grouped = groupItems({
      a: { stockcode: 1, quantity: 1 },
      b: { stockcode: 1, quantity: 1, name: 'Mine' },
      c: { stockcode: 1, quantity: 1, name: 'Other' },
    })
    expect(grouped[0]?.name).toBe('Mine')
  })
})

describe('groupTitle', () => {
  it('is the name, else the listing, else the first word display-cased', () => {
    const [milk, bread] = groupItems(items)
    expect(groupTitle(milk!)).toBe('Full Cream Milk 2L')
    expect(groupTitle(bread!)).toBe('Bread')
    expect(groupTitle({ ...milk!, name: 'Milk' })).toBe('Milk')
    expect(groupTitle({ ...bread!, name: 'Loaf' })).toBe('Loaf')
  })
})

describe('groupSubtitle', () => {
  it('is the listing only when a name replaces it as the title', () => {
    const [milk, bread] = groupItems(items)
    expect(groupSubtitle(milk!)).toBeUndefined()
    expect(groupSubtitle({ ...milk!, name: 'Milk' })).toBe('Full Cream Milk 2L')
    expect(groupSubtitle({ ...bread!, name: 'Loaf' })).toBeUndefined()
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

  it('sets, keeps and clears the name across every word', () => {
    const named = edit({ name: '  Milk  ', words: ['milk', 'skim'] })
    expect(named.ok && named.items.milk?.name).toBe('Milk')
    expect(named.ok && named.items.skim?.name).toBe('Milk')
    expect(named.ok && named.group.name).toBe('Milk')
    const kept = applyGroupEdit(named.ok ? named.items : {}, 1, 1, { words: ['milk', 'oat'] })
    expect(kept.ok && kept.items.oat?.name).toBe('Milk')
    const cleared = applyGroupEdit(named.ok ? named.items : {}, 1, 1, { name: ' ' })
    expect(cleared.ok && cleared.items.milk).not.toHaveProperty('name')
    expect(cleared.ok && cleared.group.name).toBeUndefined()
  })

  it('rejects a name that is too long or not text', () => {
    expect(edit({ name: 'x'.repeat(81) })).toMatchObject({ ok: false, status: 400 })
    expect(edit({ name: 5 })).toMatchObject({ ok: false, status: 400 })
    expect(edit({ name: 'x'.repeat(80) }).ok).toBe(true)
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
