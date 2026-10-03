import { readFile } from 'node:fs/promises'
import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright'
import { REQUIRED_COOKIES, type StoredSession } from './session.ts'

const LOGIN_URL = 'https://www.woolworths.com.au/shop/securelogin'
const AUTH_HOST = 'auth.woolworths.com.au'
const LOGIN_TIMEOUT_MS = 60_000

// Akamai Bot Manager answers "Access Denied" to default headless Chrome; it
// accepts the installed Chrome channel with the automation flag hidden and a
// desktop user agent.
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'
export const BROWSER_ARGS = ['--disable-blink-features=AutomationControlled']

/** A credential as returned by CDP `WebAuthn.getCredentials`. */
export type PasskeyCredential = Record<string, unknown>

/**
 * Attaches a CDP virtual authenticator (ctap2, internal, resident key, user
 * verified) to `page` and returns its session and id.
 */
export async function addVirtualAuthenticator(
  context: BrowserContext,
  page: Page,
): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await context.newCDPSession(page)
  await cdp.send('WebAuthn.enable')
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  })
  return { cdp, authenticatorId }
}

export async function loadCredentials(path: string): Promise<PasskeyCredential[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(
      `Cannot read passkey credentials at ${path} — run \`pnpm register-passkey\` first (${(error as Error).message})`,
      { cause: error },
    )
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`Passkey credentials at ${path} must be a non-empty JSON array`)
  }
  return parsed as PasskeyCredential[]
}

/**
 * Signs in to Woolworths in a headless Chrome whose virtual authenticator
 * holds the stored passkey, and returns the resulting cookie jar (every
 * `REQUIRED_COOKIES` entry, including `w-aref`). Requires Chrome installed.
 * Throws a descriptive error if Akamai blocks the browser, the passkey is
 * rejected, or login completes without the required cookies.
 */
export async function passkeyLogin(
  credentialsPath: string,
  timeoutMs = LOGIN_TIMEOUT_MS,
): Promise<StoredSession> {
  const credentials = await loadCredentials(credentialsPath)
  const browser = await chromium.launch({
    headless: true,
    channel: 'chrome',
    args: BROWSER_ARGS,
  })
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: BROWSER_USER_AGENT,
    })
    const page = await context.newPage()
    const { cdp, authenticatorId } = await addVirtualAuthenticator(context, page)
    for (const credential of credentials) {
      await cdp.send('WebAuthn.addCredential', { authenticatorId, credential } as never)
    }

    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    await assertNotBlocked(page)
    await clickLoginUntilRedirected(page, timeoutMs)

    try {
      await page.waitForURL(/postSuccessLogin/, { timeout: timeoutMs })
    } catch (error) {
      await assertNotBlocked(page)
      throw new Error(
        new URL(page.url()).hostname === AUTH_HOST
          ? 'Woolworths passkey login was rejected — the stored credential may have been removed; run `pnpm register-passkey` again'
          : `Woolworths passkey login did not complete (stopped at ${new URL(page.url()).pathname})`,
        { cause: error },
      )
    }
    return await collectSession(context, timeoutMs)
  } finally {
    await browser.close()
  }
}

// The Login button exists before the page's handler is attached, so a click
// that lands too early is lost; re-dispatch it until the auth redirect starts.
// A plain `click()` hangs on this page; dispatching the event does not.
async function clickLoginUntilRedirected(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (new URL(page.url()).hostname !== AUTH_HOST && Date.now() < deadline) {
    await page
      .getByText('Login', { exact: true })
      .last()
      .dispatchEvent('click', undefined, { timeout: 5000 })
    await page.waitForURL((url) => url.hostname === AUTH_HOST, { timeout: 3000 }).catch(() => {})
  }
}

async function assertNotBlocked(page: Page): Promise<void> {
  const title = await page.title().catch(() => '')
  if (/access denied/i.test(title)) {
    throw new Error(
      'Akamai blocked the headless browser ("Access Denied") — check that Chrome is installed and up to date',
    )
  }
}

async function collectSession(context: BrowserContext, timeoutMs: number): Promise<StoredSession> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const cookies = (await context.cookies()).filter((cookie) =>
      (REQUIRED_COOKIES as readonly string[]).includes(cookie.name),
    )
    const missing = REQUIRED_COOKIES.filter((name) => !cookies.some((c) => c.name === name))
    if (missing.length === 0) {
      return {
        cookies: cookies.map(({ name, value }) => ({ name, value })),
        capturedAt: new Date().toISOString(),
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`Missing cookies after passkey login: ${missing.join(', ')}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
