import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WoolworthsClient } from './client.ts'
import type { SessionStore, StoredSession } from './session.ts'

function fakeSessionStore(overrides: Partial<SessionStore> = {}): SessionStore {
  const session: StoredSession = {
    cookies: [{ name: 'wow-auth-token', value: 'abc' }],
    capturedAt: new Date().toISOString(),
  }
  return {
    load: vi.fn().mockResolvedValue(session),
    save: vi.fn(),
    refresh: vi.fn(),
    isExpired: vi.fn().mockReturnValue(false),
    toCookieHeader: vi.fn().mockReturnValue('wow-auth-token=abc'),
    ...overrides,
  } as unknown as SessionStore
}

describe('WoolworthsClient', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    global.fetch = vi.fn()
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  it('posts the trolley update payload with the session cookie header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    global.fetch = fetchMock
    const client = new WoolworthsClient(fakeSessionStore())

    await client.addToCart(123456, 2)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://www.woolworths.com.au/api/v3/ui/trolley/update',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Cookie: 'wow-auth-token=abc' }),
      }),
    )
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(init.body as string)
    expect(body.items[0]).toMatchObject({ stockcode: 123456, quantity: 2 })
  })

  it('refreshes an expiring session and uses the refreshed cookies', async () => {
    const refreshed: StoredSession = {
      cookies: [{ name: 'wow-auth-token', value: 'new' }],
      capturedAt: new Date().toISOString(),
    }
    const sessions = fakeSessionStore({
      isExpired: vi.fn().mockReturnValue(true),
      refresh: vi.fn().mockResolvedValue(refreshed),
      toCookieHeader: vi.fn().mockReturnValue('wow-auth-token=new'),
    })
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }))
    global.fetch = fetchMock

    await new WoolworthsClient(sessions).addToCart(1, 1)

    expect(sessions.toCookieHeader).toHaveBeenCalledWith(refreshed)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails without calling Woolworths when the refresh is rejected', async () => {
    const sessions = fakeSessionStore({
      isExpired: vi.fn().mockReturnValue(true),
      refresh: vi.fn().mockRejectedValue(new Error('Woolworths session expired')),
    })
    const fetchMock = vi.fn()
    global.fetch = fetchMock

    await expect(new WoolworthsClient(sessions).addToCart(1, 1)).rejects.toThrow('session expired')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('parses search results from the Products array', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          Products: [{ Stockcode: 1, Name: 'Milk 2L', Price: { Value: 3.5 }, IsAvailable: true }],
        }),
        { status: 200 },
      ),
    )
    const client = new WoolworthsClient(fakeSessionStore())

    await expect(client.search('milk')).resolves.toEqual([
      { stockcode: 1, name: 'Milk 2L', price: 3.5, isAvailable: true },
    ])
  })

  it('throws when the API responds with an error status', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response('', { status: 500 }))
    const client = new WoolworthsClient(fakeSessionStore())
    await expect(client.addToCart(1, 1)).rejects.toThrow(/failed: 500/)
  })

  describe('listing', () => {
    const respond = (body: unknown, status = 200) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))
      global.fetch = fetchMock
      return fetchMock
    }

    it('reads the product title with a GET carrying the session cookie', async () => {
      const fetchMock = respond({
        Product: { Name: 'Maleny Dairies', DisplayName: ' Maleny Dairies Full Cream 2L ' },
      })
      const listing = await new WoolworthsClient(fakeSessionStore()).listing(248608)
      expect(listing).toBe('Maleny Dairies Full Cream 2L')
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toBe('https://www.woolworths.com.au/apis/ui/product/detail/248608')
      expect(init.method).toBe('GET')
      expect(init.body).toBeUndefined()
      expect(init.headers).toMatchObject({ Cookie: 'wow-auth-token=abc' })
    })

    it('falls back to the product name', async () => {
      respond({ Product: { Name: 'Milk' } })
      await expect(new WoolworthsClient(fakeSessionStore()).listing(1)).resolves.toBe('Milk')
    })

    it('returns undefined when the product has no title', async () => {
      respond({ Product: null })
      await expect(new WoolworthsClient(fakeSessionStore()).listing(1)).resolves.toBeUndefined()
    })

    it('throws when Woolworths rejects the request', async () => {
      respond({}, 403)
      await expect(new WoolworthsClient(fakeSessionStore()).listing(1)).rejects.toThrow('403')
    })
  })

  describe('price', () => {
    const respond = (body: unknown, status = 200) => {
      global.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }))
    }

    it('reads a numeric Price', async () => {
      respond({ Product: { Price: 4.5, IsAvailable: true } })
      await expect(new WoolworthsClient(fakeSessionStore()).price(1)).resolves.toBe(4.5)
    })

    it('reads a Price.Value', async () => {
      respond({ Product: { Price: { Value: 4.5 }, IsAvailable: true } })
      await expect(new WoolworthsClient(fakeSessionStore()).price(1)).resolves.toBe(4.5)
    })

    it('returns undefined when the product is unavailable', async () => {
      respond({ Product: { Price: 4.5, IsAvailable: false } })
      await expect(new WoolworthsClient(fakeSessionStore()).price(1)).resolves.toBeUndefined()
    })

    it('returns undefined when there is no parsable price', async () => {
      respond({ Product: { IsAvailable: true } })
      await expect(new WoolworthsClient(fakeSessionStore()).price(1)).resolves.toBeUndefined()
    })

    it('returns undefined when there is no product', async () => {
      respond({ Product: null })
      await expect(new WoolworthsClient(fakeSessionStore()).price(1)).resolves.toBeUndefined()
    })

    it('throws when Woolworths rejects the request', async () => {
      respond({}, 403)
      await expect(new WoolworthsClient(fakeSessionStore()).price(1)).rejects.toThrow('403')
    })
  })
})
