import type { SessionStore } from './session.ts'

const BASE_URL = 'https://www.woolworths.com.au'

export interface SearchResultProduct {
  stockcode: number
  name: string
  price: number
  isAvailable: boolean
}

export interface CartClient {
  addToCart(stockcode: number, quantity: number): Promise<void>
}

export interface ProductLookup {
  /** The product's title as listed on woolworths.com.au, or `undefined` when there is none. */
  listing(stockcode: number): Promise<string | undefined>
}

const LOOKUP_TIMEOUT_MS = 10_000

export class WoolworthsClient implements CartClient, ProductLookup {
  constructor(private readonly sessions: SessionStore) {}

  async search(term: string): Promise<SearchResultProduct[]> {
    const response = await this.request('/apis/ui/Search/products', {
      searchTerm: term,
      pageNumber: 1,
      pageSize: 36,
      sortType: 'TraderRelevance',
      filters: '',
      location: `/shop/search/products?searchTerm=${encodeURIComponent(term)}`,
    })
    return parseSearchResponse(response)
  }

  // `GET /apis/ui/product/detail/<stockcode>` is read-only and works with the
  // session cookies (verified 2026-10); `Product.DisplayName` is the title the
  // product page shows, e.g. `Maleny Dairies Full Cream 2L`.
  async listing(stockcode: number): Promise<string | undefined> {
    const response = await this.request(`/apis/ui/product/detail/${stockcode}`)
    return parseListing(response)
  }

  async addToCart(stockcode: number, quantity: number): Promise<void> {
    await this.request('/api/v3/ui/trolley/update', {
      items: [
        {
          stockcode,
          quantity,
          source: 'personal-shopper',
          diagnostics: null,
          searchTerm: null,
          evaluateRewardPoints: true,
          offerId: null,
          profileId: null,
          priceLevel: null,
        },
      ],
    })
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    let session = await this.sessions.load()
    if (this.sessions.isExpired(session)) {
      session = await this.sessions.refresh(session)
    }
    const response = await fetch(`${BASE_URL}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      headers: {
        Accept: 'application/json, text/plain, */*',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Origin: BASE_URL,
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Cookie: this.sessions.toCookieHeader(session),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(
        `Woolworths request to ${path} failed: ${response.status} ${response.statusText} ${errorBody}`,
      )
    }
    return response.json()
  }
}

function parseListing(response: unknown): string | undefined {
  const product = (response as { Product?: Record<string, unknown> | null } | null)?.Product
  const title = product?.DisplayName ?? product?.Name
  return typeof title === 'string' && title.trim() ? title.trim() : undefined
}

// `POST /apis/ui/Search/products` returns a generic 400 against a real
// authenticated session as of 2026-08 — confirmed broken or deprecated, not
// a payload-shape issue (adding the extra community-documented fields
// `formatObject`/`isSpecial`/`isBundle`/`isMobile`/`groupEdmVariants` didn't
// change the result). `addToCart` is unaffected and confirmed working
// against a live cart. Until a working search endpoint is found, look up
// stockcodes by hand from a product's URL
// (`/shop/productdetails/<stockcode>/...`) instead of `pnpm search-product`.
// Field names below are still best-effort from community docs, unverified
// against a real response.
function parseSearchResponse(response: unknown): SearchResultProduct[] {
  const products = (response as { Products?: unknown[] }).Products ?? []
  return products.map((entry) => {
    const product = entry as Record<string, unknown>
    const price = product.Price as Record<string, unknown> | number | undefined
    return {
      stockcode: Number(product.Stockcode),
      name: String(product.Name ?? product.DisplayName ?? ''),
      price: Number(typeof price === 'object' ? (price?.Value ?? 0) : (price ?? 0)),
      isAvailable: Boolean(product.IsAvailable ?? true),
    }
  })
}
