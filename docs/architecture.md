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
   (`session.json`, gitignored) those calls authenticate with.
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
fails because the Woolworths session is expired, is left queued and retried
on the next interval. This is opt-in — deployments that don't set both
iCloud env vars skip it entirely.

## Session capture

Woolworths' login requires approving a passkey (or SMS code) in a real,
visible browser and sits behind Akamai Bot Manager, so there's no clean
programmatic login path — every existing community project that automates
this API does the same thing: a human logs in through a real browser once,
and the cookies get replayed for subsequent API calls. The passkey is
synced through 1Password rather than tied to one physical key, but
WebAuthn's user-verification step still requires a human to unlock the
vault and approve it, so it doesn't unlock scripted login even though it
drops the SMS-code step. Driving the approval via RPA (e.g. scripting
clicks through the 1Password extension) doesn't change that either: it
would need the vault unlocked non-interactively — undermining the point
of gating login behind a passkey — and running login through Playwright
repeatedly (session lifetime is 55 minutes, see below) is exactly the
scripted-browser pattern Akamai Bot Manager is positioned to catch.

`pnpm capture-session` (`scripts/capture-session.ts`) opens a real,
non-headless browser via Playwright, waits for you to log in and set your
Click & Collect store/pickup slot by hand, then extracts the required cookies
into `session.json`.

## Deployment

Runs natively on an always-on Windows PC, reachable only over the home
network — no public exposure, deliberately. `pnpm capture-session` needs a
real browser you can approve with a passkey anyway, so there's no benefit to
running elsewhere, and this sidesteps WSL2's port-forwarding limitations for
LAN reachability. See [`deployment.md`](deployment.md).

## Risks / open questions

- **Session lifetime**: `wow-auth-token` and `prodwow-auth-token` are
  short-lived JWTs (treated as expired after 55 minutes in `SessionStore`).
  This is manual-recapture automation, not fire-and-forget — expect to run
  `pnpm capture-session` regularly, not once.
- **Anti-bot**: Akamai Bot Manager cookies (`bm_sv`, `_abck`, `ak_bmsc`) are
  present on woolworths.com.au. Plain HTTP requests without a real browser's
  fingerprint risk being challenged or blocked; that's why session capture
  goes through an actual browser rather than a scripted login.
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
