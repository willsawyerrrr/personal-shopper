# Architecture

## Flow

1. **Sign-in**: Google is the only way to authenticate, for the browser and
   for API clients (iOS app, Chrome extension). The server is the OAuth client
   of Google, restricts sign-in to `ALLOWED_EMAILS`, and issues its own
   session cookie (browser) or opaque bearer token (clients). Each token
   belongs to a user (their lower-cased email), and everything below acts for
   that user: their items, their Woolworths session, their passkey. Endpoints,
   token lifetime and the client contract are in [`auth.md`](auth.md).
2. **`/admin`** (`src/admin.ts`): lists, adds, edits, and removes the signed-in
   user's items (the `items` table, `src/items.ts`), no restart required. It is behind Google sign-in
   (`/admin/login` is a "Sign in with Google" button; routes in
   `src/login.ts`) and shows the user's own active sessions with a revoke button. Since
   Woolworths' search is broken (see risks below), there's no in-app product
   search; you find a product on woolworths.com.au yourself and paste its URL
   in, and the stockcode is parsed out of `/shop/productdetails/<stockcode>/...`.
   Requests with `Accept: application/json` and a bearer token get JSON
   instead of the web UI's redirects: `GET /admin/items`,
   `POST /admin/items`, `PATCH /admin/items/:word`, `DELETE /admin/items/:word`,
   and `401 {error}` when unauthenticated. Saving a user's items replaces
   them in one transaction, so a reader never sees a partial list. Each
   item also stores its `listing`, the product's title on woolworths.com.au,
   looked up with `WoolworthsClient.listing` (below) when the item is added or
   its stockcode changes, and backfilled in the background for items without
   one. A failed lookup is logged and never fails the request.
