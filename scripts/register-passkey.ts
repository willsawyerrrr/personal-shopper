import { chmod, writeFile } from 'node:fs/promises'
import { chromium } from 'playwright'
import {
  addVirtualAuthenticator,
  BROWSER_ARGS,
  BROWSER_USER_AGENT,
} from '../src/woolworths/passkey.ts'

const credentialsPath = process.env.PASSKEY_CREDENTIALS_PATH ?? 'passkey-credentials.json'
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
      await writeFile(credentialsPath, JSON.stringify(credentials, null, 2), { mode: 0o600 })
      await chmod(credentialsPath, 0o600)
      console.log(`Passkey saved to ${credentialsPath}`)
      break
    }
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for a passkey to be created')
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
} finally {
  await browser.close()
}
