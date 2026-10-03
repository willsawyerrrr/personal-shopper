# Personal Shopper

Voice-triggered automation that adds preferred products to a Woolworths
Click & Collect cart: "Hey Siri, add milk to Grocery List" on a HomePod ends
with the household's usual milk in the cart.

See [`docs/architecture.md`](docs/architecture.md) for how it fits together,
[`docs/siri-setup.md`](docs/siri-setup.md) for the Shortcuts/Reminders setup,
and [`docs/deployment.md`](docs/deployment.md) for running the webhook.

The Woolworths login is captured once with `pnpm capture-session` and then
kept alive by the server through Woolworths' `/auth/heartbeat` refresh;
re-run the capture only if the refresh is rejected. Set
`SESSION_KEEPALIVE_INTERVAL_MS=0` to refresh only on demand.

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
