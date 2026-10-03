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
  in headlessly with a stored passkey credential held by a CDP virtual
  authenticator (`src/woolworths/passkey.ts`; needs Chrome installed), which
  `pnpm register-passkey` registers once by hand. Without a registered
  credential, `pnpm capture-session` (manual login) is the only recovery. No
  password or SMS-code login is automated. See
  [`docs/architecture.md`](docs/architecture.md#session-capture).
- Voice capture uses a fixed-phrase Shortcut with a follow-up Dictate Text
  prompt, not a custom Siri phrase with an embedded free-text slot — that's
  only available to apps built with Apple's App Intents framework. A shared
  iCloud Reminders list is a fallback offline queue for when the Shortcut
  can't reach the webhook directly, not the primary capture mechanism. See
  [`docs/siri-setup.md`](docs/siri-setup.md) and
  [`docs/architecture.md`](docs/architecture.md#reminders-offline-queue).

## Layout

`src/woolworths` is everything that talks to Woolworths' unofficial API;
`src/app.ts` is the webhook Fastify wires up; `scripts/` are one-off CLIs run
by hand (session capture, product lookup). See
[`docs/architecture.md`](docs/architecture.md) for how the pieces fit and the
open risks.

```bash
pnpm run lint
pnpm run typecheck
pnpm run coverage
pnpm run build
pnpm run register-passkey     # one-off: register the passkey the server logs in with
pnpm run passkey-login        # headless passkey login, writes session.json
pnpm run capture-session      # manual Woolworths login, writes session.json (only needed when the heartbeat refresh is rejected)
pnpm run search-product <term>  # find a stockcode for items.yml
```

## Conventions

- Planning happens in Linear, not in ad-hoc conversation or another planning
  tool: break work into issues in the **Personal Shopper** project (team
  `WSD`) before implementing, and track decisions there.
