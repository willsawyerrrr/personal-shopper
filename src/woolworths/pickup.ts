const API_URL = 'https://prod-apix.woolworths.com.au'
const PORTAL_ORIGIN = 'https://myorder.woolworths.com.au'
const PICKUP_PATH = '/pickup/order'
const TIMEOUT_MS = 10_000
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The parts of Woolworths' order status that callers see. */
export interface PickupStatus {
  statusTitle: string
  statusDescription: string
  collectionMethod: string
}

export interface PickupNotifier {
  /** Tells Woolworths the customer is on their way, from the given location. */
  enRoute(link: string, latitude: number, longitude: number): Promise<PickupStatus>
  /** Tells Woolworths the customer has parked in a bay. */
  arrived(link: string): Promise<PickupStatus>
}

/** The link is not a Woolworths pickup link, or Woolworths rejected it as invalid or expired. */
export class InvalidPickupLinkError extends Error {}

/** Woolworths failed or answered a pickup call unexpectedly. */
export class PickupUpstreamError extends Error {}

/**
 * Whether `link` is the https `myorder.woolworths.com.au/pickup/order` link
 * Woolworths sends for a ready order, carrying a UUID `token`. Anything else
 * is never sent upstream.
 */
export function isPickupLink(link: string): boolean {
  let url: URL
  try {
    url = new URL(link)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    url.origin === PORTAL_ORIGIN &&
    !url.username &&
    !url.password &&
    url.pathname === PICKUP_PATH &&
    UUID.test(url.searchParams.get('token') ?? '')
  )
}

/**
 * Drives the Woolworths pickup portal. Its calls authenticate with an access
 * token that Woolworths exchanges for the SMS or email link, not with the
 * household's Woolworths session.
 */
export class PickupClient implements PickupNotifier {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async enRoute(link: string, latitude: number, longitude: number): Promise<PickupStatus> {
    const { orderUrl, token } = await this.verify(link)
    await this.post(`${orderUrl}/featureStatus`, token, {
      featureName: 'AutoCheckIn',
      hasCustomerConsented: true,
    })
    const status = await this.post(`${orderUrl}/enroute`, token, {
      geoLocation: { latitude: String(latitude), longitude: String(longitude) },
    })
    return parseStatus(status)
  }

  async arrived(link: string): Promise<PickupStatus> {
    const { orderUrl, token } = await this.verify(link)
    const status = await this.post(`${orderUrl}/Checkin/atdrivebay`, token, {
      bayNumber: { informationAvailable: false, value: '0' },
    })
    return parseStatus(status)
  }

  /** Exchanges the link for an access token and the order's API URL, taken from the token's `orderNo` claim. */
  private async verify(link: string): Promise<{ orderUrl: string; token: string }> {
    if (!isPickupLink(link)) {
      throw new InvalidPickupLinkError('not a Woolworths pickup link')
    }
    const response = await this.send(`${API_URL}/signed-link-provider/SignedLink/Verify`, { link })
    if (response.status >= 400 && response.status < 500) {
      throw new InvalidPickupLinkError('pickup link is invalid or expired')
    }
    const body = await readJson(response)
    const token = (body as { accessToken?: unknown } | null)?.accessToken
    const orderNo = typeof token === 'string' ? orderNumber(token) : undefined
    if (typeof token !== 'string' || !orderNo) {
      throw new PickupUpstreamError('Woolworths returned no usable access token')
    }
    return {
      orderUrl: `${API_URL}/handover/portal/v1/wow/customer/orders/${encodeURIComponent(orderNo)}`,
      token,
    }
  }

  private async post(url: string, token: string, body: unknown): Promise<unknown> {
    const response = await this.send(url, body, token)
    if (!response.ok) {
      throw new PickupUpstreamError(`Woolworths pickup request failed with ${response.status}`)
    }
    return readJson(response)
  }

  private async send(url: string, body: unknown, token?: string): Promise<Response> {
    try {
      return await this.fetchImpl(url, {
        method: 'POST',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          Origin: PORTAL_ORIGIN,
          Referer: `${PORTAL_ORIGIN}/`,
          'User-Agent': USER_AGENT,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      })
    } catch {
      throw new PickupUpstreamError('Woolworths pickup request failed')
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new PickupUpstreamError('Woolworths returned an unreadable response')
  }
}

/** The `orderNo` claim of a JWT; its signature is Woolworths' to check, not ours. */
function orderNumber(token: string): string | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString())
    const orderNo = (claims as { orderNo?: unknown } | null)?.orderNo
    return typeof orderNo === 'string' || typeof orderNo === 'number' ? String(orderNo) : undefined
  } catch {
    return undefined
  }
}

function parseStatus(response: unknown): PickupStatus {
  const status = (response ?? {}) as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value : '')
  return {
    statusTitle: text(status.statusTitle),
    statusDescription: text(status.statusDescription),
    collectionMethod: text(status.collectionMethod),
  }
}
