# CLAUDE.md

## Purpose

Voice-triggered automation that adds preferred products to a Woolworths
Click & Collect ("Direct to Boot") cart, so "Hey Siri, add milk to Grocery
List" on a HomePod results in the household's usual milk landing in the
cart. See [`README.md`](README.md) and [`docs/`](docs/) for scope and design.

## Fixed scope decisions

- Retailer: Woolworths Australia only.
- Cart only — this never places an order. Checkout stays manual.
- Item matching is exact, hand-maintained mapping (`items.yml`:
  spoken term → stockcode + quantity), not fuzzy search or NLU. If the
  household wants a different brand, they edit the file.
- Session auth is cookie replay, kept alive by `GET /auth/heartbeat`
  refreshes (on demand near token expiry, plus an opt-out timer) that persist
  the rotating `w-aref` cookie. When the refresh is rejected the server signs
  in over plain HTTP with a stored passkey credential
  (`src/woolworths/passkey.ts`; no browser), which `pnpm register-passkey`
  registers once by hand in Chrome. Without a registered
  credential, `pnpm capture-session` (manual login) is the only recovery. No
  password or SMS-code login is automated. See
  [`docs/architecture.md`](docs/architecture.md#session-capture).
- Auth: Google is the only way to sign in; no shared secret exists. The
  server is the OAuth client of Google (authorization code with PKCE), only
  `ALLOWED_EMAILS` may sign in, and it issues its own session cookie
  (`/admin`) or opaque bearer tokens (iOS app, Chrome extension; hashed in
  `TOKEN_STORE_PATH`, 90-day sliding expiry, revocable). See
  [`docs/auth.md`](docs/auth.md).
- Deployment: one always-on Fly.io machine (`fly.toml`, `Dockerfile`) in
  `syd` with a `/data` volume, publicly reachable over HTTPS; no browser at
  runtime. `/auth/*` is rate limited. Requests log one `request completed`
  line and every auth rejection a `warn` with a `reason` (never a token,
  code, ID token, secret or cookie). See
  [`docs/deployment.md`](docs/deployment.md).
- Voice capture: a shared iCloud Reminders list is the queue the server
  syncs into the cart (Siri's built-in "add X to my Shopping List"); the iOS
  app's App Intent is the other Siri path, calling `POST /cart/items`
  (`src/cart.ts`, bearer token only, rate limited). See
  [`docs/siri-setup.md`](docs/siri-setup.md) and
  [`docs/architecture.md`](docs/architecture.md#reminders-queue).

## Layout

`src/woolworths` is everything that talks to Woolworths' unofficial API;
`src/app.ts` wires up Fastify, `src/login.ts` the Google sign-in routes,
`src/admin.ts` the admin UI and JSON API, `src/cart.ts` the cart route, and `src/tokens.ts` the token store; `scripts/` are one-off CLIs run
by hand (session capture, product lookup); `extension/` is the Chrome
extension and `ios/` the SwiftUI admin app with its Share extension and App
Intent, both clients of `/admin/items`. See
[`docs/architecture.md`](docs/architecture.md) for how the pieces fit and the
open risks.

```bash
pnpm run lint
pnpm run typecheck
pnpm run coverage
pnpm run build
pnpm run register-passkey     # one-off: register the passkey the server logs in with
pnpm run passkey-login        # HTTP passkey login, writes session.json
pnpm run capture-session      # manual Woolworths login, writes session.json (only needed when the heartbeat refresh is rejected)
pnpm run search-product <term>  # find a stockcode for items.yml
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
