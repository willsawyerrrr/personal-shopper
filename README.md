# Personal Shopper

Voice-triggered automation that adds preferred products to a Woolworths
Click & Collect cart: "Hey Siri, add milk to Grocery List" on a HomePod ends
with the household's usual milk in the cart.

See [`docs/architecture.md`](docs/architecture.md) for how it fits together,
[`docs/auth.md`](docs/auth.md) for Google sign-in and the API client contract,
[`docs/siri-setup.md`](docs/siri-setup.md) for the Siri and Reminders setup,
and [`docs/deployment.md`](docs/deployment.md) for deploying to Fly.io and
creating the Google OAuth client.

Each signed-in user drives their own Woolworths account: items, session and
passkey are per user, in Postgres (`DATABASE_URL`; schema in
`supabase/migrations`, applied with the Supabase CLI). A user's Woolworths login
is captured once with `pnpm capture-session` (optionally `--user <email>`) and
then kept alive by the server through Woolworths' `/auth/heartbeat` refresh. Set
`SESSION_KEEPALIVE_INTERVAL_MS=0` to refresh only on demand.

If the refresh is rejected, the server signs in again over plain HTTP with a
passkey registered once via `pnpm register-passkey` (encrypted with
`CREDENTIALS_ENCRYPTION_KEY` and stored in the database; Chrome is needed only
to register it).
`pnpm passkey-login` does the same login by hand. Without a registered
passkey, re-run `pnpm capture-session`.

The server runs on Fly.io (`fly.toml`, `Dockerfile`) with its data in Supabase
Postgres; `GET /healthz` is the unauthenticated health check, and `/auth/*` is
rate limited per client IP.

Sign-in is Google only and open to any account with a verified email, up to
`MAX_USERS`: the admin UI at
`/admin` uses a session cookie and API clients use server-issued bearer
tokens.

The `ios/` app (see [`ios/README.md`](ios/README.md)) manages items and adds a
product from the iOS share sheet. Its Siri App Intent adds an item to the cart
through `POST /cart/items`, authorised by the app's bearer token.

## Development

```bash
pnpm install
cp .env.example .env   # Google variables (docs/deployment.md#google-sign-in) and DATABASE_URL
supabase start         # local Postgres; `supabase db reset` applies supabase/migrations
pnpm dev
```

Tests run against a real Postgres at `TEST_DATABASE_URL` (default
`postgres://postgres@localhost:54329/postgres`; each test uses its own schema):

```bash
pnpm lint
pnpm typecheck
pnpm coverage
```
