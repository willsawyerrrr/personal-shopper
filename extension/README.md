# Add item

A Chrome extension, not part of the Fastify service — adds the Woolworths
product page you're currently looking at to `items.yml` via the same
`POST /admin/items` endpoint the web admin UI (`src/admin.ts`) already
exposes, without switching tabs to copy the URL across by hand.

Plain browser-extension JS, no build step, nothing under `src/`. `pnpm lint`
and `pnpm test` cover it (`auth.test.js`: PKCE vector, redirect `state`
check, token exchange; `passkey.test.js`: credential selection, status, API calls and the registration flow against a fake debugger); `typecheck` and `coverage` do not.

## Load it

Distributed as an unpacked extension rather than through the Chrome Web
Store — no developer account, fee, or public listing needed for something
this small and single-user.

1. `chrome://extensions` → enable Developer Mode → Load unpacked → this
   folder.
2. Click the extension icon → "Options" (or right-click the icon → Options)
   → set your server URL (`https://personal-shopper.willsawyerrrr.dev`, or
   `http://localhost:3000` for local dev), Save, then "Sign in with Google".
   The server URL and the access token are stored in `chrome.storage.local` —
   this browser only, never synced to Google. "Sign out" revokes the token on
   the server and discards it.
3. On any `woolworths.com.au/shop/productdetails/...` page, click the icon
   (or press `Ctrl+Shift+Y` / `Cmd+Shift+Y` on Mac — reassign at
   `chrome://extensions/shortcuts` if it clashes with something else). The
   product URL is prefilled; type a
   trigger word and quantity, then submit. Signed out, the popup shows a
   "Sign in with Google" button instead; a `401` from the server signs you
   out.
4. "Manage items" at the bottom of the popup opens `/admin` on your
   configured server in a new tab, once a server URL is set.

## Woolworths passkey

The options page registers the passkey the server signs in to Woolworths with
when its session expires, without the CLI. Needs the server URL, a Google
sign-in, and `CREDENTIALS_ENCRYPTION_KEY` set on the server.

1. Options → "Register passkey". The extension opens a new tab at the
   Woolworths login and attaches a virtual authenticator to it with
   `chrome.debugger` (CDP `WebAuthn.enable` and `addVirtualAuthenticator`: ctap2,
   internal, resident key, user verified). Chrome shows its "started debugging
   this browser" bar while it is attached.
2. Log in to Woolworths in that tab and accept the prompt to create a passkey.
3. The extension polls `WebAuthn.getCredentials`, uploads the first credential
   for `auth.woolworths.com.au` with `PUT /woolworths/passkey`, then removes the
   authenticator and detaches. It times out after 10 minutes.

"Cancel" (or dismissing the debugging bar, or closing the tab) stops the
registration and does the same cleanup. A failure is shown on the options page.
Once registered the page offers "Replace passkey" and "Remove passkey"
(`DELETE /woolworths/passkey`); `/admin` shows the registration too.

The registration runs in the extension's service worker (`background.js`),
which keeps going when the options page closes; the logic is in
`passkey-logic.js`, `passkey-api.js` and `passkey-flow.js` (`passkey.test.js`).

## Sign-in

The extension uses the server's API client flow ([`docs/auth.md`](../docs/auth.md#api-client-sign-in)):
`chrome.identity.launchWebAuthFlow` opens `/auth/start` with a PKCE S256
challenge and a random `state` (both generated with WebCrypto and checked on
return), then `POST /auth/token` redeems the code for a bearer token sent as
`Authorization: Bearer <token>` on `POST /admin/items`. The options page shows
when the session expires.

### Extension ID and redirect URI

The server only redirects to URIs in `ALLOWED_CLIENT_REDIRECTS`, so the
unpacked extension's ID must not change. `manifest.json` carries a `key`
(public key) that pins it to `pclllencpcblooaannkgnkncliojdnce`; the redirect URI is
`https://pclllencpcblooaannkgnkncliojdnce.chromiumapp.org/`. Set on Fly:

```
ALLOWED_CLIENT_REDIRECTS=dev.willsawyerrrr.personalshopper://auth,https://pclllencpcblooaannkgnkncliojdnce.chromiumapp.org/
```

The matching private key was discarded; it is not needed to load or run the
extension. Re-pinning means generating a new key pair, putting the new public
key in `manifest.json`, and updating `ALLOWED_CLIENT_REDIRECTS` with the new
ID (the first 32 hex characters of the SHA-256 of the DER public key, each
digit mapped `0-9a-f` to `a-p`).

## Permissions

- `activeTab` — read the current tab's URL only when you open the popup, to
  prefill the form. No `tabs`, no broad host access
  to browse tabs you haven't opened the popup on.
- `debugger` — attach a virtual authenticator to the Woolworths login tab you
  open from the options page, only while registering a passkey.
- `identity` — `chrome.identity.launchWebAuthFlow` and `getRedirectURL` for
  Google sign-in through the server.
- `storage` — save your server URL and access token locally.
- `host_permissions` — required for the popup's and options page's `fetch` to
  reach the server; this server sets no CORS headers. `https://*.willsawyerrrr.dev/*`
  covers the deployed server and `http://*/*` a local dev server.
  `https://*.woolworths.com.au/*` covers the Woolworths login tab.

## What this doesn't cover

- No product search — same constraint as the web admin UI. You still need
  to already be on the product's page.
- No feedback beyond "Added." / "Failed (\<status\>)" in the popup — check
  `/admin` if you want to confirm what actually landed in `items.yml`.
- A non-Woolworths-product-page tab hides the form and offers a button to
  open woolworths.com.au in a new tab instead of showing a disabled form.
