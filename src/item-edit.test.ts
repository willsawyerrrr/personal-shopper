import { describe, expect, it } from 'vitest'
import type { ItemsConfig } from './items.ts'
import { applyEdit, parseName } from './item-edit.ts'

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
