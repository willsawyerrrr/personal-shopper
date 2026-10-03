import type { FastifyBaseLogger } from 'fastify'
import { loadItems, saveItems } from './items.ts'
import type { ProductLookup } from './woolworths/client.ts'

type Logger = Pick<FastifyBaseLogger, 'warn'>

/** Looks up a product's listing text; a failed lookup is logged and yields `undefined`. */
export async function lookupListing(
  lookup: ProductLookup | undefined,
  stockcode: number,
  log: Logger,
): Promise<string | undefined> {
  try {
    return await lookup?.listing(stockcode)
  } catch (error) {
    log.warn({ err: error, stockcode }, 'listing lookup failed')
    return undefined
  }
}

/**
 * Returns a function that fills in the listing of every item lacking one, in the background.
 * Calls while a run is in progress are ignored. Items edited meanwhile are left as the edit
 * made them, and lookup failures are logged and retried by the next trigger.
 */
export function createListingBackfill(
  itemsPath: string,
  lookup: ProductLookup | undefined,
  log: Logger,
): () => Promise<void> {
  let running: Promise<void> | undefined
  const run = async (): Promise<void> => {
    const missing = Object.entries(await loadItems(itemsPath)).filter(
      ([, mapping]) => !mapping.listing,
    )
    for (const [word, { stockcode }] of missing) {
      const listing = await lookupListing(lookup, stockcode, log)
      if (!listing) {
        continue
      }
      const items = await loadItems(itemsPath)
      const current = items[word]
      if (current && current.stockcode === stockcode && !current.listing) {
        current.listing = listing
        await saveItems(itemsPath, items)
      }
    }
  }
  return () => {
    if (!lookup) {
      return Promise.resolve()
    }
    running ??= run()
      .catch((error: unknown) => log.warn({ err: error }, 'listing backfill failed'))
      .finally(() => {
        running = undefined
      })
    return running
  }
}
