# iOS app

Native SwiftUI client for the server's JSON API (`src/admin.ts`): list, add,
edit and remove items, plus a Share extension and an App Intent that add a
Woolworths product without opening the web app.

- **App** (`App/`): Items tab (one row per product, titled with its
  Woolworths listing, its trigger words beneath it, pull to refresh, tap a
  row to edit its trigger phrases (add one at a time; remove with swipe or
  Edit, keeping at least one), quantity and product link or stockcode,
  swipe to delete a product with all its words, add by pasted URL) and Settings tab (Sign in
  with Google / Sign out, test connection, and Household: members, create and
  share an invite code, join with a code, leave).
- **Share extension** (`ShareExtension/`): appears in the iOS share sheet for
  URLs and text. Pulls the `woolworths.com.au/shop/productdetails/<stockcode>`
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

Google is the only way in ([`docs/auth.md`](../docs/auth.md)). Settings > Sign
in with Google opens `GET /auth/start` in `ASWebAuthenticationSession` with a
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
cp Config/Local.xcconfig.example Config/Local.xcconfig
# set DEVELOPMENT_TEAM; find the ID in Xcode > Settings > Accounts > Manage
# Certificates, or developer.apple.com > Membership details > Team ID
xcodegen generate
```

The Keychain group
`dev.willsawyerrrr.personal-shopper` is created by automatic signing.

Open the app, then Settings: tap Sign in with Google, then Test connection.
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

- Repo secrets `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_P8` (an App Store
  Connect API key).
- Repo variable `DEVELOPMENT_TEAM` (the team ID; never committed).
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
