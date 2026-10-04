# CLAUDE.md

## Purpose

Voice-triggered automation that adds preferred products to a Woolworths
Click & Collect ("Direct to Boot") cart, so "Hey Siri, add milk to Grocery
List" on a HomePod results in the household's usual milk landing in the
cart. See [`README.md`](README.md) and [`docs/`](docs/) for scope and design.

## Fixed scope decisions

- Retailer: Woolworths Australia only.
- Cart only — this never places an order. Checkout stays manual.
- Multi-user: each signed-in user (keyed by lower-cased Google email) belongs
  to a household, which has one set of items, one Woolworths session and one
  passkey credential, so its members' carts are driven by the same Woolworths
  account. A new user starts in a household of their own; members invite each
  other with single-use, expiring codes (`src/households.ts`), and joining
  discards the joiner's previous household if they were its only member.
  Tokens stay per user. Everything lives in Supabase Postgres
  (`DATABASE_URL`, server-side only; schema in `supabase/migrations`, applied
  by the Supabase CLI, never auto-migrated; RLS on with no policies).
- Item matching is exact, hand-maintained mapping (per household: spoken term →
  stockcode + quantity), not fuzzy search or NLU. A user who wants a different
  brand edits their mapping.
- Session auth is cookie replay, kept alive by `GET /auth/heartbeat`
  refreshes (on demand near token expiry, plus an opt-out timer) that persist
  the rotating `w-aref` cookie. When the refresh is rejected the server signs
  in over plain HTTP with the user's stored passkey credential
  (`src/woolworths/passkey.ts`; no browser), which a user registers from the
  Chrome extension (virtual authenticator over `chrome.debugger`, uploaded to
  `PUT /woolworths/passkey` in `src/passkey.ts`; bearer token only, rate
  limited) or by hand with `pnpm register-passkey`. Credentials are AES-256-GCM encrypted in
  the app (`CREDENTIALS_ENCRYPTION_KEY`, required once any exists) before they
  reach the database, and never logged. Without a registered credential,
  `pnpm capture-session` (manual login) is the only recovery. No password or
  SMS-code login is automated. Each user's session store is created lazily and
  the keepalive timer visits every user. See
  [`docs/architecture.md`](docs/architecture.md#session-capture).
- Auth: Google is the only way to sign in; no shared secret exists. The
  server is the OAuth client of Google (authorization code with PKCE), any
  Google account with `email_verified` true may sign up (no allowlist; a user
  row is created on first sign-in), and it issues its own session cookie
  (`/`) or opaque bearer tokens (iOS app, Chrome extension; hashed in
  the `tokens` table, 90-day sliding expiry, revocable). Abuse is bounded by
  env-configurable limits: `MAX_USERS`, per-household items and invites, per-user active tokens, and
  per-user plus per-IP rate limits (`docs/auth.md#limits`). The Google
  consent screen must be published "In production". See
  [`docs/auth.md`](docs/auth.md).
- Deployment: one always-on Fly.io machine (`fly.toml`, `Dockerfile`) in
  `syd`, publicly reachable over HTTPS, state in Supabase Postgres; no browser
  at runtime. A `/data` volume is only needed to hold single-user files
  (`items.yml`, `session.json`, `tokens.json`, `passkey-credentials.json`),
  which are imported into the owner's rows on start and renamed `.imported`.
  `/auth/*` is rate limited. Requests log one `request completed` line and
  every auth rejection a `warn` with a `reason` (never a token, code, ID
  token, secret or cookie). See
  [`docs/deployment.md`](docs/deployment.md).
- Voice capture: a shared iCloud Reminders list is the queue the server
  syncs into the owner's cart (`REMINDERS_OWNER_EMAIL`, required when the sync
  is enabled; Siri's built-in "add X to my Shopping List"); the iOS
  app's App Intent is the other Siri path, calling `POST /cart/items`
  (`src/cart.ts`, bearer token only, rate limited). See
  [`docs/siri-setup.md`](docs/siri-setup.md) and
  [`docs/architecture.md`](docs/architecture.md#reminders-queue).
- iOS release: merges to `main` touching `ios/**` ship to TestFlight via
  `.github/workflows/deploy-ios.yml` (platform's reusable `ios-testflight.yml`).
  Needs repo secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`, repo variable
  `DEVELOPMENT_TEAM`, and an App Store Connect app record for
  `dev.willsawyerrrr.personalshopper`. See
  [`ios/README.md`](ios/README.md#testflight).

## Layout

`src/woolworths` is everything that talks to Woolworths' unofficial API;
`src/app.ts` wires up Fastify, `src/login.ts` the Google sign-in routes,
`src/admin.ts` the web app and its JSON API, `src/cart.ts` the cart route, `src/passkey.ts` the passkey routes,
`src/tokens.ts` the token store, `src/items.ts` the item store, `src/db.ts` the
Postgres connection and `src/users/` the per-user credential store, session
storage, Woolworths clients and legacy-file import; `supabase/migrations` is the
schema; `scripts/` are one-off CLIs run by hand (session capture, product
lookup), each taking `--user <email>` (default `REMINDERS_OWNER_EMAIL`); `extension/` is the Chrome
extension and `ios/` the SwiftUI app with its Share extension and App
Intents (clients of `/items` and `/cart/items`). See
[`docs/architecture.md`](docs/architecture.md) for how the pieces fit and the
open risks.

```bash
pnpm run lint
pnpm run typecheck
pnpm run coverage               # needs Postgres at TEST_DATABASE_URL (default localhost:54329)
pnpm run build
# the scripts below take `--user <email>` (default REMINDERS_OWNER_EMAIL)
pnpm run register-passkey     # one-off: register the passkey the server logs in with
pnpm run passkey-login        # HTTP passkey login, stores the session
pnpm run capture-session      # manual Woolworths login, stores the session (only needed when the heartbeat refresh is rejected)
pnpm run search-product <term>  # find a stockcode to map
cd ios && xcodegen generate     # writes the gitignored Xcode project from project.yml
xcodebuild test -project ios/PersonalShopper.xcodeproj -scheme PersonalShopper -destination 'platform=iOS Simulator,name=iPhone 17'
```

iOS device signing: put `DEVELOPMENT_TEAM = <team ID>` in the gitignored
`ios/Config/Local.xcconfig` (template: `Local.xcconfig.example`), included
optionally by `Config/Shared.xcconfig`. Never set the team in the Xcode UI or
commit the ID. See [`ios/README.md`](ios/README.md#setup).

## Conventions

- Planning happens in Linear, not in ad-hoc conversation or another planning
  tool: break work into issues in the **Personal Shopper** project (team
  `WSD`) before implementing, and track decisions there.
