import { WoolworthsClient } from '../src/woolworths/client.ts'
import { SessionStore } from '../src/woolworths/session.ts'

const term = process.argv[2]
if (!term) {
  console.error('Usage: pnpm search-product <term>')
  process.exit(1)
}

const sessionPath = process.env.SESSION_PATH ?? 'session.json'
const client = new WoolworthsClient(new SessionStore(sessionPath))
const results = await client.search(term)

for (const product of results) {
  console.log(`${product.stockcode} | ${product.name} | $${product.price.toFixed(2)}`)
}
