# Deployment

Production runs on [Fly.io](https://fly.io) as a single always-on machine
(`fly.toml`: `syd`, `shared-cpu-1x`, 256 MB) behind Fly's HTTPS proxy, so the
iOS app, Chrome extension and browser reach it from any network. The image (`Dockerfile`) holds
production dependencies only and no browser; the Woolworths login is plain
HTTP. The server process runs unprivileged: `docker-entrypoint.sh` hands the
`/data` volume to the `node` user, then drops root.

Local development uses the same code: `pnpm dev`, then `/admin` against
`localhost` (Google sign-in needs `http://localhost:3000/auth/google/callback`
registered, below).

## What lives where

- Secrets (`fly secrets set`): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
  `ALLOWED_EMAILS`, `PUBLIC_BASE_URL`, optionally `ALLOWED_CLIENT_REDIRECTS`,
  and optionally `ICLOUD_USERNAME` / `ICLOUD_APP_SPECIFIC_PASSWORD` for the
  [Reminders queue](architecture.md#reminders-queue).
- Config (`fly.toml` `[env]`): `PORT`, `TRUST_PROXY=true` (rate limiting keys
  on the client IP from `X-Forwarded-For`), and the four data paths below.
- Volume `data` mounted at `/data`: `items.yml`, `session.json` (rewritten as
  the login refreshes), `passkey-credentials.json` and `tokens.json` (hashed
  bearer tokens and admin sessions). A missing `items.yml` reads as no
  mappings; add them through `/admin`.

Sign-in is Google only; see [`auth.md`](auth.md) for the flows and the client
contract. The service is internet-reachable: only the accounts in
`ALLOWED_EMAILS` can sign in, and the `/auth/*` routes allow 30 requests per
minute per client IP; excess requests get `429`. `GET /healthz` is
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
   - Leave the publishing status **Testing** and add your email (every
     account in `ALLOWED_EMAILS`) under Audience, Test users. Only test users
     can sign in while testing. No sensitive scopes are requested: the
     server asks for `openid email` only, so verification is never required.
   - Testing mode expires refresh tokens after 7 days. This server never
     asks for or stores a Google refresh token (it uses Google only to read
     your verified email at sign-in, then issues its own tokens), so that
     limit does not affect it.
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
     ALLOWED_EMAILS=you@gmail.com \
     PUBLIC_BASE_URL=https://personal-shopper.willsawyerrrr.dev
   ```

   Setting secrets restarts the machine. Add
   `ALLOWED_CLIENT_REDIRECTS=dev.willsawyerrrr.personalshopper://auth,https://pclllencpcblooaannkgnkncliojdnce.chromiumapp.org/`
   for the Chrome extension (the default covers only the iOS app; the
   extension ID is pinned in `extension/manifest.json`).

5. For local development put the same values in `.env` with
   `PUBLIC_BASE_URL=http://localhost:3000`, run `pnpm dev` and open
   `http://localhost:3000/admin`.

Google rejects a redirect URI that differs from a registered one by even a
trailing slash (`redirect_uri_mismatch`); `PUBLIC_BASE_URL` has no path.

## Capture the Woolworths login

On your own machine (Chrome is needed for the one-off registration):

```bash
pnpm install
pnpm register-passkey   # saves passkey-credentials.json
pnpm passkey-login      # writes session.json over plain HTTP
```

Use `pnpm capture-session` instead of `passkey-login` to pick your Direct to
Boot store in a real browser; it carries the store selection and Akamai
cookies a passkey login lacks.

## First deploy

```bash
fly apps create willsawyerrrr-personal-shopper   # names are global; must match `app` in fly.toml
fly volumes create data --region syd --size 1
fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... ALLOWED_EMAILS=... PUBLIC_BASE_URL=... ICLOUD_USERNAME=... ICLOUD_APP_SPECIFIC_PASSWORD=...
fly deploy
```

Upload the passkey credentials to the volume. `sftp` creates the file
root-owned with mode 0644, so hand it to the server user and lock it down:

```bash
fly ssh sftp shell
> put passkey-credentials.json /data/passkey-credentials.json
> exit
fly ssh console -C "chown node:node /data/passkey-credentials.json"
fly ssh console -C "chmod 600 /data/passkey-credentials.json"
```

Create `session.json` on the machine itself by signing in with those
credentials as `node`, so it is owned correctly (uploading a local
`session.json` with `put` also works, followed by the same `chown`):

```bash
fly ssh console -C "su node -s /bin/sh -c \"node --input-type=module -e \\\"import { passkeyLogin } from '/app/dist/src/woolworths/passkey.js'; import { SessionStore } from '/app/dist/src/woolworths/session.js'; await new SessionStore('/data/session.json').save(await passkeyLogin('/data/passkey-credentials.json'))\\\"\"\""
```

Restart so the server picks up the session. `fly machine restart` takes the
machine id from `fly status`:

```bash
fly status
fly machine restart <machine-id>
```

`passkey-credentials.json` is a secret: it is uploaded over SSH rather than
baked into the image or set as an env var, and `.dockerignore` keeps it and
`session.json` out of the build context. Without it the server still
refreshes the session through the heartbeat but cannot sign back in once
`w-aref` is rejected.

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

`fly deploy` rebuilds the image and rolls the machine; the volume, and so the
items and session, persist.

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
| `email_not_allowed`     | A sign-in, or a token's account, not in `ALLOWED_EMAILS`.                                                                                       |
| `invalid_state`         | The Google callback's `state` is unknown, expired (10 minutes) or already used.                                                                 |
| `login_failed`          | Google sign-in failed; `detail` is `authorization_denied`, `token_exchange_failed`, `invalid_id_token`, `nonce_mismatch` or `email_unverified`. |
| `invalid_request`       | `/auth/start` or `/auth/token` called with missing or malformed parameters, or a redirect URI off the allowlist.                                |
| `invalid_grant`         | `/auth/token` with an unknown, used or expired code, or a wrong `code_verifier`.                                                                |
