# iOS admin app

Native SwiftUI client for the server's admin API (`src/admin.ts`): list, add
and remove items, plus a Share extension and an App Intent that add a
Woolworths product without opening the web admin.

- **App** (`App/`): Items tab (list, pull to refresh, swipe to delete, add by
  pasted URL) and Settings tab (server URL, shared secret, test connection).
- **Share extension** (`ShareExtension/`): appears in the iOS share sheet for
  URLs and text. Pulls the `woolworths.com.au/shop/productdetails/<stockcode>`
  link out of what was shared, shows name, trigger word and quantity, then
  calls the API.
- **App Intent** (`App/AddItemIntent.swift`): `AddItemIntent` for Shortcuts
  and Siri, taking a product URL plus optional trigger word, name and
  quantity. The word defaults to the lower-cased name, the name to the one in
  the link.
- **`Packages/PersonalShopperKit`**: API client, Keychain and settings
  storage, product URL parsing and the add-item form, shared by all three.

The API client sends `Accept: application/json` with HTTP Basic auth
(`admin:<shared secret>`); the server answers with JSON instead of the web
UI's redirects.

## Setup

Requires Xcode 16+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen)
(`brew install xcodegen`).

```bash
cd ios
xcodegen generate        # writes PersonalShopper.xcodeproj (gitignored)
open PersonalShopper.xcodeproj
```

Bundle IDs are `dev.willsawyerrrr.personalshopper` (app) and
`dev.willsawyerrrr.personalshopper.share` (extension).

To run on a device, set your team in the gitignored `Config/Local.xcconfig`
(read by `Config/Shared.xcconfig` for both targets; builds without it still
work for the simulator and CI):

```bash
cp Config/Local.xcconfig.example Config/Local.xcconfig
# set DEVELOPMENT_TEAM; find the ID in Xcode > Settings > Accounts > Manage
# Certificates, or developer.apple.com > Membership details > Team ID
xcodegen generate
```

The App
Group `group.dev.willsawyerrrr.personalshopper` and Keychain group
`dev.willsawyerrrr.personalshopper` are created by automatic signing.

Open the app, then Settings: the server URL defaults to
`https://personal-shopper.willsawyerrrr.dev`; enter the `SHARED_SECRET` and
tap Test connection. The secret lives in the Keychain, shared with the
extension through the Keychain access group; nothing is embedded in the app.
Plain-HTTP servers work only on the local network.

## Share a product

In the Woolworths app or Safari, open a product, tap Share, then Personal
Shopper (enable it under "More" in the share sheet's app row the first time).
Check the name, set a trigger word, and tap Add.

## Shortcuts and Siri

The App Intent is what Shortcuts and Siri use, separate from the share sheet.
Add the "Add Woolworths Product" action to a Shortcut, or say "Add a product
to Personal Shopper" and answer the prompt for the link.

## Tests

```bash
xcodebuild test -project PersonalShopper.xcodeproj -scheme PersonalShopper \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

Covers URL parsing, settings and the API client (against a stubbed
`URLProtocol`).
