import type { FastifyInstance } from 'fastify'
import { PAGE_STYLES } from './admin-styles.ts'

const PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Personal Shopper privacy policy</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="card">
    <h1>Privacy policy</h1>
    <p>
      Personal Shopper adds products to a Woolworths Click &amp; Collect cart. This policy
      covers the Personal Shopper server, web app, iOS app and Chrome extension.
    </p>

    <h2>What is stored</h2>
    <ul>
      <li>
        <strong>On your device (Chrome extension):</strong> the access token the server issues
        when you sign in, and when it expires, in this browser's local extension storage. It is
        not synced to your Google account. Signing out revokes the token on the server and
        deletes it.
      </li>
      <li>
        <strong>On the server:</strong> your Google email address (to identify your account), a
        hash of each access token, your household's items, and, only if you register one, your
        Woolworths session and passkey, encrypted before they reach the database.
      </li>
    </ul>

    <h2>What is sent</h2>
    <p>
      The extension talks only to the Personal Shopper server and to Woolworths pages you open
      from it. Sign-in goes through Google; the server receives your verified email address and
      nothing else from your Google account.
    </p>

    <h2>What is not done</h2>
    <p>
      No analytics, advertising or tracking. Your data is never sold or shared with third
      parties, and is not used for anything other than operating the service.
    </p>

    <h2>Deleting your data</h2>
    <p>Contact the operator to delete your account and its data.</p>
  </div>
</body>
</html>`

/** Registers the public `/privacy` page the Chrome Web Store listing links to. */
export async function registerPrivacy(app: FastifyInstance): Promise<void> {
  await app.register(async (routes) => {
    routes.get('/privacy', async (_request, reply) => {
      reply.type('text/html').send(PAGE)
    })
  })
}
