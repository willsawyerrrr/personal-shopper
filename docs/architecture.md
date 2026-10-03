# Architecture

## Flow

1. **Voice capture**: a Shortcut with a fixed Siri phrase (e.g. "Add to
   shopping list") runs **Dictate Text**, which triggers Siri's own built-in
   spoken prompt ("What's the text?"), then **Get Contents of URL** to call
   the webhook below with whatever you said. Lives entirely in the Shortcuts
   app, confirmed working end-to-end — see [`siri-setup.md`](siri-setup.md).
   There's no native Reminders-list trigger to hook into Shortcuts
   automations with, and no way for a user-created Shortcut to register a
   Siri phrase with an embedded free-text slot — this is the actual
   available mechanism, not the more elegant-sounding alternative it
   replaced.
2. **`POST /items`** (this repo, `src/app.ts`) — bearer-auth via `SHARED_SECRET`,
   body `{ "item": "milk" }`. Looks up the spoken term in `items.yml`
   (`stockcode` + `quantity`, maintained by hand) and calls
   `WoolworthsClient.addToCart`.
3. **`WoolworthsClient`** (`src/woolworths/client.ts`) calls Woolworths'
   unofficial API directly. `POST /api/v3/ui/trolley/update` for cart changes
   is confirmed working against a live cart. `POST /apis/ui/Search/products`
   for search is confirmed broken or deprecated — see the risks below.
4. **`SessionStore`** (`src/woolworths/session.ts`) holds the cookie jar
   (`session.json`, gitignored) those calls authenticate with and refreshes
   it through `GET /auth/heartbeat`.
5. **`GET /admin`** (`src/admin.ts`), gated by a login form at
   `/admin/login` (password field is `SHARED_SECRET`, autofillable from a
   password manager) that sets an in-memory session cookie — not
   Basic-Auth, so it works with a real form instead of the browser's native
   auth dialog. Since Woolworths' search is broken (see risks below),
   there's no in-app product search — instead you find a product on
   woolworths.com.au yourself and paste its URL in; the stockcode is parsed
   out of `/shop/productdetails/<stockcode>/...`. Lists, adds, and removes
   entries in `items.yml` directly, no restart required.
6. **The `extension/` Chrome extension** calls the same `POST /admin/items`
   endpoint from a popup on the Woolworths product page you're already
   looking at, prefilling the URL and name so there's no tab-switching to
   copy them across by hand. Authenticates with a Basic-Auth header (its own
   `SHARED_SECRET`, entered once in the extension's options page) rather
   than the admin UI's session cookie, since it's a background `fetch` call
   with no browser chrome to show a login form in. See
   [`extension/README.md`](../extension/README.md).

## Reminders offline queue

Step 1's webhook call only succeeds on home WiFi (see
[`deployment.md`](deployment.md)); a Shortcut fallback (`siri-setup.md`
step 1a) queues anything it can't deliver by adding a reminder to a shared
iCloud Reminders list ("Shopping List" by default) instead of losing it.

`ICloudRemindersClient` (`src/reminders/client.ts`) polls that list over
iCloud's CalDAV interface (`https://caldav.icloud.com`), authenticated with
an app-specific password (`ICLOUD_USERNAME` /
`ICLOUD_APP_SPECIFIC_PASSWORD`, generated at appleid.apple.com — not the
Apple ID password itself). `syncReminders` (`src/reminders/sync.ts`) runs on
an interval (`REMINDERS_SYNC_INTERVAL_MS`, default 5 minutes) from
`src/server.ts`: for each pending reminder it resolves the title against
`items.yml` exactly like `POST /items` does, calls
`WoolworthsClient.addToCart` directly (no HTTP hop), and deletes the
reminder once it lands in the cart. A reminder with no mapping, or one that
fails because the Woolworths session is expired (heartbeat refresh rejected), is left queued and retried
on the next interval. This is opt-in — deployments that don't set both
iCloud env vars skip it entirely.

## Session capture

Woolworths' login (Auth0 at `auth.woolworths.com.au`) signs in without a
password or SMS code when a discoverable passkey is available, and sits behind
Akamai Bot Manager. Two paths produce `session.json`:

- **Passkey login** (`src/woolworths/passkey.ts`): headless Chrome with a CDP
  virtual authenticator (`WebAuthn.addVirtualAuthenticator`: ctap2, internal,
  resident key, user verified) preloaded with the stored credential
  (`WebAuthn.addCredential`). It opens `/shop/securelogin`, dispatches a click
  on Login (a plain `click()` hangs), waits for the redirect to
  `#postSuccessLogin` and for every required cookie, including the httpOnly,
  `/auth`-scoped `w-aref`. Akamai answers "Access Denied" to default headless
  Chrome; it accepts the installed Chrome channel (`channel: 'chrome'`, so
  Chrome must be installed) with `--disable-blink-features=AutomationControlled`
  and an explicit desktop user agent. Errors distinguish an Akamai block, a
  rejected passkey and missing cookies. `pnpm passkey-login` runs it by hand.
- **Manual capture** (`pnpm capture-session`, `scripts/capture-session.ts`):
  opens a visible browser, waits for you to log in and set your Click &
  Collect store/pickup slot by hand, then extracts the required cookies into
  `session.json`.

`pnpm register-passkey` (`scripts/register-passkey.ts`) registers the
credential once: it opens a headed Chrome with a virtual authenticator, you
log in and accept Woolworths' prompt to create a passkey, and the credential
(the output of `WebAuthn.getCredentials`) is written with `0600` permissions
to `PASSKEY_CREDENTIALS_PATH` (default `passkey-credentials.json`,
gitignored). It grants login to the account, so treat it like a password.

### Heartbeat refresh

`GET /auth/heartbeat`, sent with the cookie jar, returns
`{"refreshed":true}` and re-issues `w-rctx`, `wow-auth-token`,
`prodwow-auth-token` and `w-loggedin` (1 hour lifetime) plus `w-aref` (30
day lifetime, re-issued on every call, so it rotates). `SessionStore.refresh`
calls it with browser-like headers and writes every re-issued cookie back to
`session.json` atomically (temp file plus rename). It runs:

- on demand, when a request finds the tokens older than 55 minutes;
- on a timer (`SESSION_KEEPALIVE_INTERVAL_MS`, default 6 hours, `0`
  disables) so the 30 day `w-aref` window keeps rolling while idle.

A non-200, `refreshed:false`, or a response without a new `w-aref` is a
rejected session. If the passkey credential file exists when the server
starts, `SessionStore` runs the passkey login and persists the result;
concurrent callers share one refresh and one login. Otherwise the request
fails with the session-expired error (and the Reminders sync leaves items
queued) until `pnpm passkey-login` or `pnpm capture-session` is run. A failed
passkey login surfaces its own error; the next call retries it.

## Deployment

Runs natively on an always-on Windows PC, reachable only over the home
network — no public exposure, deliberately. Chrome must be installed there
for the passkey login and session capture, and this sidesteps WSL2's
port-forwarding limitations for LAN reachability. See [`deployment.md`](deployment.md).

## Risks / open questions

- **Session lifetime**: `wow-auth-token` and `prodwow-auth-token` are
  short-lived JWTs (refreshed after 55 minutes in `SessionStore`). The
  heartbeat keeps the login alive for as long as `w-aref` (30 days, rotated
  on each refresh) stays valid. When the refresh is rejected the server
  signs in with the stored passkey; without one, run `pnpm capture-session`
  again.
- **Passkey login**: depends on Woolworths keeping discoverable-passkey login
  and on Akamai accepting the installed-Chrome fingerprint above; either can
  change without notice, in which case the login fails with a descriptive
  error. Whether the Click & Collect store/slot survives a passkey login
  (rather than a hand-captured session) is unverified; if items land against
  the wrong store, re-select it with `pnpm capture-session`.
- **Anti-bot**: Akamai Bot Manager cookies (`bm_sv`, `_abck`, `ak_bmsc`) are
  present on woolworths.com.au. Plain HTTP requests without a real browser's
  fingerprint risk being challenged or blocked; that's why login goes
  through an actual Chrome rather than HTTP calls. The
  heartbeat refresh, sent as plain HTTP with the captured cookies and
  browser-like headers, was not blocked when checked against the live site.
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
- **No Shortcut-only path into the Woolworths app exists.** Its
  `apple-app-site-association` file (`https://www.woolworths.com.au/.well-
known/apple-app-site-association`) confirms `/shop/productdetails/*` is a
  registered universal link, so a Shortcut's "Open URL" does deep-link into
  the app's product page — but there's no documented URL parameter, App
  Intent, or Siri Shortcut donation that adds to cart from there, so it
  still needs a manual tap. An on-device-only Shortcut can't replace this
  repo's server.
