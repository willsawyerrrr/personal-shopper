import { describe, expect, it } from 'vitest'
import type { ItemsConfig } from './items.ts'
import { applyEdit, parseCandidates, parseName, parseWords } from './item-edit.ts'

describe('parseName', () => {
  it('trims, and treats blank or missing as no name', () => {
    expect(parseName('  Milk ')).toEqual({ ok: true, name: 'Milk' })
    expect(parseName('   ')).toEqual({ ok: true })
    expect(parseName('')).toEqual({ ok: true })
    expect(parseName(null)).toEqual({ ok: true })
    expect(parseName(undefined)).toEqual({ ok: true })
  })

  it('allows 80 characters and rejects more', () => {
    expect(parseName('x'.repeat(80))).toMatchObject({ ok: true })
    expect(parseName('x'.repeat(81))).toMatchObject({ ok: false })
    expect(parseName('😀'.repeat(80))).toMatchObject({ ok: true })
  })

  it('rejects non-text', () => {
    expect(parseName(5)).toMatchObject({ ok: false })
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

describe('parseCandidates', () => {
  it('reads a stockcode and quantity, defaulting quantity to 1', () => {
    expect(parseCandidates([{ stockcode: 123456, quantity: 4 }])).toEqual({
      ok: true,
      candidates: [{ stockcode: 123456, quantity: 4 }],
    })
    expect(parseCandidates([{ stockcode: 123456 }])).toEqual({
      ok: true,
      candidates: [{ stockcode: 123456, quantity: 1 }],
    })
  })

  it('parses a stockcode from a product URL, taking precedence over stockcode', () => {
    expect(
      parseCandidates([{ url: '/shop/productdetails/123456/bars', stockcode: 1, quantity: 4 }]),
    ).toEqual({ ok: true, candidates: [{ stockcode: 123456, quantity: 4 }] })
  })

  it('treats an empty array as no alternatives', () => {
    expect(parseCandidates([])).toEqual({ ok: true, candidates: [] })
  })

  it('rejects a non-array', () => {
    expect(parseCandidates('nope')).toEqual({ ok: false, error: expect.any(String) })
  })

  it('rejects an entry with no URL or stockcode', () => {
    expect(parseCandidates([{ quantity: 4 }])).toEqual({ ok: false, error: expect.any(String) })
  })
})

describe('applyEdit', () => {
  const items: ItemsConfig = [
    {
      id: 'milk',
      words: ['milk', 'full cream milk'],
      candidates: [{ stockcode: 1, quantity: 1 }],
      listing: 'Full Cream Milk 2L',
    },
    { id: 'bread', words: ['bread'], candidates: [{ stockcode: 2, quantity: 1 }] },
    { id: 'two-milks', words: ['two milks'], candidates: [{ stockcode: 1, quantity: 2 }] },
  ]

  it('rejects an unknown item', () => {
    expect(applyEdit(items, 'nope', {})).toMatchObject({ ok: false, status: 404 })
  })

  describe('words', () => {
    it('replaces the word set', () => {
      const result = applyEdit(items, 'milk', { words: ['milk', 'skim'] })
      expect(result.ok && result.item.words).toEqual(['milk', 'skim'])
    })

    it('keeps the existing words when absent', () => {
      const result = applyEdit(items, 'milk', { quantity: 5 })
      expect(result.ok && result.item.words).toEqual(['milk', 'full cream milk'])
    })

    it('rejects an empty word set', () => {
      expect(applyEdit(items, 'milk', { words: [] })).toMatchObject({ ok: false, status: 400 })
    })

    it('rejects a word used by another item', () => {
      expect(applyEdit(items, 'milk', { words: ['bread'] })).toMatchObject({
        ok: false,
        status: 409,
      })
    })
  })

  describe('url/stockcode and quantity', () => {
    it('updates the first candidate, keeping the quantity when absent', () => {
      const result = applyEdit(items, 'milk', { url: '9' })
      expect(result.ok && result.item.candidates).toEqual([{ stockcode: 9, quantity: 1 }])
      expect(result.ok && result.stockcodeChanged).toBe(true)
    })

    it('updates only the quantity when the stockcode is unchanged', () => {
      const result = applyEdit(items, 'milk', { quantity: 5 })
      expect(result.ok && result.item.candidates).toEqual([{ stockcode: 1, quantity: 5 }])
      expect(result.ok && result.stockcodeChanged).toBe(false)
    })

    it('drops the stored listing when the stockcode changes, keeps it otherwise', () => {
      const changed = applyEdit(items, 'milk', { url: '9' })
      expect(changed.ok && changed.item).not.toHaveProperty('listing')
      const kept = applyEdit(items, 'milk', { quantity: 5 })
      expect(kept.ok && kept.item.listing).toBe('Full Cream Milk 2L')
    })

    it('rejects an invalid URL, stockcode or quantity', () => {
      expect(applyEdit(items, 'milk', { url: 'nope' })).toMatchObject({ ok: false, status: 400 })
      expect(applyEdit(items, 'milk', { quantity: 'nope' })).toMatchObject({
        ok: false,
        status: 400,
      })
    })
  })

  describe('alternatives', () => {
    const withAlternatives: ItemsConfig = [
      {
        id: 'bars',
        words: ['bars'],
        candidates: [
          { stockcode: 1, quantity: 1 },
          { stockcode: 2, quantity: 4 },
        ],
      },
    ]

    it('replaces every candidate after the first wholesale', () => {
      const result = applyEdit(withAlternatives, 'bars', {
        alternatives: [{ stockcode: 3, quantity: 6 }],
      })
      expect(result.ok && result.item.candidates).toEqual([
        { stockcode: 1, quantity: 1 },
        { stockcode: 3, quantity: 6 },
      ])
    })

    it('clears them with an empty array', () => {
      const result = applyEdit(withAlternatives, 'bars', { alternatives: [] })
      expect(result.ok && result.item.candidates).toEqual([{ stockcode: 1, quantity: 1 }])
    })

    it('keeps them when alternatives is absent', () => {
      const result = applyEdit(withAlternatives, 'bars', { quantity: 2 })
      expect(result.ok && result.item.candidates).toEqual([
        { stockcode: 1, quantity: 2 },
        { stockcode: 2, quantity: 4 },
      ])
    })

    it('rejects an invalid entry', () => {
      expect(
        applyEdit(withAlternatives, 'bars', { alternatives: [{ quantity: 4 }] }),
      ).toMatchObject({ ok: false, status: 400 })
    })
  })

  describe('name', () => {
    it('sets, keeps and clears the name', () => {
      const named = applyEdit(items, 'milk', { name: ' New ' })
      expect(named.ok && named.item.name).toBe('New')
      const kept = applyEdit(items, 'milk', { quantity: 2 })
      expect(kept.ok && kept.item).not.toHaveProperty('name')
      const cleared = applyEdit(named.ok ? named.items : items, 'milk', { name: '' })
      expect(cleared.ok && cleared.item).not.toHaveProperty('name')
    })

    it('rejects an invalid name', () => {
      expect(applyEdit(items, 'milk', { name: 'x'.repeat(81) })).toMatchObject({
        ok: false,
        status: 400,
      })
    })
  })

  it('leaves every other item in place and in order', () => {
    const result = applyEdit(items, 'milk', { quantity: 5 })
    expect(result.ok && result.items.map((item) => item.id)).toEqual(['milk', 'bread', 'two-milks'])
  })
})
