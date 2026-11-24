import type { FastifyRequest } from 'fastify'
import type { CartStore } from './cart-store.ts'
import { itemTitle, type Item, type ItemCandidate } from './items.ts'
import type { CartClient, PriceLookup, TrolleyLookup } from './woolworths/client.ts'
import { SessionRejectedError } from './woolworths/session.ts'

/** A candidate together with its looked-up price, when known. */
interface PricedCandidate extends ItemCandidate {
  price?: number | undefined
}

// At least one candidate: every item that can be checked out has at least one.
type Candidates<T extends ItemCandidate> = readonly [T, ...T[]]

/**
 * The cheapest-per-unit candidate among those with a known price, or the
 * first (in the item's stored order) when none do, so pricing trouble never
 * blocks a checkout.
 */
export function pickCheapest(candidates: Candidates<PricedCandidate>): ItemCandidate {
  let best: PricedCandidate | undefined
  for (const candidate of candidates) {
    if (candidate.price === undefined) {
      continue
    }
    const unitPrice = candidate.price / candidate.quantity
    if (!best || unitPrice < (best.price as number) / best.quantity) {
      best = candidate
    }
  }
  return best ?? candidates[0]
}

/** An item that reached the Woolworths cart, with the product and total quantity added. */
export interface CheckedOutLine {
  id: string
  title: string
  stockcode: number
  quantity: number
}

/** An item that stayed in the Personal Shopper cart, and why. */
export interface FailedLine {
  id: string
  title: string
  error: string
}

/** An item left out of checkout because one of its candidates, `stockcode`, is already in the Woolworths cart. */
export interface SkippedLine {
  id: string
  title: string
  stockcode: number
}

export interface CheckoutResult {
  added: CheckedOutLine[]
  failed: FailedLine[]
  skipped: SkippedLine[]
}

/** The Woolworths cart could not be read, so nothing was checked out. */
export class TrolleyUnreadableError extends Error {
  constructor(cause: unknown) {
    super('Could not read your Woolworths cart, so nothing was added.', { cause })
  }
}

// The item's only candidate without looking up a price, so an item with a single candidate never
// pays for one. A candidate whose price lookup fails is logged and treated as unknown, except a
// rejected session, which fails the whole checkout.
async function chooseCandidate(
  candidates: Candidates<ItemCandidate>,
  client: Partial<PriceLookup>,
  log: Pick<FastifyRequest['log'], 'warn'>,
): Promise<ItemCandidate> {
  if (candidates.length === 1) {
    return candidates[0]
  }
  const [priced0, ...pricedRest] = await Promise.all(
    candidates.map(async (candidate): Promise<PricedCandidate> => {
      try {
        return { ...candidate, price: await client.price?.(candidate.stockcode) }
      } catch (error) {
        if (error instanceof SessionRejectedError) {
          throw error
        }
        log.warn({ stockcode: candidate.stockcode, error }, 'price lookup failed')
        return candidate
      }
    }),
  )
  return pickCheapest([priced0 as PricedCandidate, ...pricedRest])
}

/**
 * Sends the user's household's cart to the Woolworths cart: for each entry the
 * cheapest candidate at current prices, `count` times its quantity. The
 * Woolworths cart is read once first; an entry any of whose candidates is
 * already in it, in any quantity, is satisfied: it is not added, leaves the
 * cart and is listed in `skipped`. Entries that landed leave the cart; the
 * rest stay, listed in `failed`. A cart that cannot be read is thrown as
 * `TrolleyUnreadableError` (`SessionRejectedError` when the session is
 * rejected), changing nothing. A rejected
 * Woolworths session is thrown as `SessionRejectedError` after removing the
 * entries that had already landed. Never places an order.
 */
export async function checkout(
  email: string,
  items: Item[],
  cart: CartStore,
  client: CartClient & TrolleyLookup & Partial<PriceLookup>,
  log: Pick<FastifyRequest['log'], 'warn' | 'info'>,
): Promise<CheckoutResult> {
  const byId = new Map(items.map((item) => [item.id, item]))
  const entries = await cart.list(email)
  const result: CheckoutResult = { added: [], failed: [], skipped: [] }
  if (entries.length === 0) {
    return result
  }
  let trolley: Map<number, number>
  try {
    trolley = await client.trolley()
  } catch (error) {
    throw error instanceof SessionRejectedError ? error : new TrolleyUnreadableError(error)
  }
  for (const { itemId, count } of entries) {
    const item = byId.get(itemId)
    if (!item) {
      continue
    }
    const id = item.id
    const title = itemTitle(item)
    const [first, ...rest] = item.candidates
    if (!first) {
      result.failed.push({ id, title, error: 'This item has no products.' })
      continue
    }
    const present = item.candidates.find((candidate) => trolley.has(candidate.stockcode))
    if (present) {
      await cart.remove(email, id, count)
      result.skipped.push({ id, title, stockcode: present.stockcode })
      continue
    }
    let line: CheckedOutLine
    try {
      const chosen = await chooseCandidate([first, ...rest], client, log)
      const quantity = chosen.quantity * count
      await client.addToCart(chosen.stockcode, quantity)
      line = { id, title, stockcode: chosen.stockcode, quantity }
    } catch (error) {
      if (error instanceof SessionRejectedError) {
        throw error
      }
      log.warn({ itemId: id, error }, 'checkout of item failed')
      result.failed.push({ id, title, error: 'Woolworths did not accept this item.' })
      continue
    }
    await cart.remove(email, id, count)
    result.added.push(line)
  }
  log.info(
    { added: result.added.length, failed: result.failed.length, skipped: result.skipped.length },
    'checked out',
  )
  return result
}
