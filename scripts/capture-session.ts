import { chromium } from 'playwright'
import { REQUIRED_COOKIES, SessionStore } from '../src/woolworths/session.ts'

async function main(): Promise<void> {
  const sessionPath = process.env.SESSION_PATH ?? 'session.json'
  const browser = await chromium.launch({
    headless: false,
    args: ['--window-position=0,0', '--window-size=1280,900'],
  })
  const context = await browser.newContext({ viewport: null })
  const page = await context.newPage()
  await page.goto('https://www.woolworths.com.au/shop/search/products?searchTerm=milk')

  console.log('Log in, then set your Click & Collect store and pickup slot in this window.')
  // Whether the store/slot chosen here carries onto API-only cart calls made
  // later with just these cookies is unverified — the fulfilment endpoint(s)
  // weren't captured. If items land against the wrong store, that's the first
  // thing to re-investigate.
  console.log('Press Enter here once your cart shows the right pickup details.')
  await waitForEnter()

  const cookies = await context.cookies()
  const captured = cookies.filter((cookie) =>
    (REQUIRED_COOKIES as readonly string[]).includes(cookie.name),
  )
  const missing = REQUIRED_COOKIES.filter(
    (name) => !captured.some((cookie) => cookie.name === name),
  )
  if (missing.length > 0) {
    throw new Error(
      `Missing cookies after login: ${missing.join(', ')} — log in fully before continuing`,
    )
  }

  const store = new SessionStore(sessionPath)
  await store.save({
    cookies: captured.map((cookie) => ({ name: cookie.name, value: cookie.value })),
    capturedAt: new Date().toISOString(),
  })

  console.log(`Session saved to ${sessionPath}`)
  await browser.close()
}

function waitForEnter(): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume()
    process.stdin.once('data', () => resolve())
  })
}

await main()
