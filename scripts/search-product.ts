import { WoolworthsClient } from '../src/woolworths/client.ts'
import { scriptUser } from './user.ts'

const user = scriptUser()
try {
  const [term] = user.positionals
  if (!term) {
    throw new Error('Usage: pnpm search-product <term> [--user <email>]')
  }
  const results = await new WoolworthsClient(user.sessions).search(term)
  for (const product of results) {
    console.log(`${product.stockcode} | ${product.name} | $${product.price.toFixed(2)}`)
  }
} finally {
  await user.close()
}
