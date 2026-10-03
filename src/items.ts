import { readFile, writeFile } from 'node:fs/promises'
import { parse, stringify } from 'yaml'

export interface ItemMapping {
  stockcode: number
  quantity: number
  name?: string
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
  return (parse(raw) as ItemsConfig) ?? {}
}

export async function saveItems(path: string, items: ItemsConfig): Promise<void> {
  await writeFile(path, stringify(items), 'utf8')
}

export function resolveItem(items: ItemsConfig, spokenTerm: string): ItemMapping | undefined {
  return items[normalizeWord(spokenTerm)]
}

export function normalizeWord(term: string): string {
  return term.trim().toLowerCase()
}
