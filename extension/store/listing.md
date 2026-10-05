# Chrome Web Store listing

Visibility: **Unlisted**. Category: Shopping. Language: English.

## Name

Personal Shopper — Add Item

## Short description (≤ 132 characters)

Add the Woolworths product you're viewing to your Personal Shopper items list in one click.

## Detailed description

Personal Shopper turns spoken shopping-list items ("Hey Siri, add milk") into products in your Woolworths Click & Collect cart. This extension is the quickest way to teach it a new item.

- Open any woolworths.com.au product page, click the toolbar icon (or press Ctrl+Shift+Y, Cmd+Shift+Y on Mac), choose the word you'll say and a quantity, and add it.
- Sign in with Google. Your household's items are shared with the people you invite.
- Register the Woolworths passkey the server uses to keep your session alive, without leaving the browser.

You need a Personal Shopper server account to use it. The extension never places an order; checkout stays manual.

## Single purpose

Add the Woolworths product page you're viewing to your Personal Shopper items list.

## Permission justifications

- `activeTab`: reads the URL of the current tab only when you open the popup, to prefill the product being added.
- `debugger`: attaches a virtual authenticator to the Woolworths login tab (in an Incognito window if you allow the extension there) you open from the options page, only while you register a passkey. Chrome shows its debugging bar while attached.
- `identity`: `chrome.identity.launchWebAuthFlow` runs Google sign-in through the Personal Shopper server.
- `storage`: keeps your access token and its expiry in local extension storage, and the in-progress passkey registration state in session storage.
- Host permission `https://personal-shopper.willsawyerrrr.dev/*`: the popup and options page call the Personal Shopper server's API (the server sets no CORS headers).
- Host permission `https://*.woolworths.com.au/*`: lets the extension drive the Woolworths login tab opened for passkey registration.

Remote code: none. All code ships in the package.

## Privacy

Privacy policy URL: `https://personal-shopper.willsawyerrrr.dev/privacy` (served by the app from `src/privacy.ts`; deploy before submitting).

Data usage disclosures:

- Collected: authentication information (access token, Google email held server-side) and website content (the product URL the user adds).
- Not sold or transferred to third parties; not used for purposes unrelated to the single purpose; not used for creditworthiness or lending.

## Screenshots (1280x800 or 640x400, PNG/JPEG, up to 5)

- [ ] Popup on a Woolworths product page with the form filled in.
- [ ] Popup showing "Added."
- [ ] Options page signed in (token expiry shown).
- [ ] Options page household section.
- [ ] Options page passkey registration.

Store icon: `extension/icons/icon-128.png` (96px artwork padded to 128). Optional small promo tile 440x280.
