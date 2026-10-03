# Authentication

Google is the only way to sign in. The server is the OAuth client of Google
(one Google web OAuth client, authorization code flow with PKCE, scopes
`openid email`); browsers and API clients both sign in through it. Only the
Google accounts in `ALLOWED_EMAILS` are accepted, and the ID token's
`email_verified` must be `true`. Setup is in
[`deployment.md`](deployment.md#google-sign-in).

## Configuration

| Variable                   | Meaning                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GOOGLE_CLIENT_ID`         | Required. Google web OAuth client ID.                                                                                                                        |
| `GOOGLE_CLIENT_SECRET`     | Required. Its secret.                                                                                                                                        |
| `ALLOWED_EMAILS`           | Required. Comma-separated, case-insensitive Google emails allowed to sign in.                                                                                |
| `PUBLIC_BASE_URL`          | Required. Origin the server is reached at, e.g. `https://personal-shopper.willsawyerrrr.dev`. Google redirects to `${PUBLIC_BASE_URL}/auth/google/callback`. |
| `ALLOWED_CLIENT_REDIRECTS` | Comma-separated redirect URIs API clients may use, matched exactly. Default: `dev.willsawyerrrr.personalshopper://auth`.                                     |
| `TOKEN_STORE_PATH`         | JSON file for hashed tokens (default `tokens.json`; `/data/tokens.json` on Fly).                                                                             |

The server refuses to start when a required variable is missing.

`ALLOWED_CLIENT_REDIRECTS` entries:

- iOS app: `dev.willsawyerrrr.personalshopper://auth` (a custom URL scheme).
- Chrome extension: `https://<extension-id>.chromiumapp.org/` (what
  `chrome.identity.getRedirectURL()` returns; add a path argument to it and
  list that exact URL instead). The extension ID is pinned
  by the `key` in `extension/manifest.json`: `pclllencpcblooaannkgnkncliojdnce`.

## Browser sign-in

`/admin/login` shows a "Sign in with Google" button linking to
`GET /auth/google/login`, which redirects to Google. After the callback the
server sets the `ps_admin_session` cookie (`HttpOnly`, `SameSite=Lax`,
`Secure` when `PUBLIC_BASE_URL` is `https`, 30 days) and redirects to
`/admin`. The cookie value is an opaque server-issued token, the same kind
API clients get. "Sign out" on `/admin` revokes it. `/admin` also lists every
active session (web, iOS, extension) with a revoke button.

## API client sign-in

API clients get a bearer token through a code exchange protected by PKCE.
Both steps run over HTTPS.

1. Client creates a random `code_verifier` (43 to 128 characters of
   `A-Za-z0-9-._~`), derives `code_challenge = base64url(SHA-256(code_verifier))`
   without padding, and a random `state`.
2. Client opens the system browser (iOS `ASWebAuthenticationSession`, Chrome
   `chrome.identity.launchWebAuthFlow`) at:

   ```
   GET {PUBLIC_BASE_URL}/auth/start
       ?client=ios|extension
       &redirect_uri=<an ALLOWED_CLIENT_REDIRECTS entry>
       &code_challenge=<S256 challenge, 43 characters>
       &state=<client state, at most 512 characters>
       [&code_challenge_method=S256]
   ```

   Invalid parameters get `400 {"error":"invalid_request"}`; the server never
   redirects to a `redirect_uri` that is not on the allowlist.

3. The user signs in with Google. The server redirects the browser to
   `redirect_uri` with query parameters `state` (the client's, unchanged) and
   either `code` (one-time, valid 60 seconds) or `error`
   (`email_not_allowed` or `login_failed`). The client must check `state`.
4. Client redeems the code:

   ```
   POST {PUBLIC_BASE_URL}/auth/token
   Content-Type: application/json

   {"code": "<code>", "code_verifier": "<code_verifier>"}
   ```

   Success: `200 {"access_token": "ps_...", "expires_at": "<ISO 8601 UTC>"}`
   with `Cache-Control: no-store`. A reused, expired, unknown or mismatched
   code gets `400 {"error":"invalid_grant"}`; every attempt consumes the
   code. A malformed body gets `400 {"error":"invalid_request"}`.

The client stores `access_token` (iOS Keychain, `chrome.storage.local`) and
sends `Authorization: Bearer <access_token>` on every API call.

### Using the token

Bearer tokens authorise the JSON API on `/admin/items`; send
`Accept: application/json`:

| Request                                                                  | Success                                              |
| ------------------------------------------------------------------------ | ---------------------------------------------------- |
| `GET /admin/items`                                                       | `200 {"items":[{word, stockcode, quantity, name?}]}` |
| `POST /admin/items` with `{word, url, name?, quantity?}`                 | `201` with the stored item; `400 {error}` if invalid |
| `DELETE /admin/items/:word` (or `POST /admin/items/:word/delete`)        | `204`                                                |
| `GET /admin` (HTML), `POST /admin/sessions/:id/revoke` (`204` with JSON) | Browser UI and session revocation                    |
| `POST /auth/logout`                                                      | `204`; revokes the presented token                   |

A missing, malformed, expired, revoked or no-longer-allowed token gets
`401 {"error":"unauthorized"}`. On `401` the client discards the token and
starts sign-in again.

### Token lifetime

Tokens are 32 random bytes (`ps_` plus base64url), stored on the server only
as SHA-256 hashes with email, client, created, last-used and expiry. Expiry is
90 days from last use (sliding). The store is a JSON file written atomically
with mode `0600`. Revoke with `POST /auth/logout` or from `/admin`.
Removing an email from `ALLOWED_EMAILS` disables all its tokens at once.

## Failure reasons

Every rejection logs one `warn`, `auth rejected`, with `reason`
(`missing_authorization`, `unsupported_scheme`, `empty_token`,
`invalid_token`, `expired_token`, `email_not_allowed`, `invalid_state`,
`login_failed`, `invalid_request`, `invalid_grant`). Tokens, codes, ID tokens,
secrets, headers and cookies are never logged. See
[`deployment.md`](deployment.md#logs).

## Sign-in checks

The callback accepts a sign-in only if:

- `state` is one the server issued, unexpired (10 minutes) and unused;
- Google's token endpoint accepts the code, the client secret and the server's
  own PKCE verifier;
- the ID token's signature verifies against Google's JWKS (cached, refetched
  on an unknown `kid`) and its `iss`, `aud`, `exp` and `nonce` match;
- `email_verified` is `true` and the lower-cased `email` is in `ALLOWED_EMAILS`.

`/auth/*` routes are rate limited to 30 requests per minute per client IP.
