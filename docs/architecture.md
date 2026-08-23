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
   unofficial API directly: `POST /apis/ui/Search/products` for search,
   `POST /api/v3/ui/trolley/update` for cart changes. Both endpoints and their
   payload shapes come from community reverse-engineering, not official docs.
5. **`SessionStore`** (`src/woolworths/session.ts`) holds the cookie jar
   (`session.json`, gitignored) those calls authenticate with.

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

Runs on an always-on Windows PC via WSL, exposed through a Cloudflare Tunnel.
See [`deployment.md`](deployment.md).

## Risks / open questions

- **Session lifetime**: `wow-auth-token` and `prodwow-auth-token` are
  short-lived JWTs (treated as expired after 55 minutes in `SessionStore`).
  This is manual-recapture automation, not fire-and-forget — expect to run
  `pnpm capture-session` regularly, not once.
- **Anti-bot**: Akamai Bot Manager cookies (`bm_sv`, `_abck`, `ak_bmsc`) are
  present on woolworths.com.au. Plain HTTP requests without a real browser's
  fingerprint risk being challenged or blocked; that's why session capture
  goes through an actual browser rather than a scripted login.
- **Click & Collect store/slot persistence is unverified.** Store lookup is
  now confirmed: `GET /api/v3/ui/fulfilment/stores?postcode=XXXX` returns
  nearby stores, each with a `FulfilmentStoreId` and `FulfilmentMethod`
  (`DriveUp` is Direct to boot, `DTBNow` is Direct to boot Now, `Pickup` is
  in-store). Saving a Direct to boot selection redirects an unauthenticated
  session to `/shop/securelogin` — the fulfilment store is bound to an
  authenticated session, not set by an anonymous call. What's still
  unconfirmed: the exact request that _saves_ the chosen store once logged
  in (not captured live — reaching it needs an authenticated session, which
  only a human can create per the SMS 2FA constraint above), and whether
  that selection persists onto subsequent API-only cart calls replaying the
  captured cookies. The working assumption remains that picking the store by
  hand in `pnpm capture-session`'s real browser carries that selection over;
  this hasn't been confirmed against a live order.
- **Response field names in `parseSearchResponse`** (`src/woolworths/client.ts`)
  are best-effort from community docs, not a captured live response — verify
  with `pnpm search-product <term>` before trusting the output.
