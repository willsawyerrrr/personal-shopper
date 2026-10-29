import { describe, expect, it } from 'vitest'
import type { ItemsConfig } from './items.ts'
import { applyEdit, parseCandidates, parseName } from './item-edit.ts'

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

describe('applyEdit alternatives', () => {
  const items: ItemsConfig = {
    bars: { stockcode: 1, quantity: 1, alternatives: [{ stockcode: 2, quantity: 4 }] },
  }

  it('replaces the alternatives wholesale', () => {
    const result = applyEdit(items, 'bars', { alternatives: [{ stockcode: 3, quantity: 6 }] })
    expect(result.ok && result.items.bars?.alternatives).toEqual([{ stockcode: 3, quantity: 6 }])
  })

  it('clears them with an empty array', () => {
    const result = applyEdit(items, 'bars', { alternatives: [] })
    expect(result.ok && result.items.bars).not.toHaveProperty('alternatives')
  })

  it('keeps them when alternatives is absent', () => {
    const result = applyEdit(items, 'bars', { quantity: 2 })
    expect(result.ok && result.items.bars?.alternatives).toEqual([{ stockcode: 2, quantity: 4 }])
  })

  it('rejects an invalid entry', () => {
    expect(applyEdit(items, 'bars', { alternatives: [{ quantity: 4 }] })).toMatchObject({
      ok: false,
      status: 400,
    })
  })
})

describe('applyEdit name', () => {
  const items: ItemsConfig = {
    milk: { stockcode: 1, quantity: 1, name: 'Old' },
    skim: { stockcode: 1, quantity: 1, name: 'Old' },
    bread: { stockcode: 2, quantity: 1 },
  }

  it('sets the name on every word of the product', () => {
    const result = applyEdit(items, 'milk', { name: ' New ' })
    expect(result.ok && result.items.milk?.name).toBe('New')
    expect(result.ok && result.items.skim?.name).toBe('New')
    expect(result.ok && result.items.bread).not.toHaveProperty('name')
  })

  it('clears it with a blank name and keeps it when absent', () => {
    const cleared = applyEdit(items, 'milk', { name: '' })
    expect(cleared.ok && cleared.items.skim).not.toHaveProperty('name')
    const kept = applyEdit(items, 'milk', { quantity: 2 })
    expect(kept.ok && kept.items.milk?.name).toBe('Old')
  })

  it('rejects an invalid name', () => {
    expect(applyEdit(items, 'milk', { name: 'x'.repeat(81) })).toMatchObject({
      ok: false,
      status: 400,
    })
  })
})
