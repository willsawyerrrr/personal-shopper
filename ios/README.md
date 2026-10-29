# iOS app

Native SwiftUI client for the server's JSON API (`src/admin.ts`): list, add,
edit and remove items, plus a Share extension and an App Intent that add a
Woolworths product without opening the web app.

- **App** (`App/`): Items tab (a cart button opens the Woolworths app,
  or its website when the app isn't installed; one row per product, titled with its
  custom name (else its Woolworths listing), the listing beneath a custom
  name, then its trigger words, pull to refresh, tap a
  row to edit its name, trigger phrases (add one at a time; remove with swipe or
  Edit, keeping at least one), quantity and product link or stockcode,
  swipe to delete a product with all its words, add by pasted URL), Pickup tab
  (tell Woolworths you're on your way or have parked) and Settings tab (Sign
  out, test connection, Woolworths passkey, and Household: members, create and
  share an invite code, join with a code, leave).
- **Share extension** (`ShareExtension/`): appears in the iOS share sheet for
  URLs and text. Hands a pickup link to the Pickup tab (below); otherwise pulls the `woolworths.com.au/shop/productdetails/<stockcode>`
  link out of what was shared, shows trigger word and quantity, then
  calls the API.
- **App Intent** (`App/AddItemIntent.swift`): `AddItemIntent` for Shortcuts
  and Siri, taking a product URL plus optional trigger word and quantity. The
  word defaults to the lower-cased product name in the link.
- **`AddToCartIntent`** (`App/AddItemIntent.swift`): the voice path. Takes a
  required `item` ("What do you want to add?"), calls `POST /cart/items` and
  speaks the result, e.g. "Added 2 × Milk" or the server's "no mapping
  configured" message. Runs in the background without opening the app.
- **`AddManyToCartIntent`** (`App/AddItemIntent.swift`): the same, repeated.
  After "What do you want to add?" it adds each answer, speaks the result and
  asks "What next?" until the answer is "that's it", "done" or similar
  (`DoneSpeech`).
- **`Packages/PersonalShopperKit`**: API client, PKCE and sign-in, Keychain and
  settings storage, product URL parsing and the add-item form, shared by all
  of the above.

## Signing in

Google is the only way in ([`docs/auth.md`](../docs/auth.md)). While signed
out, the app shows only a full-screen Sign in with Google screen; it opens `GET /auth/start` in `ASWebAuthenticationSession` with a
PKCE S256 challenge and a random `state`. The server redirects to
`dev.willsawyerrrr.personal-shopper://auth` (the registered URL scheme) with a
one-time `code`; the app checks `state`, redeems the code with the PKCE
verifier at `POST /auth/token` and stores the access token in the Keychain. No
third-party code is involved.

The API client sends `Authorization: Bearer <token>` and
`Accept: application/json`; the server answers with JSON instead of the web
UI's redirects. A `401` clears the token and the app, extension and intents
show the signed-out state. Sign out revokes the token with
`POST /auth/logout`.

## Setup

Requires Xcode 16+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen)
(`brew install xcodegen`).

```bash
cd ios
xcodegen generate        # writes PersonalShopper.xcodeproj (gitignored)
open PersonalShopper.xcodeproj
```

Bundle IDs are `dev.willsawyerrrr.personal-shopper` (app) and
`dev.willsawyerrrr.personal-shopper.share` (extension).

To run on a device, set your team in the gitignored `Config/Local.xcconfig`
(read by `Config/Shared.xcconfig` for both targets; builds without it still
work for the simulator and CI):

```bash
op run --environment b5zkkwxuutlttwbrv5xhgojye4 --environment 3i642eynjpsx2uctyqlexobgge --environment pypsxvgj5p7ioxffch5lil4w5u -- \
  sh -c 'echo "DEVELOPMENT_TEAM = $DEVELOPMENT_TEAM" > Config/Local.xcconfig'
xcodegen generate
```

