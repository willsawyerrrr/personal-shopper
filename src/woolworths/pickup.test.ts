import { describe, expect, it, vi } from 'vitest'
import {
  InvalidPickupLinkError,
  PickupClient,
  PickupUpstreamError,
  isPickupLink,
  isShortPickupLink,
} from './pickup.ts'

const TOKEN = '11111111-2222-3333-4444-555555555555'
const LINK = `https://myorder.woolworths.com.au/pickup/order?token=${TOKEN}`
const SHORT = 'https://w.wowpu.com.au/48neum1'
const JWT = `x.${Buffer.from(JSON.stringify({ orderNo: '123456789', scope: 'pickup' })).toString('base64url')}.y`
const ORDER_URL =
  'https://prod-apix.woolworths.com.au/handover/portal/v1/wow/customer/orders/123456789'

const status = (statusTitle: string) => ({
  orderId: { value: '123456789', organisation: 'wow' },
  statusTitle,
  statusDescription: 'Head to the pickup area',
  collectionMethod: 'DriveUp',
  collectionDateAndWindow: {},
  actions: [],
  alerts: [],
})
const json = (body: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(body), { status: 200, ...init })

function setup(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>()
  fetchMock.mockResolvedValueOnce(json({ accessToken: JWT }))
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response)
  }
  return { fetchMock, client: new PickupClient(fetchMock) }
}
const call = (fetchMock: ReturnType<typeof setup>['fetchMock'], index: number) => {
  const [url, init] = fetchMock.mock.calls[index]!
  return {
    url,
    headers: init!.headers as Record<string, string>,
    body: JSON.parse(init!.body as string) as unknown,
  }
}

describe('isPickupLink', () => {
  it('accepts the link from the ready-order message', () => {
    expect(isPickupLink(LINK)).toBe(true)
  })

  it.each([
    'not a url',
    `http://myorder.woolworths.com.au/pickup/order?token=${TOKEN}`,
    `https://evil.example/pickup/order?token=${TOKEN}`,
    `https://myorder.woolworths.com.au.evil.example/pickup/order?token=${TOKEN}`,
    `https://user@myorder.woolworths.com.au/pickup/order?token=${TOKEN}`,
    `https://myorder.woolworths.com.au:8443/pickup/order?token=${TOKEN}`,
    `https://myorder.woolworths.com.au/other?token=${TOKEN}`,
    'https://myorder.woolworths.com.au/pickup/order',
    'https://myorder.woolworths.com.au/pickup/order?token=not-a-uuid',
  ])('rejects %s', (link) => {
    expect(isPickupLink(link)).toBe(false)
  })
})

describe('PickupClient', () => {
  it('verifies the link, then consents and sends the location when en route', async () => {
    const { fetchMock, client } = setup(json({}), json(status("We're on our way")))
    const result = await client.enRoute(LINK, -33.8688, 151.2093)

    expect(result).toEqual({
      statusTitle: "We're on our way",
      statusDescription: 'Head to the pickup area',
      collectionMethod: 'DriveUp',
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const verify = call(fetchMock, 0)
    expect(verify.url).toBe(
      'https://prod-apix.woolworths.com.au/signed-link-provider/SignedLink/Verify',
    )
    expect(verify.body).toEqual({ link: LINK })
    expect(verify.headers).toMatchObject({
      Origin: 'https://myorder.woolworths.com.au',
      Referer: 'https://myorder.woolworths.com.au/',
    })
    expect(verify.headers).not.toHaveProperty('Authorization')
    expect(call(fetchMock, 1)).toMatchObject({
      url: `${ORDER_URL}/featureStatus`,
      body: { featureName: 'AutoCheckIn', hasCustomerConsented: true },
      headers: { Authorization: `Bearer ${JWT}` },
    })
    expect(call(fetchMock, 2)).toMatchObject({
      url: `${ORDER_URL}/enroute`,
      body: { geoLocation: { latitude: '-33.8688', longitude: '151.2093' } },
      headers: { Authorization: `Bearer ${JWT}` },
    })
  })

  it('checks in at a drive bay when arrived', async () => {
    const { fetchMock, client } = setup(json(status('Preparing for arrival')))
    const result = await client.arrived(LINK)

    expect(result.statusTitle).toBe('Preparing for arrival')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(call(fetchMock, 1)).toMatchObject({
      url: `${ORDER_URL}/Checkin/atdrivebay`,
      body: { bayNumber: { informationAvailable: false, value: '0' } },
    })
  })

  it('never calls Woolworths for a link that is not a pickup link', async () => {
    const { fetchMock, client } = setup()
    await expect(client.arrived('https://evil.example/pickup/order')).rejects.toBeInstanceOf(
      InvalidPickupLinkError,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a link Woolworths refuses to verify', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 401 }))
    await expect(new PickupClient(fetchMock).arrived(LINK)).rejects.toBeInstanceOf(
      InvalidPickupLinkError,
    )
  })

  it.each([
    ['no access token', json({})],
    ['a token without an order number', json({ accessToken: 'x.e30.y' })],
    ['a verify failure', new Response('', { status: 500 })],
    ['an unreadable verify response', new Response('<html>')],
  ])('answers %s as an upstream failure', async (_name, response) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
    await expect(new PickupClient(fetchMock).arrived(LINK)).rejects.toBeInstanceOf(
      PickupUpstreamError,
    )
  })

  it('answers a failed pickup call as an upstream failure without leaking its body', async () => {
    const { client } = setup(new Response('secret detail', { status: 403 }))
    const error = await client.arrived(LINK).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PickupUpstreamError)
    expect((error as Error).message).not.toContain('secret')
  })

  it('answers a network failure as an upstream failure', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error(`down ${LINK}`))
    const error = await new PickupClient(fetchMock).arrived(LINK).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PickupUpstreamError)
    expect((error as Error).message).not.toContain(TOKEN)
  })
})

