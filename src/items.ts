import { readFile, rename, writeFile } from 'node:fs/promises'
import { parse, stringify } from 'yaml'

export interface ItemMapping {
  stockcode: number
  quantity: number
  /** The product's title on woolworths.com.au, looked up by the server. */
  listing?: string
}

export type ItemsConfig = Record<string, ItemMapping>

export async function loadItems(path: string): Promise<ItemsConfig> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    // A fresh deployment has no mappings until the first one is added.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    throw error
  }
  const parsed = (parse(raw) as Record<string, ItemMapping & Record<string, unknown>> | null) ?? {}
  return Object.fromEntries(
    Object.entries(parsed).map(([word, { stockcode, quantity, listing }]) => [
      word,
      { stockcode, quantity, ...(listing ? { listing } : {}) },
    ]),
  )
}

export async function saveItems(path: string, items: ItemsConfig): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, stringify(items), 'utf8')
  await rename(temporary, path)
}

export function resolveItem(items: ItemsConfig, spokenTerm: string): ItemMapping | undefined {
  return items[normalizeWord(spokenTerm)]
}

export function normalizeWord(term: string): string {
  return term.trim().toLowerCase()
}
