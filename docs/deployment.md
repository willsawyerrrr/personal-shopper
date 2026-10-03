# Deployment

Production runs on [Fly.io](https://fly.io) as a single always-on machine
(`fly.toml`: `syd`, `shared-cpu-1x`, 256 MB) behind Fly's HTTPS proxy, so the
Shortcut reaches it from any network. The image (`Dockerfile`) holds
production dependencies only and no browser; the Woolworths login is plain
HTTP. The server process runs unprivileged: `docker-entrypoint.sh` hands the
`/data` volume to the `node` user, then drops root.

Local development uses the same code: `pnpm dev`, then `POST /items` and
`/admin` against `localhost`.

## What lives where

- Secrets (`fly secrets set`): `SHARED_SECRET`, and optionally
  `ICLOUD_USERNAME` / `ICLOUD_APP_SPECIFIC_PASSWORD` for the
  [Reminders queue](architecture.md#reminders-offline-queue).
- Config (`fly.toml` `[env]`): `PORT`, `TRUST_PROXY=true` (rate limiting keys
  on the client IP from `X-Forwarded-For`), and the three data paths below.
- Volume `data` mounted at `/data`: `items.yml`, `session.json` (rewritten as
  the login refreshes) and `passkey-credentials.json`. A missing `items.yml`
  reads as no mappings; add them through `/admin`.

`SHARED_SECRET` gates the bearer-authed `/items` webhook and the `/admin` UI
(login form at `/admin/login`; store it in a password manager). The service
is internet-reachable, so use a long random value (`openssl rand -hex 32`).
`/items` allows 30 requests per minute and `/admin/login` 10 per minute per
client IP; excess requests get `429`. `GET /healthz` is unauthenticated and
backs the Fly health check.

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
fly secrets set SHARED_SECRET=... ICLOUD_USERNAME=... ICLOUD_APP_SPECIFIC_PASSWORD=...
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
certificate is issued. Point the Shortcut at
`https://personal-shopper.willsawyerrrr.dev/items`.

## Updating

`fly deploy` rebuilds the image and rolls the machine; the volume, and so the
items and session, persist. Logs: `fly logs`.