describe('isShortPickupLink', () => {
  it('accepts the short link from the ready-order message', () => {
    expect(isShortPickupLink(SHORT)).toBe(true)
  })

  it.each([
    'http://w.wowpu.com.au/48neum1',
    'https://wowpu.com.au/48neum1',
    'https://w.wowpu.com.au.evil.example/48neum1',
    'https://user@w.wowpu.com.au/48neum1',
    'https://w.wowpu.com.au:8443/48neum1',
    'https://w.wowpu.com.au/48neum1?x=1',
    'https://w.wowpu.com.au/48neum1#x',
    'https://w.wowpu.com.au/',
    'https://w.wowpu.com.au/ab',
    'https://w.wowpu.com.au/a/b',
    'https://w.wowpu.com.au/48-neum1',
  ])('rejects %s', (link) => {
    expect(isShortPickupLink(link)).toBe(false)
  })
})

describe('PickupClient with a short link', () => {
  const redirect = (location: string | null, status = 301) =>
    new Response(null, { status, headers: location ? { location } : {} })

  it('resolves the short link once, then verifies the long link', async () => {
    const { fetchMock, client } = setup(json(status('Arrived')))
    fetchMock.mockReset()
    fetchMock
      .mockResolvedValueOnce(redirect(LINK))
      .mockResolvedValueOnce(json({ accessToken: JWT }))
      .mockResolvedValueOnce(json(status('Arrived')))
    await client.arrived(SHORT)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe(SHORT)
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit' })
    expect(init!.headers).not.toHaveProperty('Cookie')
    expect(init!.signal).toBeInstanceOf(AbortSignal)
    expect(call(fetchMock, 1).body).toEqual({ link: LINK })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('resolves a relative Location against the short link', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(redirect('/elsewhere'))
    await expect(new PickupClient(fetchMock).arrived(SHORT)).rejects.toBeInstanceOf(
      InvalidPickupLinkError,
    )
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    'https://w.wowpu.com.au:8443/48neum1?x=1',
    'https://w.wowpu.com.au/ab',
    'http://w.wowpu.com.au/48neum1',
    'https://w.wowpu.com.au.evil.example/48neum1',
    'https://w.wowpu.com.au:8443/48neum1',
    'https://user@w.wowpu.com.au/48neum1',
  ])('rejects %s without any request', async (link) => {
    const fetchMock = vi.fn<typeof fetch>()
    await expect(new PickupClient(fetchMock).arrived(link)).rejects.toBeInstanceOf(
      InvalidPickupLinkError,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['a 200 response', new Response('<html>', { status: 200 })],
    ['a redirect to another host', redirect(`https://evil.example/pickup/order?token=${TOKEN}`)],
    [
      'a redirect to http',
      redirect(`http://myorder.woolworths.com.au/pickup/order?token=${TOKEN}`),
    ],
    ['a redirect without a Location', redirect(null)],
    [
      'a redirect to a bad token',
      redirect('https://myorder.woolworths.com.au/pickup/order?token=x'),
    ],
  ])('rejects %s without following or verifying', async (_name, response) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
    const error = await new PickupClient(fetchMock).arrived(SHORT).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(InvalidPickupLinkError)
    expect((error as Error).message).not.toContain('48neum1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a network error', new TypeError('fetch failed')],
    ['a timeout', new DOMException('timed out', 'TimeoutError')],
  ])('answers %s as an upstream failure', async (_name, failure) => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(failure)
    const error = await new PickupClient(fetchMock).arrived(SHORT).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PickupUpstreamError)
    expect((error as Error).message).not.toContain('48neum1')
  })
})
