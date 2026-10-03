# Personal Shopper

Voice-triggered automation that adds preferred products to a Woolworths
Click & Collect cart: "Hey Siri, add milk to Grocery List" on a HomePod ends
with the household's usual milk in the cart.

See [`docs/architecture.md`](docs/architecture.md) for how it fits together,
[`docs/siri-setup.md`](docs/siri-setup.md) for the Shortcuts/Reminders setup,
and [`docs/deployment.md`](docs/deployment.md) for deploying the webhook to Fly.io.

The Woolworths login is captured once with `pnpm capture-session` and then
kept alive by the server through Woolworths' `/auth/heartbeat` refresh. Set
`SESSION_KEEPALIVE_INTERVAL_MS=0` to refresh only on demand.

If the refresh is rejected, the server signs in again over plain HTTP with a
passkey registered once via `pnpm register-passkey` (saved to
`PASSKEY_CREDENTIALS_PATH`, gitignored; Chrome is needed only to register it).
`pnpm passkey-login` does the same login by hand. Without a registered
passkey, re-run `pnpm capture-session`.

The server runs on Fly.io (`fly.toml`, `Dockerfile`) with its data on a
volume; `GET /healthz` is the unauthenticated health check, and `/items` and
`/admin/login` are rate limited per client IP.

The `ios/` app (see [`ios/README.md`](ios/README.md)) manages items and adds a
product from the iOS share sheet, Shortcuts or Siri.

## Development

```bash
pnpm install
cp .env.example .env
cp items.example.yml items.yml
pnpm dev
```

```bash
pnpm lint
pnpm typecheck
pnpm coverage
```
