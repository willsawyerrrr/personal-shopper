# Authentication

Google is the only way to sign in. The server is the OAuth client of Google
(one Google web OAuth client, authorization code flow with PKCE, scopes
`openid email`); browsers and API clients both sign in through it. The
ID token's `email_verified` must be `true`, and then any Google account may
sign in: the first sign-in creates its user. Abuse is bounded by
[limits](#limits). Setup is in [`deployment.md`](deployment.md#google-sign-in).

## Configuration

| Variable                     | Meaning                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GOOGLE_CLIENT_ID`           | Required. Google web OAuth client ID.                                                                                                                        |
| `GOOGLE_CLIENT_SECRET`       | Required. Its secret.                                                                                                                                        |
| `PUBLIC_BASE_URL`            | Required. Origin the server is reached at, e.g. `https://personal-shopper.willsawyerrrr.dev`. Google redirects to `${PUBLIC_BASE_URL}/auth/google/callback`. |
| `ALLOWED_CLIENT_REDIRECTS`   | Comma-separated redirect URIs API clients may use, matched exactly. Default: `dev.willsawyerrrr.personal-shopper://auth`.                                    |
| `DATABASE_URL`               | Required. Postgres connection string; hashed tokens live in its `tokens` table.                                                                              |
| `CREDENTIALS_ENCRYPTION_KEY` | Encrypts stored passkey credentials; required once any exists. See [`architecture.md`](architecture.md#data).                                                |
| `REMINDERS_OWNER_EMAIL`      | The user the Reminders sync, single-user file import and `scripts/` act for. Required when the Reminders sync is enabled.                                    |

The server refuses to start when a required variable is missing.

### Limits

Each limit has a default and an environment variable; all are positive
integers.

| Variable                     | Default | Meaning                                                                                                         |
| ---------------------------- | ------- | --------------------------------------------------------------------------------------------------------------- |
| `MAX_USERS`                  | 50      | Total users. Beyond it a new Google account cannot sign up (`signup_closed`); existing users are unaffected.    |
| `MAX_INVITES_PER_HOUSEHOLD`  | 5       | Unexpired household invites at once. `POST /household/invites` beyond it gets `409`.                            |
| `MAX_TOKENS_PER_USER`        | 20      | Unexpired tokens (web sessions and API clients) a user may hold. A sign-in beyond it is refused (`user_limit`). |
| `USER_RATE_LIMIT_PER_MINUTE` | 120     | Authenticated requests per minute per user on `/` and `/cart`; excess gets `429 {"error":"rate_limited"}`.      |
| `IP_RATE_LIMIT_PER_MINUTE`   | 30      | Requests per minute per client IP on each `/auth/*` route and on `POST /cart/items`; excess gets `429`.         |

A user revokes a sign-in from `/` to free a token slot.

`ALLOWED_CLIENT_REDIRECTS` entries:

- iOS app: `dev.willsawyerrrr.personal-shopper://auth` (a custom URL scheme).
- Chrome extension: `https://<extension-id>.chromiumapp.org/` (what
  `chrome.identity.getRedirectURL()` returns; add a path argument to it and
  list that exact URL instead). The extension ID is pinned
  by the `key` in `extension/manifest.json`: `pclllencpcblooaannkgnkncliojdnce`.

## Browser sign-in

`/login` shows a "Sign in with Google" button linking to
`GET /auth/google/login`, which redirects to Google. After the callback the
server sets the `ps_admin_session` cookie (`HttpOnly`, `SameSite=Lax`,
`Secure` when `PUBLIC_BASE_URL` is `https`, 30 days) and redirects to
`/`. The cookie value is an opaque server-issued token, the same kind
API clients get. "Sign out" on `/` revokes it. `/` also lists the signed-in
user's own active sessions (web, iOS, extension) with a revoke button; a user
cannot revoke another user's.

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
   (`signup_closed`, `user_limit` or `login_failed`). The client must check
   `state`.
4. Client redeems the code:

   ```
   POST {PUBLIC_BASE_URL}/auth/token
   Content-Type: application/json

   {"code": "<code>", "code_verifier": "<code_verifier>"}
   ```

   Success: `200 {"access_token": "ps_...", "expires_at": "<ISO 8601 UTC>"}`
   with `Cache-Control: no-store`. A reused, expired, unknown or mismatched
   code gets `400 {"error":"invalid_grant"}`; every attempt consumes the
   code. A malformed body gets `400 {"error":"invalid_request"}`. A user at
   their token cap gets `403 {"error":"user_limit"}`.

The client stores `access_token` (iOS Keychain, `chrome.storage.local`) and
sends `Authorization: Bearer <access_token>` on every API call.

### Using the token

Bearer tokens authorise the JSON API on `/items`; send
`Accept: application/json`. Every call acts on the token's user and their
household: members share items, and `POST /cart/items` adds to the household's
Woolworths cart.

| Request                                                      | Success                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `GET /items`                                                 | `200 {"items":[{word, stockcode, quantity, listing?, name?}]}`                 |
| `POST /items` with `{word, url, quantity?, name?}`           | `201` with the stored item; `400 {error}` if invalid                           |
| `PATCH /items/:word` with any of the fields below            | `200` with the stored item; `400`, `404`, `409` below                          |
| `DELETE /items/:word` (or `POST /items/:word/delete`)        | `204`                                                                          |
| `PATCH /products/:stockcode/:quantity` with fields below     | `200 {words, stockcode, quantity, listing?, name?}`; `400`, `404`, `409` below |
| `DELETE /products/:stockcode/:quantity` (or `POST …/delete`) | `204`; `404` for an unknown product                                            |
| `GET /household`                                             | `200 {"members":[{email, you}]}`                                               |
| `POST /household/invites`                                    | `201 {code, expiresAt}` (epoch ms); `409 {error}` at the invite limit          |
| `POST /household/join` with `{code}`                         | `204`; `400 {error}` invalid, expired or used; `409 {error}` already a member  |
| `POST /household/leave`                                      | `204`; `409 {error}` for a sole member                                         |
| `POST /auth/logout`                                          | `204`; revokes the presented token                                             |

`PATCH /items/:word` changes only the fields sent, keeps every other entry and the item's position
in the user's list, and saves atomically. `:word` is normalised like
`word` on `POST`.

| Field       | Meaning                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| `word`      | New trigger phrase, trimmed and lower-cased                                     |
| `url`       | Product URL or stockcode, parsed like `POST`; takes precedence over `stockcode` |
| `stockcode` | Positive integer                                                                |
| `quantity`  | Positive integer                                                                |
| `name`      | Display name, trimmed, at most 80 characters; blank clears it (`400` if longer) |

`listing` is the product's title as shown on woolworths.com.au (for example
`Maleny Dairies Full Cream 2L`), shown as the product's title. It is
read-only: the server looks it up when an item is added and when its
stockcode changes, and clients cannot set it. It is absent when the lookup
failed or has not run yet; a failed lookup never fails the request. Items
stored without one are filled in by a background pass at startup and after
any `GET /items` or `GET /`, so a later list contains it.

| Status | Body                                                            |
| ------ | --------------------------------------------------------------- |
| `400`  | `{"error":"<message>"}`: a field is invalid; nothing is written |
| `404`  | `{"error":"<message>"}`: no item for `:word`                    |
| `409`  | `{"error":"<message>"}`: `word` is already used by another item |

`name` is the household's own name for a product. It belongs to the product: a
write sets it on every word sharing the stockcode and quantity, `POST /items`
gives a word added to a named product that product's name, and it is absent
when unset.

Items are stored per trigger word, in order, and `GET /items` lists them that
way. A product is the set of words sharing a stockcode and quantity;
clients list one row per product, titled with its `name` (else its `listing`,
else the first word) and the `listing` beneath a `name`, with the words beneath it display-cased (`Full Cream Milk`, `Coca-Cola`;
display only, the stored words stay lower-case). `POST /items` with a
stockcode and quantity an existing product has adds the word to that product.

`PATCH /products/:stockcode/:quantity` (browser form:
`POST /products/:stockcode/:quantity/edit`) edits the whole product at once and
saves atomically. It takes the fields of `PATCH /items/:word` except `word`,
plus `words`, an array (or comma-separated string) that replaces the product's
whole word set: absent words are removed, new ones are added after the
product's last word. Changing the stockcode or quantity to another product's
merges the two. The statuses are those above, with `404` for an unknown product
and `409` when a word belongs to a different product. Deleting a product
removes all its words.

Browser form edits answer the same statuses by re-rendering `/` with the
message, and redirect to `/` on success. They rely on the session
cookie's `SameSite=Lax`, like the other form posts.

### Adding to the cart

`POST /cart/items` adds the product mapped to a spoken phrase to the
Woolworths cart. It accepts a bearer token only (the web session cookie is
rejected) and is rate limited per client IP (`IP_RATE_LIMIT_PER_MINUTE`) and per
user (`USER_RATE_LIMIT_PER_MINUTE`).

```
POST {PUBLIC_BASE_URL}/cart/items
Authorization: Bearer <access_token>
Content-Type: application/json

{"item": "milk"}
```

| Status | Body                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------- |
| `200`  | `{"item": "<phrase as sent>", "stockcode": 123456, "quantity": 1}`; the item is in the cart    |
| `400`  | `{"error":"item is required"}`: `item` is missing, not a string or blank                       |
| `401`  | `{"error":"unauthorized"}`                                                                     |
| `404`  | `{"error":"no mapping configured for \"<item>\""}`: no item for the phrase in the user's items |
| `429`  | `{"error":"rate_limited"}`: over a rate limit; `Retry-After` gives the seconds to wait         |
| `502`  | `{"error":"<message>"}`: the Woolworths session is expired or rejected                         |

The phrase is matched against the user's items like a reminder title: trimmed,
lower-cased, exact.

A missing, malformed, expired or revoked token gets
`401 {"error":"unauthorized"}`. On `401` the client discards the token and
starts sign-in again.

### Pickup arrival

`POST /pickup/en-route` and `POST /pickup/arrived` tell Woolworths a Direct to
boot customer is on their way, or has parked in a bay. Both accept a bearer
token only and share `/cart/items`' rate limits. `link` is the
`https://myorder.woolworths.com.au/pickup/order?token=<uuid>` link from the
ready-order SMS or email.

```
POST {PUBLIC_BASE_URL}/pickup/en-route
Authorization: Bearer <access_token>
Content-Type: application/json

{"link": "https://myorder.woolworths.com.au/pickup/order?token=<uuid>", "latitude": -33.8688, "longitude": 151.2093}
```

`POST /pickup/arrived` takes `{"link": "..."}` only.

| Status | Body                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| `200`  | `{"statusTitle", "statusDescription", "collectionMethod"}`: the order's status after the call              |
| `400`  | `{"error":"link is required"}` or `{"error":"latitude and longitude are required"}` (finite, within range) |
| `401`  | `{"error":"unauthorized"}`                                                                                 |
| `422`  | `{"error":"..."}`: not a Woolworths pickup link, or Woolworths says it is invalid or expired               |
| `429`  | `{"error":"rate_limited"}`: over a rate limit; `Retry-After` gives the seconds to wait                     |
| `502`  | `{"error":"<message>"}`: Woolworths failed or answered unexpectedly                                        |

### Registering a Woolworths passkey

`/woolworths/passkey` stores the Woolworths passkey the server signs in with
for the user the token belongs to. It accepts a bearer token only (the web
session cookie is rejected), is rate limited to 10 requests per minute per
client IP, and exists only when `CREDENTIALS_ENCRYPTION_KEY` is set (otherwise
it answers `404`). The credential is never logged.

```
PUT {PUBLIC_BASE_URL}/woolworths/passkey
Authorization: Bearer <access_token>
Content-Type: application/json

{"credentialId": "…", "rpId": "auth.woolworths.com.au", "privateKey": "…", "userHandle": "…", …}
```

The body is a credential as returned by CDP `WebAuthn.getCredentials` (the
Chrome extension) or built by the iOS app's software authenticator, or an
array of them, of which the first usable entry is stored. A credential is
usable when its `rpId` is `auth.woolworths.com.au`, `credentialId`,
`userHandle` and `privateKey` are non-empty strings, and `privateKey` is a
base64 PKCS#8 Ed25519, EC or RSA key. It replaces any stored credential, then
signs in to Woolworths with it at once and replaces the household's stored
session with the result, so carts are driven by the new account straight away.
If that sign-in fails, the credential stays saved but the household's stored
session is deleted (the old account never keeps driving the cart) and the
response is `502`; registering again retries. `DELETE` removes the credential
and deletes the household's stored session.

| Method   | Success                                       |
| -------- | --------------------------------------------- |
| `PUT`    | `200 {"registered": true}`                    |
| `GET`    | `200 {"registered": <whether one is stored>}` |
| `DELETE` | `200 {"registered": false}`                   |

| Status | Body                                                                               |
| ------ | ---------------------------------------------------------------------------------- |
| `400`  | `{"error":"<message>"}`: the body has no usable credential                         |
| `401`  | `{"error":"unauthorized"}`                                                         |
| `502`  | `{"error":"<message>"}`: `PUT` stored the credential but signing in with it failed |

The iOS app (Settings > Woolworths passkey) registers, replaces and removes it
with this endpoint too. `/account` shows whether the signed-in user has a passkey registered, a button
that opens the extension's options page to register or replace it and, when one
is registered, a "Remove passkey" button (`POST /account/passkey/remove`, session
cookie, same rate limit and effect as `DELETE`) that redirects back to
`/account`. Like the other form posts it relies on the cookie's
`SameSite=Lax` and does not ask for confirmation.

### Token lifetime

Tokens are 32 random bytes (`ps_` plus base64url), stored on the server only
as SHA-256 hashes with email, client, created, last-used and expiry in the
`tokens` table. Expiry is 90 days from last use (sliding). Revoke with `POST /auth/logout` or from `/`.

## Failure reasons

Every rejection logs one `warn`, `auth rejected`, with `reason`
(`missing_authorization`, `unsupported_scheme`, `empty_token`,
`invalid_token`, `expired_token`, `signup_closed`, `user_limit`, `invalid_state`,
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
- `email_verified` is `true`;
- the lower-cased `email` belongs to an existing user, or there are fewer than
  `MAX_USERS` users, in which case the user is created in a household of
  their own.

`/auth/*` routes are rate limited per client IP (`IP_RATE_LIMIT_PER_MINUTE`).
