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
- Session auth is manual-login-then-cookie-replay
  (`scripts/capture-session.ts`), not automated credential login — Woolworths'
  login requires approving a passkey (synced through 1Password, or an SMS
  code) in a real browser and sits behind Akamai Bot Manager, neither of
  which a script or RPA can satisfy unattended without undermining the point
  of the passkey or tripping bot detection. See
  [`docs/architecture.md`](docs/architecture.md#risks--open-questions).
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
pnpm run capture-session      # manual Woolworths login, refreshes session.json
pnpm run search-product <term>  # find a stockcode for items.yml
```

## Conventions

- Planning happens in Linear, not in ad-hoc conversation or another planning
  tool: break work into issues in the **Personal Shopper** project (team
  `WSD`) before implementing, and track decisions there.