3. **The `extension/` Chrome extension** and **the `ios/` app** are clients of
   that JSON API: from the Woolworths product page (extension) or share sheet
   (iOS) they add a product from its URL. See
   [`extension/README.md`](../extension/README.md) and
   [`ios/README.md`](../ios/README.md); both sign in with the client flow in
   [`auth.md`](auth.md#api-client-sign-in).
4. **Two paths into the cart**: an iCloud Reminders list that the server
   syncs (below), and `POST /cart/items` (`src/cart.ts`), which the iOS app's
   App Intent calls with a bearer token and a spoken phrase. It resolves the
   phrase against the token's user's items and calls that user's
   `WoolworthsClient.addToCart` directly; a rejected Woolworths session is a `502`. Contract in
   [`auth.md`](auth.md#adding-to-the-cart).
5. **`WoolworthsClient`** (`src/woolworths/client.ts`) calls Woolworths'
   unofficial API directly. `POST /api/v3/ui/trolley/update` for cart changes
   is confirmed working against a live cart. `GET /apis/ui/product/detail/<stockcode>`
   is read-only and works with the same session cookies (and fails without
   them); `Product.DisplayName` is the listing text. `POST /apis/ui/Search/products`
   for search is confirmed broken or deprecated; see the risks below.
6. **`SessionStore`** (`src/woolworths/session.ts`) holds a user's cookie jar
   (the `woolworths_sessions` table, via `PgSessionStorage`) those calls
   authenticate with and refreshes it through `GET /auth/heartbeat`
   (Woolworths' endpoint, not this server's). `UserWoolworths`
   (`src/users/woolworths.ts`) creates one `SessionStore` and
   `WoolworthsClient` per user on first use and caches them, so one user's
   concurrent refreshes and logins share a request while users never share a
   session.

## Data

All state is in Supabase Postgres, reached with `DATABASE_URL` from the server
only (no Supabase client keys, no client access). The schema is
`supabase/migrations/*.sql`, applied with the Supabase CLI; the server never
migrates. Every table has row level security enabled and no policies, so the
`anon` and `authenticated` roles can read and write nothing; the server uses
the privileged role.

| Table                 | Holds                                                                     |
| --------------------- | ------------------------------------------------------------------------- |
| `users`               | One row per email (lower-cased, unique); the key of every other table.    |
| `tokens`              | Hashed bearer tokens and admin sessions, with client and expiry.          |
| `items`               | A user's trigger phrase, stockcode, quantity and listing, in order.       |
| `woolworths_sessions` | A user's Woolworths cookie jar.                                           |
| `passkey_credentials` | A user's passkey credential, AES-256-GCM encrypted (IV, tag, ciphertext). |

`CredentialStore` (`src/users/credentials.ts`: `get`, `put`, `delete` per user)
encrypts with `CREDENTIALS_ENCRYPTION_KEY` before the credential reaches the
database, so the key is never stored there and the credential is never logged.
The server refuses to start without the key when any credential exists.

On start, `importLegacyFiles` (`src/users/import.ts`) imports `items.yml`,
`session.json`, `passkey-credentials.json` and `tokens.json` from
`ITEMS_PATH`, `SESSION_PATH`, `PASSKEY_CREDENTIALS_PATH` and `TOKEN_STORE_PATH`
when they exist: tokens keep their emails and the rest becomes the owner's. A
file is imported only into an empty destination and then renamed with an
`.imported` suffix, so nothing is lost and the import never runs twice.

## Reminders queue

A shared iCloud Reminders list ("Shopping List" by default) is the queue the
server drains into the cart. Adding a reminder to it, such as with Siri's
built-in "add milk to my Shopping List", queues that item.

`ICloudRemindersClient` (`src/reminders/client.ts`) polls that list over
iCloud's CalDAV interface (`https://caldav.icloud.com`), authenticated with
an app-specific password (`ICLOUD_USERNAME` /
`ICLOUD_APP_SPECIFIC_PASSWORD`, generated at appleid.apple.com, not the
Apple ID password itself). `syncReminders` (`src/reminders/sync.ts`) runs on
an interval (`REMINDERS_SYNC_INTERVAL_MS`, default 5 minutes) from
`src/server.ts`: for each pending reminder it resolves the title against
the owner's items (an exact, normalised match on the trigger word), calls
`WoolworthsClient.addToCart` directly, and deletes the reminder once it lands
in the cart. A reminder with no mapping, or one that fails because the
Woolworths session is expired (heartbeat refresh rejected), is left queued and
retried on the next interval. This is opt-in: deployments that don't set both
iCloud env vars skip it entirely. It is server-side only and needs no sign-in.
The list belongs to the operator, so the sync acts for one user, the owner
(`REMINDERS_OWNER_EMAIL`, default the first of `ALLOWED_EMAILS`): it resolves
titles against the owner's items and adds to the owner's cart.

## Session capture

Woolworths' login (Auth0 at `auth.woolworths.com.au`) signs in without a
password or SMS code when a discoverable passkey is available, and sits behind
Akamai Bot Manager. Two paths produce a user's stored session:

- **Passkey login** (`src/woolworths/passkey.ts`): plain `fetch` with a cookie
  jar, no browser. It walks `GET /auth/login` through the redirects to the
  Auth0 identifier page (`/u/login/identifier?state=…`), reads the WebAuthn
  challenge from the page's embedded context
  (`screen.data.passkey.public_key.challenge`), and signs it with the stored
  credential's private key: `clientDataJSON` for origin
  `https://auth.woolworths.com.au`, `authenticatorData` of the RP ID hash, flags
  `0x05` and a timestamp sign count. Ed25519 keys sign raw, ES256 (P-256) keys
  produce a DER signature. The assertion is posted to the identifier form;
  following `/authorize/resume` and `/auth/callback` leaves the jar holding
  `w-rctx`, `wow-auth-token`, `prodwow-auth-token`, `w-aref` (httpOnly,
  `/auth`-scoped) and `w-loggedin`. Cookies set by the responses are kept
  (deletions applied); the session stores the required ones plus any Akamai
  cookies. Errors distinguish an Akamai block (403, non-HTML or "Access
  Denied" response), a rejected passkey and missing cookies. `pnpm passkey-login`
  runs it by hand, for the same `--user`.
- **Manual capture** (`pnpm capture-session`, `scripts/capture-session.ts`):
  opens a visible browser, waits for you to log in and set your Click &
  Collect store/pickup slot by hand, then extracts the required cookies into
  the user's session.

`pnpm register-passkey` (`scripts/register-passkey.ts`) registers the
credential once: it opens a headed Chrome (the only passkey step that needs a
browser) with a virtual authenticator, you
log in and accept Woolworths' prompt to create a passkey, and the credential
(the output of `WebAuthn.getCredentials`) is encrypted and stored for the user
(`--user <email>`, default the owner) through `CredentialStore`. The scripts
read `DATABASE_URL` and `CREDENTIALS_ENCRYPTION_KEY` from the environment. It
grants login to the account, so treat it like a password.

### Heartbeat refresh

`GET /auth/heartbeat`, sent with the cookie jar, returns
`{"refreshed":true}` and re-issues `w-rctx`, `wow-auth-token`,
`prodwow-auth-token` and `w-loggedin` (1 hour lifetime) plus `w-aref` (30
day lifetime, re-issued on every call, so it rotates). `SessionStore.refresh`
calls it with browser-like headers and writes every re-issued cookie back to
`session.json` atomically (temp file plus rename). It runs:

- on demand, when a request finds the tokens older than 55 minutes;
- on a timer (`SESSION_KEEPALIVE_INTERVAL_MS`, default 6 hours, `0`
  disables) that visits every user with a stored session (the owner and
  everyone with an active token), so each 30 day `w-aref` window keeps rolling
  while idle.

A non-200, `refreshed:false`, or a response without a new `w-aref` is a
rejected session. If the user has a stored passkey credential,
`SessionStore` runs the passkey login and persists the result; concurrent
callers for the same user share one refresh and one login. Otherwise the request
fails with the session-expired error (and the Reminders sync leaves items
queued) until `pnpm passkey-login` or `pnpm capture-session` is run. A failed
passkey login surfaces its own error; the next call retries it.

## Deployment

Runs as one always-on Fly.io machine in `syd`, publicly reachable over HTTPS
so the clients work from any network. The image is a multi-stage Node
build with production dependencies only and no browser; Chrome is only used
by the one-off `pnpm register-passkey` and `pnpm capture-session` on a
developer machine. State is in Supabase Postgres (above); a Fly volume at
`/data` is only needed to hold single-user files for the start-up import.
Because the server is on the
internet, `/auth/*` is rate limited per client IP (keyed on `X-Forwarded-For`
when `TRUST_PROXY=true`), the admin session cookie is `Secure` over HTTPS, and
`GET /healthz` is the unauthenticated health check.
See [`deployment.md`](deployment.md).

## Risks / open questions

- **Session lifetime**: `wow-auth-token` and `prodwow-auth-token` are
  short-lived JWTs (refreshed after 55 minutes in `SessionStore`). The
  heartbeat keeps the login alive for as long as `w-aref` (30 days, rotated
  on each refresh) stays valid. When the refresh is rejected the server
  signs in with the stored passkey; without one, run `pnpm capture-session`
  again.
- **Passkey login**: depends on Woolworths keeping discoverable-passkey login
  and on Akamai accepting plain HTTP requests with browser-like headers;
  either can change without notice, in which case the login fails with a descriptive
  error. Whether the Click & Collect store/slot survives a passkey login
  (rather than a hand-captured session) is unverified; if items land against
  the wrong store, re-select it with `pnpm capture-session`.
- **Anti-bot**: Akamai Bot Manager cookies (`bm_sv`, `_abck`, `ak_bmsc`) are
  present on woolworths.com.au but are optional in a session: the passkey
  login, `GET /auth/heartbeat` and an authenticated read
  (`GET /api/v3/ui/trolley`, which reports the account as signed in) all
  succeed without them, over plain HTTP with browser-like headers. Cart writes
  (`POST /api/v3/ui/trolley/update`) without them are unverified, as they
  mutate the real cart; if Akamai challenges writes, a hand-captured session
  (`pnpm capture-session`) still carries them.
- **Click & Collect store/slot persistence is confirmed working.** Picking
  the store by hand in `pnpm capture-session`'s real browser, then replaying
  the captured cookies through `WoolworthsClient.addToCart`, successfully
  added an item to the live cart — the fulfilment store selected during
  capture does carry over onto subsequent API-only cart calls. Store lookup
  itself is also confirmed: `GET /api/v3/ui/fulfilment/stores?postcode=XXXX`
  returns nearby stores, each with a `FulfilmentStoreId` and
  `FulfilmentMethod` (`DriveUp` is Direct to boot, `DTBNow` is Direct to boot
  Now, `Pickup` is in-store); saving a selection requires an authenticated
  session (an anonymous save redirects to `/shop/securelogin`).
- **`POST /apis/ui/Search/products` is confirmed broken or deprecated.**
  Against a real authenticated session it returns a generic 400 ("Sorry an
  error has occurred") regardless of the request body shape — adding the
  extra community-documented fields (`formatObject`, `isSpecial`, `isBundle`,
  `isMobile`, `groupEdmVariants`) made no difference. `pnpm search-product`
  doesn't currently work; find stockcodes by hand instead from a product's
  URL (`/shop/productdetails/<stockcode>/...`). `addToCart` is unaffected.
- **No on-device path into the Woolworths app exists.** Its
  `apple-app-site-association` file (`https://www.woolworths.com.au/.well-
known/apple-app-site-association`) confirms `/shop/productdetails/*` is a
  registered universal link, so opening a product URL deep-links into the
  app's product page, but there's no documented URL parameter, App Intent, or
  Siri Shortcut donation that adds to cart from there, so it still needs a
  manual tap. An on-device-only flow can't replace this repo's server.
