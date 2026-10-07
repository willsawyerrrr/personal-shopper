# Add item

A Chrome extension, not part of the Fastify service — adds the Woolworths
product page you're currently looking at to `items.yml` via the same
`POST /items` endpoint the web app (`src/admin.ts`) already
exposes, without switching tabs to copy the URL across by hand.

Plain browser-extension JS, no build step, nothing under `src/`. `pnpm lint`
and `pnpm test` cover it (`auth.test.js`: PKCE vector, redirect `state`
check, token exchange; `passkey.test.js`: credential selection, status, API calls and the registration flow against a fake debugger); `typecheck` and `coverage` do not.

## Load it

Run unpacked for development; see [Publishing](#publishing) for the Chrome
Web Store build.

1. `chrome://extensions` → enable Developer Mode → Load unpacked → this
   folder.
2. Click the extension icon → "Options" (or right-click the icon → Options)
   → "Sign in with Google". The access token is stored in
   `chrome.storage.local` — this browser only, never synced to Google. "Sign out" revokes the token on
   the server and discards it.
3. On any `woolworths.com.au/shop/productdetails/...` page, click the icon
   (or press `Ctrl+Shift+Y` / `Cmd+Shift+Y` on Mac — reassign at
   `chrome://extensions/shortcuts` if it clashes with something else). The
   product URL is prefilled; type a
   trigger word and quantity, then submit. Signed out, the popup shows a
   "Sign in with Google" button instead; a `401` from the server signs you
   out.
4. "Manage items" at the bottom of the popup opens `/` on the
   server in a new tab.

The popup and options page follow the system light or dark theme
(`prefers-color-scheme`), using the same colours as the web app.

## Household

Below the passkey, the options page shows the household (members who share
your items and Woolworths account). "Create invite code" shows a single-use
code, valid 24 hours, to give to someone; "Join household" takes a code
(discarding your items if nobody else is in your household); "Leave household"
appears once there is more than one member. It calls `/household*` with
the bearer token (`household-api.js`, `household.test.js`).

## Woolworths passkey

The options page registers the passkey the server signs in to Woolworths with
when its session expires, without the CLI. Needs a Google
sign-in, and `CREDENTIALS_ENCRYPTION_KEY` set on the server.

1. Options → "Register passkey", or the web app's Account page button, which opens the options page with `?register=1` and starts registration there. The extension opens a new Incognito window
   at the Woolworths login (password managers are normally off there, so they
   cannot answer the passkey prompt) and attaches a virtual authenticator to
   its tab with `chrome.debugger` (CDP `WebAuthn.enable` and
   `addVirtualAuthenticator`: ctap2, internal, resident key, user verified).
   Chrome shows its "started debugging this browser" bar while it is attached.
2. Log in to Woolworths in that window and accept the prompt to create a passkey.
3. The extension polls `WebAuthn.getCredentials`, uploads the first credential
   for `auth.woolworths.com.au` with `PUT /woolworths/passkey`, then removes the
   authenticator, detaches and closes the window. It times out after 10 minutes.
   The server signs in with the credential at once and replaces the household's
   stored Woolworths session; a failed sign-in is reported as the upload's error.

Incognito needs a one-time step: `chrome://extensions` → this extension's
Details → "Allow in Incognito". Until it is on, the options page shows an
"Open extension settings" button (`chrome.tabs.create` on
`chrome://extensions/?id=<id>`; Chrome has no API to request the access) and a
"Continue in a normal window" button that registers in an ordinary tab
instead. When the options page regains focus it re-checks the access; once on,
it shows "Incognito access enabled — press Register passkey" and waits for the
button, since registration opens a window and attaches the debugger. The manifest keeps the default `incognito: "spanning"`, so the one
service worker drives the Incognito window and shares the signed-in state in
`chrome.storage`; no extra permission is needed (`chrome.extension.isAllowedIncognitoAccess()`
and `chrome.windows` need none).

If Chrome shows its own "Choose where to save your passkey" dialog instead,
something in the profile (a password manager or other passkey-capable
extension) answered the request before the virtual authenticator did, and
nothing is uploaded. This happens in a normal window when such an extension is
on; allow Incognito for this extension (and keep the other one off there) or
turn its passkey handling off.

"Cancel" (or dismissing the debugging bar, or closing the window or tab) stops
the registration and does the same cleanup, closing the Incognito window. A failure is shown on the options page.
The options page removes `?register=1` from its URL on load, so a reload does
not register again, and starts registration unless you are signed out, a
registration is already running, or Incognito access is off (it then shows the
Incognito help instead; "Continue in a normal window" stays an explicit choice)
(`decideAutoRegister` in `passkey-logic.js`).
Once registered the page offers "Replace passkey" and "Remove passkey"
(`DELETE /woolworths/passkey`); the web app's Account page shows the registration too and can remove it.

The registration runs in the extension's service worker (`background.js`),
which keeps going when the options page closes; the logic is in
`passkey-logic.js`, `passkey-api.js`, `passkey-window.js` and `passkey-flow.js` (`passkey.test.js`).

## Sign-in

The extension uses the server's API client flow ([`docs/auth.md`](../docs/auth.md#api-client-sign-in)):
`chrome.identity.launchWebAuthFlow` opens `/auth/start` with a PKCE S256
challenge and a random `state` (both generated with WebCrypto and checked on
return), then `POST /auth/token` redeems the code for a bearer token sent as
`Authorization: Bearer <token>` on `POST /items`. The options page shows
when the session expires.

### Extension ID and redirect URI

The server only redirects to URIs in `ALLOWED_CLIENT_REDIRECTS`, so the
unpacked extension's ID must not change. `manifest.json` carries a `key`
(public key) that pins it to `pclllencpcblooaannkgnkncliojdnce`; the redirect URI is
`https://pclllencpcblooaannkgnkncliojdnce.chromiumapp.org/`. Set on Fly:

```
ALLOWED_CLIENT_REDIRECTS=dev.willsawyerrrr.personal-shopper://auth,https://pclllencpcblooaannkgnkncliojdnce.chromiumapp.org/
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
- `debugger` — attach a virtual authenticator to the Woolworths login tab (in
  an Incognito window when allowed) you open from the options page, only while
  registering a passkey.
- `identity` — `chrome.identity.launchWebAuthFlow` and `getRedirectURL` for
  Google sign-in through the server.
- `storage` — save your access token locally.
- Content script `web-app.js` on the hosted web app's origin, covered by the
  host permission below (no extra warning). It marks the page
  (`data-extension-installed` on `<html>`) so the Account page can show its
  "Register passkey" button, and relays that button's click to the service
  worker. The worker accepts the message only from a tab on the hosted origin
  and opens `options.html?register=1` in a new tab, or navigates and focuses an
  already-open options tab (`options-tab.js`). The page needs no extension ID, so it
  works for the unpacked and the Web Store IDs alike. A local dev server is not
  covered; add its origin to `content_scripts[].matches` to try it.
- `host_permissions` — required for the popup's and options page's `fetch` to
  reach the server; this server sets no CORS headers. `https://*.willsawyerrrr.dev/*`
  covers the deployed server.
  `https://*.woolworths.com.au/*` covers the Woolworths login tab.

## Publishing

Submitted to the Chrome Web Store as an unlisted item. Listing copy,
permission justifications and the screenshot checklist are in
[`store/listing.md`](store/listing.md); the privacy policy is served at
`/privacy` (`src/privacy.ts`).

1. Bump `version` in `manifest.json` (the store rejects a repeated version).
2. `pnpm run package-extension` writes `dist/extension.zip`: the runtime files
   only, with the `key` dropped and `host_permissions` narrowed to the hosted
   server and `https://*.woolworths.com.au/*`. CI attaches the same zip as the
   `extension` artifact on runs touching `extension/**`.
3. In the [developer dashboard](https://chrome.google.com/webstore/devconsole)
   add a new item, upload the zip, fill in the listing from `store/listing.md`,
   set the privacy policy URL, set visibility to Unlisted and submit.
4. After the first upload, copy the store-assigned extension ID and add
   `https://<id>.chromiumapp.org/` to `ALLOWED_CLIENT_REDIRECTS` on Fly,
   keeping the unpacked ID's entry. Google OAuth needs no change: Google
   redirects to the server, not the extension.

## What this doesn't cover

- No product search — same constraint as the web app. You still need
  to already be on the product's page.
- No feedback beyond "Added." / "Failed (\<status\>)" in the popup — check
  `/` if you want to confirm what actually landed in `items.yml`.
- A non-Woolworths-product-page tab hides the form and offers a button to
  open woolworths.com.au in a new tab instead of showing a disabled form.
