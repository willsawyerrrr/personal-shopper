# Deployment

Production runs on [Fly.io](https://fly.io) as a single always-on machine
(`fly.toml`: `syd`, `shared-cpu-1x`, 256 MB) behind Fly's HTTPS proxy, so the
iOS app, Chrome extension and browser reach it from any network. The image (`Dockerfile`) holds
production dependencies only and no browser; the Woolworths login is plain
HTTP. The server process runs unprivileged: `docker-entrypoint.sh` hands the
`/data` volume to the `node` user, then drops root.

Local development uses the same code: `pnpm dev`, then `/` against
`localhost` (Google sign-in needs `http://localhost:3000/auth/google/callback`
registered, below).

## What lives where

- Secrets (`fly secrets set`): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `PUBLIC_BASE_URL`, `DATABASE_URL`,
  `CREDENTIALS_ENCRYPTION_KEY` (`openssl rand -base64 32`; required once any
  passkey credential exists, and never stored in the database), optionally
  `ALLOWED_CLIENT_REDIRECTS`, and `ICLOUD_USERNAME` /
  `ICLOUD_APP_SPECIFIC_PASSWORD` with `REMINDERS_OWNER_EMAIL` for the
  [Reminders queue](architecture.md#reminders-queue).
- Config (`fly.toml` `[env]`): `PORT`, `TRUST_PROXY=true` (rate limiting keys
  on the client IP from `X-Forwarded-For`), the abuse limits (`MAX_USERS` and
  the others in [`auth.md`](auth.md#limits)) and the paths of single-user
  files to import (below).
- Postgres (Supabase): users, tokens, items, Woolworths sessions and encrypted
  passkey credentials, per household ([`architecture.md`](architecture.md#data)). A
  user without items has none; they add them through `/`.
- Volume `data` mounted at `/data`: only the single-user files `items.yml`,
  `session.json`, `passkey-credentials.json` and `tokens.json`, if present, so
  the server can import them into the owner's rows when it starts. Each is
  renamed with an `.imported` suffix afterwards; once all are, the volume and
  the four path variables can be removed.

## Configuration

Secrets and settings live in three [1Password Environments](https://developer.1password.com/docs/environments/); IDs are not secrets.
Apple Development (`b5zkkwxuutlttwbrv5xhgojye4`) and Shared (`3i642eynjpsx2uctyqlexobgge`) hold the account-level secrets
(`DEVELOPMENT_TEAM`, `SUPABASE_ACCESS_TOKEN`, …); Personal Shopper (`pypsxvgj5p7ioxffch5lil4w5u`) holds `FLY_API_TOKEN` and the server's variables.
Local commands run under `op run --environment b5zkkwxuutlttwbrv5xhgojye4 --environment 3i642eynjpsx2uctyqlexobgge --environment pypsxvgj5p7ioxffch5lil4w5u -- <command>` (`pnpm dev` and `pnpm start` already do).
In production Fly secrets and `fly.toml` supply the server's variables.

CI loads the Environments with `willsawyerrrr/platform/.github/actions/load-op-environment`,
which exports every variable to later steps. It uses the repo secret `OP_SERVICE_ACCOUNT_TOKEN`
(a service account scoped to the three Environments) and the repo variable `OP_ENVIRONMENT_IDS`
(`b5zkkwxuutlttwbrv5xhgojye4 3i642eynjpsx2uctyqlexobgge pypsxvgj5p7ioxffch5lil4w5u`: Apple Development, Shared, then Personal Shopper; the last Environment wins on a
duplicate name). The reusable `ios-testflight.yml` loads them the same way.

| Variable                                                                     | Used by         | Notes                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FLY_API_TOKEN`                                                              | deploy workflow | `fly tokens create deploy`                                                                                                                                                                                        |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`                                   | server          | Google OAuth web client ([Google sign-in](#google-sign-in)); the redirect URI registered with Google is `${PUBLIC_BASE_URL}/auth/google/callback`                                                                 |
| `DATABASE_URL`                                                               | server, scripts | Postgres connection string of the privileged role the server connects as; the schema is in `supabase/migrations`                                                                                                  |
| `CREDENTIALS_ENCRYPTION_KEY`                                                 | server          | 32 bytes, base64 or hex (`openssl rand -base64 32`), encrypting stored passkey credentials; required once any credential exists                                                                                   |
| `REMINDERS_OWNER_EMAIL`                                                      | server, scripts | The user the Reminders sync, file import and scripts act for; required when the Reminders sync is enabled                                                                                                         |
| `PUBLIC_BASE_URL`                                                            | server          | Origin the server is reached at, without a path                                                                                                                                                                   |
| `ALLOWED_CLIENT_REDIRECTS`                                                   | server          | Comma-separated redirect URIs `/auth/start` accepts, matched exactly; defaults to the iOS app's `dev.willsawyerrrr.personal-shopper://auth`. Add the Chrome extension's `https://<extension-id>.chromiumapp.org/` |
| `PORT`                                                                       | server          | Default `3000`                                                                                                                                                                                                    |
| `LOG_LEVEL`                                                                  | server          | `fatal`, `error`, `warn`, `info` (default), `debug` (also logs `/healthz`), `trace` or `silent`                                                                                                                   |
| `TRUST_PROXY`                                                                | server          | `true` behind a reverse proxy so rate limiting uses `X-Forwarded-For`; default `false`                                                                                                                            |
| `ITEMS_PATH`, `TOKEN_STORE_PATH`, `SESSION_PATH`, `PASSKEY_CREDENTIALS_PATH` | server          | Files of an earlier single-user deployment, imported into the owner's rows at startup then renamed `.imported`; defaults `items.yml`, `tokens.json`, `session.json`, `passkey-credentials.json`                   |
| `MAX_USERS`                                                                  | server          | Total users; default `50`                                                                                                                                                                                         |
| `MAX_INVITES_PER_HOUSEHOLD`                                                  | server          | Unexpired invites per household; default `5`                                                                                                                                                                      |
| `MAX_TOKENS_PER_USER`                                                        | server          | Unexpired tokens per user; default `20`                                                                                                                                                                           |
| `USER_RATE_LIMIT_PER_MINUTE`                                                 | server          | Authenticated requests per minute per user on `/` and `/cart`; default `120`                                                                                                                                      |
| `IP_RATE_LIMIT_PER_MINUTE`                                                   | server          | Requests per minute per client IP on each `/auth/*` route and `POST /cart/items`; default `30`                                                                                                                    |
| `SESSION_KEEPALIVE_INTERVAL_MS`                                              | server          | Woolworths login heartbeat; `0` disables; default `21600000`                                                                                                                                                      |
| `ICLOUD_USERNAME`, `ICLOUD_APP_SPECIFIC_PASSWORD`                            | server          | Set both to enable the Reminders sync; the password is generated at appleid.apple.com. See [`architecture.md`](architecture.md)                                                                                   |
| `REMINDERS_LIST_NAME`                                                        | server          | Default `Shopping List`                                                                                                                                                                                           |
| `REMINDERS_SYNC_INTERVAL_MS`                                                 | server          | Default `300000`                                                                                                                                                                                                  |

## Database

The schema is `supabase/migrations/*.sql`. Apply it with the Supabase CLI
(`supabase link --project-ref <ref>` then `supabase db push`, or
`supabase db reset` against the local stack from `supabase start`); the deploy
applies new migrations (see Updating) and the server never migrates. Every table has row level security enabled with no policies,
so only the privileged role in `DATABASE_URL` can read or write; the server is
its only client and the Supabase client keys are not used. Use the pooler
connection string for `DATABASE_URL`: the server does not use prepared
statements, so transaction pooling works.

Tests run against a real Postgres at `TEST_DATABASE_URL` (default
`postgres://postgres@localhost:54329/postgres`), each in its own schema, which
CI provides as a service container.

Sign-in is Google only; see [`auth.md`](auth.md) for the flows and the client
contract. The service is internet-reachable and sign-up is open: any Google
account with a verified email can sign in and gets a user on first sign-in,
bounded by the limits in [`auth.md`](auth.md#limits) (`MAX_USERS` total users,
per-household items and invites, per-user tokens and request rates, and per-IP request rates on `/auth/*`
and `POST /cart/items`); excess requests get `429`. `GET /healthz` is
unauthenticated and backs the Fly health check. The server refuses to start
without the Google variables.

## Google sign-in

One-off setup in [Google Cloud Console](https://console.cloud.google.com/);
`PUBLIC_BASE_URL` below is `https://personal-shopper.willsawyerrrr.dev`.

1. Create or pick a project (top bar, project picker, New Project).
2. APIs & Services, OAuth consent screen (Google Auth Platform, Branding):
   - User type **External** (the only choice for a personal Gmail account;
     **Internal** is available only inside a Google Workspace organisation
     and then needs no test users).
   - App name `Personal Shopper`, your email as support and developer contact.
   - Under Audience, set the publishing status to **In production**. Open
     sign-up needs it: in **Testing** only listed test users (at most 100) can
     sign in, and everyone else is refused by Google. No sensitive or
     restricted scopes are requested: the server asks for `openid email`
     only, so Google's app verification is not required.
   - This server never asks for or stores a Google refresh token (it uses
     Google only to read the verified email at sign-in, then issues its own
     tokens), so Google's 7-day refresh-token expiry for apps in **Testing**
     does not affect it.
3. APIs & Services, Credentials, Create credentials, OAuth client ID:
   - Application type **Web application**, name `Personal Shopper server`.
   - Authorized redirect URIs:
     - `https://personal-shopper.willsawyerrrr.dev/auth/google/callback`
     - `http://localhost:3000/auth/google/callback`
   - No JavaScript origins are needed. Create, then copy the client ID and
     secret.
4. Set them on Fly (the app, not the iOS app or extension, holds the secret):

   ```bash
   fly secrets set \
     GOOGLE_CLIENT_ID=... \
     GOOGLE_CLIENT_SECRET=... \
     PUBLIC_BASE_URL=https://personal-shopper.willsawyerrrr.dev
   ```

   Setting secrets restarts the machine. Add
   `ALLOWED_CLIENT_REDIRECTS=dev.willsawyerrrr.personal-shopper://auth,https://pclllencpcblooaannkgnkncliojdnce.chromiumapp.org/`
   for the Chrome extension (the default covers only the iOS app; the
   extension ID is pinned in `extension/manifest.json`).

5. For local development set the same values in the Personal Shopper Environment with
   `PUBLIC_BASE_URL=http://localhost:3000`, run `pnpm dev` and open
   `http://localhost:3000/`.

Google rejects a redirect URI that differs from a registered one by even a
trailing slash (`redirect_uri_mismatch`); `PUBLIC_BASE_URL` has no path.

## Capture the Woolworths login

On your own machine (Chrome is needed for the one-off registration), with
`DATABASE_URL` and `CREDENTIALS_ENCRYPTION_KEY` set to the production values:

```bash
pnpm install
pnpm register-passkey   # encrypts the passkey and stores it for the owner
pnpm passkey-login      # signs in over plain HTTP and stores the session
```

Each script acts for `--user <email>`, else `REMINDERS_OWNER_EMAIL`; each user
registers their own passkey, or they can register it from the Chrome extension
([`extension/README.md`](../extension/README.md#woolworths-passkey)).

Use `pnpm capture-session` instead of `passkey-login` to pick your Direct to
Boot store in a real browser; it carries the store selection and Akamai
cookies a passkey login lacks.

## First deploy

```bash
fly apps create willsawyerrrr-personal-shopper   # names are global; must match `app` in fly.toml
fly volumes create data --region syd --size 1   # `[mounts]` in fly.toml needs it; holds single-user files to import
fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... PUBLIC_BASE_URL=... DATABASE_URL=... CREDENTIALS_ENCRYPTION_KEY=... ICLOUD_USERNAME=... ICLOUD_APP_SPECIFIC_PASSWORD=... REMINDERS_OWNER_EMAIL=...
fly deploy
```

The passkey and session are stored by the scripts above, straight into the
database, so nothing is uploaded to the machine. To bring over the files of a
single-user deployment instead, put them on the volume at the paths in
`fly.toml`; the next start imports them, and the passkey file needs
`CREDENTIALS_ENCRYPTION_KEY`, which encrypts it.

Restart to import files placed on the volume. `fly machine restart` takes the
machine id from `fly status`:

```bash
fly status
fly machine restart <machine-id>
```

Passkey credentials are secrets: they reach the database only encrypted, the
key is a Fly secret, and `.dockerignore` keeps the single-user files out of the
build context. Without a credential the server still refreshes the session
through the heartbeat but cannot sign back in once `w-aref` is rejected.

Verify with `curl https://willsawyerrrr-personal-shopper.fly.dev/healthz`.

## Custom domain

```bash
fly certs add personal-shopper.willsawyerrrr.dev
```

The zone is on Vercel DNS, whose wildcard `ALIAS` record would otherwise
answer for the subdomain. An explicit record for the subdomain takes
precedence over the wildcard, and a `CNAME` follows Fly's address if it
changes:

```bash
vercel dns add willsawyerrrr.dev personal-shopper CNAME willsawyerrrr-personal-shopper.fly.dev
```

Check `fly certs show personal-shopper.willsawyerrrr.dev` until the
certificate is issued. `PUBLIC_BASE_URL` and the Google redirect URI use this
domain.

## Updating

Merging to `main` deploys the server: `.github/workflows/deploy-server.yml`
runs `flyctl deploy --remote-only` once CI has passed on the merge commit, and
only when it changed server code, the `Dockerfile`, `fly.toml` or the
dependencies. It can also be run by hand from the Actions tab. The rebuilt
image rolls the machine; the data is in the database and persists.

Before deploying, the workflow runs `scripts/apply-migrations.sh`, which
applies every `supabase/migrations/*.sql` the project's migration history lacks
(matched by name, in filename order) through the Supabase Management API, so
the schema is in place before the new image rolls out. Write migrations that
stay compatible with the previous image, which keeps serving until the roll.

The workflow loads `FLY_API_TOKEN` (Personal Shopper Environment; created with
`fly tokens create deploy` from the app's directory) and `SUPABASE_ACCESS_TOKEN` (General
Purpose Environment; a Supabase personal access token). See [Configuration](#configuration) for how CI reaches the Environment.

## Logs

`fly logs` shows one JSON line per request, `request completed`, with
`method`, `url` (path only), `statusCode`, `responseTime` (ms), `userAgent`
and `ip`. `/healthz` checks are logged only at `LOG_LEVEL=debug`.

Every rejected request or sign-in logs one `warn` line, `auth rejected`:

```bash
fly logs | grep '"reason"'
```

Each line carries `reason`, `route`, `method`, `authScheme` (`Bearer`,
`Basic`, `cookie`, `other` or `none`), `tokenLength`,
`hasSurroundingWhitespace` (the token has extra whitespace or a newline; a
common copy-paste mistake), `userAgent`, `ip` and `reqId`, and `detail` for
`login_failed`. Tokens, authorization codes, ID tokens, the Google client
secret, and the `Authorization` and `Cookie` headers are never logged.

| `reason`                | Meaning                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `missing_authorization` | No `Authorization` header and no session cookie.                                                                                                |
| `unsupported_scheme`    | The `Authorization` scheme is not `Bearer`.                                                                                                     |
| `empty_token`           | `Bearer` with no token after it.                                                                                                                |
| `invalid_token`         | Not a token the server issued, or revoked.                                                                                                      |
| `expired_token`         | A server-issued token past its 90 day sliding expiry (30 days for web sessions).                                                                |
| `signup_closed`         | A new Google account tried to sign up while `MAX_USERS` users exist.                                                                            |
| `user_limit`            | A sign-in would exceed the user's `MAX_TOKENS_PER_USER` unexpired tokens.                                                                       |
| `invalid_state`         | The Google callback's `state` is unknown, expired (10 minutes) or already used.                                                                 |
| `login_failed`          | Google sign-in failed; `detail` is `authorization_denied`, `token_exchange_failed`, `invalid_id_token`, `nonce_mismatch` or `email_unverified`. |
| `invalid_request`       | `/auth/start` or `/auth/token` called with missing or malformed parameters, or a redirect URI off the allowlist.                                |
| `invalid_grant`         | `/auth/token` with an unknown, used or expired code, or a wrong `code_verifier`.                                                                |
