import { chromium, type BrowserContext, type CDPSession, type Page } from 'playwright'
import { scriptUser } from './user.ts'

// Akamai Bot Manager answers "Access Denied" to default headless Chrome; it
// accepts the installed Chrome channel with the automation flag hidden and a
// desktop user agent.
const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'
const BROWSER_ARGS = ['--disable-blink-features=AutomationControlled']

/**
 * Attaches a CDP virtual authenticator (ctap2, internal, resident key, user
 * verified) to `page` and returns its session and id.
 */
async function addVirtualAuthenticator(
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

const user = scriptUser()
const credentialStore = user.credentials()
const TIMEOUT_MS = 10 * 60 * 1000

const browser = await chromium.launch({ headless: false, channel: 'chrome', args: BROWSER_ARGS })
try {
  const context = await browser.newContext({ viewport: null, userAgent: BROWSER_USER_AGENT })
  const page = await context.newPage()
  const { cdp, authenticatorId } = await addVirtualAuthenticator(context, page)
  await page.goto('https://www.woolworths.com.au/shop/securelogin')

  console.log('Log in in the browser window and accept the prompt to create a passkey.')
  const deadline = Date.now() + TIMEOUT_MS
  for (;;) {
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId })
    if (credentials.length > 0) {
      await credentialStore.put(
        user.email,
        credentials.map((credential) => ({ ...credential })),
      )
      console.log(`Passkey saved for ${user.email}`)
      break
    }
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for a passkey to be created')
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
} finally {
  await browser.close()
  await user.close()
}
