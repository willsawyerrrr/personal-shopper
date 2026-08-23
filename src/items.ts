import { readFile } from 'node:fs/promises'
import { parse } from 'yaml'

export interface ItemMapping {
  stockcode: number
  quantity: number
}

export type ItemsConfig = Record<string, ItemMapping>

export async function loadItems(path: string): Promise<ItemsConfig> {
  const raw = await readFile(path, 'utf8')
  return parse(raw) as ItemsConfig
}

export function resolveItem(items: ItemsConfig, spokenTerm: string): ItemMapping | undefined {
  return items[normalize(spokenTerm)]
}

function normalize(term: string): string {
  return term.trim().toLowerCase()
}