`DEVELOPMENT_TEAM` comes from the Apple Development 1Password Environment.

The Keychain group
`dev.willsawyerrrr.personal-shopper` is created by automatic signing.

Open the app, tap Sign in with Google, then Settings > Test connection.
The app talks to `https://personal-shopper.willsawyerrrr.dev`. The token lives
in the Keychain, shared with the extension and intents through the Keychain
access group; nothing is embedded in the app.

## Share a product

In the Woolworths app or Safari, open a product, tap Share, then Personal
Shopper (enable it under "More" in the share sheet's app row the first time).
Set a trigger word, and tap Add. Signed out, the extension
says "Open Personal Shopper to sign in."; if the Keychain refuses the read, it
shows the Keychain error instead.

If Personal Shopper is missing, scroll the share sheet's app row, tap More,
and turn it on under Favourites (reinstall the app if it is still absent).
After changing `project.yml`, run `xcodegen generate` then
`Scripts/check-share-extension.sh` to confirm the extension declares its
`NSExtensionActivationRule`; pass the built
`PlugIns/ShareExtension.appex/Info.plist` to check a build.

## Share a pickup link

Share the Woolworths ready-order link (or the message containing it) from
Messages, Mail or Safari to Personal Shopper. The extension saves the link in
the Keychain item shared with the app (no other app can read it; the link is
never logged) and says "Link saved"; iOS gives share extensions no reliable way
to open their app, so open Personal Shopper yourself. On foreground, while
signed in, the app takes the link out of the Keychain, selects the Pickup tab
and fills it. The extension's activation rule cannot inspect text, so it also
appears for other URLs and text, where it shows the product form's message.

## Items list

Swipe an item right and tap "Add to Cart" to add it to your Woolworths cart,
the same as saying its first trigger word to Siri.

## Pickup

The Pickup tab tells Woolworths a Direct to boot order's customer is on their
way or has parked, for the ready-order link in Woolworths' SMS or email
(`https://myorder.woolworths.com.au/pickup/order?token=…`). Fill the link with
the paste button (which never triggers the iOS paste prompt) or type it; text
around a link is ignored. Both the short `https://w.wowpu.com.au/<code>` link
Woolworths texts and the `myorder` URL it redirects to are accepted and sent
as received, never resolved on the device (the server must accept short links
for them to work end to end). "Use the link on my clipboard" fills it when the
tab opens, reading the clipboard only after iOS reports a web link on it; iOS
asks to allow pasting unless Paste from Other Apps is Allow for the app.

"I'm on my way" asks for when-in-use location the first time, takes one fix
and calls `POST /pickup/en-route` with the link and coordinates; "I've parked
in a bay" calls `POST /pickup/arrived` with the link. The returned status
title, description and collection method are shown. An invalid or expired link
(`422`), a Woolworths failure (`502`), a rate limit (`429`) and denied
location each show their own message. The link and coordinates are held in
memory only and never logged. Geofence-triggered calls are not supported.

## Woolworths passkey

Settings > Woolworths passkey shows whether the household has a passkey the
server signs in to Woolworths with, and registers, replaces or removes it
(`GET`, `PUT` and `DELETE /woolworths/passkey`). Register passkey opens the
Woolworths login (`https://www.woolworths.com.au/shop/securelogin`) in a
`WKWebView` with a fresh, non-persistent data store. Log in and accept the
prompt to create a passkey; the screen then closes. A failure, including the
server's sign-in to Woolworths with the new passkey failing, is shown on the
screen.

A `WKUserScript` (`PersonalShopperKit/Resources/passkey-authenticator.js`,
document start, all frames) replaces `navigator.credentials.create` and `get`
for public-key requests with a software authenticator, so the system passkey
UI never appears: an ES256 key pair from WebCrypto, `none` attestation, user
present and verified. It also defines the WebAuthn surface pages
feature-detect before offering a passkey (`PublicKeyCredential` with
`isUserVerifyingPlatformAuthenticatorAvailable` and
`isPasskeyPlatformAuthenticatorAvailable` resolving `true`, `getClientCapabilities`,
the `parse*OptionsFromJSON` helpers, and `toJSON` on credentials) when the web
view lacks them. The web view presents a Mobile Safari user agent. Created credentials are kept in memory for the frame (so
`get` can sign for them) and posted to the `passkey` message handler; the app
uploads one only when it comes from a frame on `auth.woolworths.com.au`, as
`{rpId, credentialId, userHandle, privateKey}` (standard base64, PKCS#8 key).
The private key leaves the page only to the signed-in server, and is never
stored on the device.

`create` and `get` are installed as non-configurable, getter-only properties
on `navigator.credentials`, not plain assignments: Woolworths' login page
reassigns them back to the native implementation shortly after this script
runs (anti-tampering), and the native implementation always rejects with
`NotAllowedError` since the app has no Associated Domains entitlement for
`auth.woolworths.com.au`. A getter-only, non-configurable property can't be
reassigned or redefined, so the software authenticator stays in place.

The script is tested in Node (`src/ios-passkey-authenticator.test.ts`)
against the server's `selectCredential`, with signatures verified against the
COSE public key, and has been exercised against the live Woolworths login.

In `DEBUG` builds only, the web view also registers a `debugLog` message
handler: the script forwards page errors, unhandled rejections, console
errors/warnings and every WebAuthn call's options to it, logged via `os_log`
under subsystem `dev.willsawyerrrr.personal-shopper`, category
`passkey-authenticator` (`log stream --predicate 'subsystem ==
"dev.willsawyerrrr.personal-shopper" AND category ==
"passkey-authenticator"'`). It does nothing in release builds, where the
handler isn't registered.

## Shortcuts and Siri

The App Intent is what Shortcuts and Siri use, separate from the share sheet.
Add the "Add Woolworths Product" action to a Shortcut, or say "Add a product
to Personal Shopper" and answer the prompt for the link.

To add to the cart, say "Add to my Woolworths cart with Personal Shopper" and
answer "What do you want to add?" with a mapped item such as "milk".

To add several items in one go, say "Add several items to my cart with
Personal Shopper" (or "Start a shopping list with Personal Shopper"), then
name one item at a time. Say "that's it" to finish.

## TestFlight

Merges to `main` that touch `ios/**` (or `.github/workflows/deploy-ios.yml`)
archive the app and upload it to TestFlight through
`.github/workflows/deploy-ios.yml`, which calls the platform repo's reusable
`ios-testflight.yml`. Run it by hand from the Actions tab
(`workflow_dispatch`). Requires:

- Variables `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_P8` (an App Store Connect API key)
  and `DEVELOPMENT_TEAM` (the team ID; never committed), in the Apple Development
  1Password Environment. Repo secret `OP_SERVICE_ACCOUNT_TOKEN` and
  repo variable `OP_ENVIRONMENT_IDS` (`b5zkkwxuutlttwbrv5xhgojye4 3i642eynjpsx2uctyqlexobgge pypsxvgj5p7ioxffch5lil4w5u`) let the workflow load them; see
  [`docs/deployment.md`](../docs/deployment.md#configuration).
- An App Store Connect app record for `dev.willsawyerrrr.personal-shopper`
  (the extension, `.share`, is signed with it).

`MARKETING_VERSION` (`project.yml`) is the version users see; the workflow sets
`CURRENT_PROJECT_VERSION` per upload. Both targets share them so the extension
matches the app.

## Tests

```bash
xcodebuild test -project PersonalShopper.xcodeproj -scheme PersonalShopper \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

Covers URL parsing, the edit form's validation, settings, PKCE (against the RFC 7636 test vector), sign-in
and the API client (against a stubbed `URLProtocol`).
