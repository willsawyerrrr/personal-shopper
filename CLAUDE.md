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
  login requires SMS 2FA and sits behind Akamai Bot Manager. See
  [`docs/architecture.md`](docs/architecture.md#risks--open-questions).
- Voice capture piggybacks on Apple's native Reminders NLU via a shared
  iCloud list, not a custom Siri phrase. See
  [`docs/siri-setup.md`](docs/siri-setup.md).

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

- Planning happens in Linear, not in ad-hoc conversation: the **Personal
  Shopper** project, team `WSD`.
