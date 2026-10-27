import { describe, expect, it, vi } from 'vitest'
import {
  InvalidPickupLinkError,
  PickupClient,
  PickupUpstreamError,
  isPickupLink,
} from './pickup.ts'

const TOKEN = '11111111-2222-3333-4444-555555555555'
const LINK = `https://myorder.woolworths.com.au/pickup/order?token=${TOKEN}`
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
