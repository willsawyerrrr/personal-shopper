import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadItems, resolveItem, saveItems, type ItemsConfig } from './items.ts'

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

describe('loadItems', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('parses a YAML mapping file', async () => {
    const path = join(dir, 'items.yml')
    await writeFile(path, 'milk:\n  stockcode: 123456\n  quantity: 1\n')
    await expect(loadItems(path)).resolves.toEqual({ milk: { stockcode: 123456, quantity: 1 } })
  })

  it('treats a missing file as no items', async () => {
    await expect(loadItems(join(dir, 'missing.yml'))).resolves.toEqual({})
  })

  it('treats an empty file as no items', async () => {
    const path = join(dir, 'items.yml')
    await writeFile(path, '')
    await expect(loadItems(path)).resolves.toEqual({})
  })
})

describe('saveItems', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'personal-shopper-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('writes items back out as YAML loadItems can read', async () => {
    const path = join(dir, 'items.yml')
    const items: ItemsConfig = { milk: { stockcode: 123456, quantity: 1, name: 'Milk 2L' } }
    await saveItems(path, items)
    await expect(loadItems(path)).resolves.toEqual(items)
  })
})
