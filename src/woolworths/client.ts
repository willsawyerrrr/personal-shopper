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

export class WoolworthsClient implements CartClient {
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

  private async request(path: string, body: unknown): Promise<unknown> {
    const session = await this.sessions.load()
    if (this.sessions.isExpired(session)) {
      throw new Error('Woolworths session expired — run `pnpm capture-session` to refresh it')
    }
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: this.sessions.toCookieHeader(session),
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      throw new Error(
        `Woolworths request to ${path} failed: ${response.status} ${response.statusText}`,
      )
    }
    return response.json()
  }
}

// Field names below come from community reverse-engineering of Woolworths'
// unofficial API, not official docs — verify against a live response with
// `pnpm search-product` before relying on them.
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
