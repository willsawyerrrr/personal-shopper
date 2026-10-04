import { passkeyLogin } from '../src/woolworths/passkey.ts'
import { scriptUser } from './user.ts'

const user = scriptUser()
try {
  const credentials = await user.credentials().get(user.email)
  if (!credentials) {
    throw new Error(`No passkey registered for ${user.email} — run \`pnpm register-passkey\` first`)
  }
  await user.sessions.save(await passkeyLogin(credentials))
  console.log(`Session saved for ${user.email}`)
} finally {
  await user.close()
}
