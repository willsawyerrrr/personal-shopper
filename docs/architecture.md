# Architecture

## Flow

1. **Voice capture** reuses Apple's native Reminders NLU instead of a custom
   Siri phrase: a shared iCloud Reminders list (e.g. "Grocery List") that
   either partner adds to with "Hey Siri, add milk to Grocery List" on the
   HomePod. No app, no custom vocabulary — Siri already parses arbitrary item
   text onto a list reliably.
2. An iPhone Shortcuts **personal automation** triggers on "when a reminder is
   added" to that list, reads the reminder's text, and calls the webhook
   below. Lives entirely in the Shortcuts app — see
   [`siri-setup.md`](siri-setup.md).
3. **`POST /items`** (this repo, `src/app.ts`) — bearer-auth via `SHARED_SECRET`,
   body `{ "item": "milk" }`. Looks up the spoken term in `items.yml`
   (`stockcode` + `quantity`, maintained by hand) and calls
   `WoolworthsClient.addToCart`.
4. **`WoolworthsClient`** (`src/woolworths/client.ts`) calls Woolworths'
   unofficial API directly. `POST /api/v3/ui/trolley/update` for cart changes
   is confirmed working against a live cart. `POST /apis/ui/Search/products`
   for search is confirmed broken or deprecated — see the risks below.
5. **`SessionStore`** (`src/woolworths/session.ts`) holds the cookie jar
   (`session.json`, gitignored) those calls authenticate with.
6. **`GET /admin`** (`src/admin.ts`), Basic-Auth protected with
   `SHARED_SECRET` as the password. Since Woolworths' search is broken (see
   risks below), there's no in-app product search — instead you find a
   product on woolworths.com.au yourself and paste its URL in; the stockcode
   is parsed out of `/shop/productdetails/<stockcode>/...`. Lists, adds, and
   removes entries in `items.yml` directly, no restart required.
7. **The `extension/` Chrome extension** calls the same `POST /admin/items`
   endpoint from a popup on the Woolworths product page you're already
   looking at, prefilling the URL and name so there's no tab-switching to
   copy them across by hand. See [`extension/README.md`](../extension/README.md).

## Session capture

Woolworths' login requires SMS 2FA and sits behind Akamai Bot Manager, so
there's no clean programmatic login path — every existing community project
that automates this API does the same thing: a human logs in through a real
browser once, and the cookies get replayed for subsequent API calls.

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
