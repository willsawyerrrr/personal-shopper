import { passkeyLogin } from '../src/woolworths/passkey.ts'
import { SessionStore } from '../src/woolworths/session.ts'

const sessionPath = process.env.SESSION_PATH ?? 'session.json'
const credentialsPath = process.env.PASSKEY_CREDENTIALS_PATH ?? 'passkey-credentials.json'

await new SessionStore(sessionPath).save(await passkeyLogin(credentialsPath))
console.log(`Session saved to ${sessionPath}`)
