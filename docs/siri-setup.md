# Siri / HomePod setup

Siri reaches the Personal Shopper cart through two paths: the Reminders list the server syncs,
and the iOS app's App Intent.

## Reminders list

The server drains an iCloud Reminders list into the Personal Shopper cart (see
[`architecture.md`](architecture.md#reminders-queue)). Saying "Hey Siri, add
milk to my Shopping List" on a HomePod or iPhone adds a reminder titled
`milk`; within the sync interval the server resolves that against the owner's items,
adds one of it to the Personal Shopper cart and deletes the reminder. It does
not need a live Woolworths session; checking out (the web app's Cart page or
`POST /cart/checkout`) picks products and sends the cart to Woolworths.

Requirements:

- `ICLOUD_USERNAME` and `ICLOUD_APP_SPECIFIC_PASSWORD` are set on the server
  ([`deployment.md`](deployment.md#what-lives-where)).
- The Reminders list is named as `REMINDERS_LIST_NAME` (default "Shopping
  List") and is in the iCloud account that username belongs to.
- The spoken word has a mapping in the owner's items
  (`REMINDERS_OWNER_EMAIL`): add it in `/`, the Chrome
  extension or the iOS app. A reminder with no mapping stays in the list and
  is retried every interval.
- Sync runs every `REMINDERS_SYNC_INTERVAL_MS` (default 5 minutes), so the
  cart updates after a delay, not instantly.

## iOS app App Intent

Siri calls the iOS app's App Intent
([`ios/README.md`](../ios/README.md)), which sends the spoken phrase to the
server as `POST /cart/items` with the app's bearer token
([`auth.md`](auth.md#the-cart)). The server resolves the phrase
against the signed-in user's items and adds one of it to the household's
Personal Shopper cart immediately, with no sync delay. The phrase needs a
mapping in their items, and the app must be
signed in ([`auth.md`](auth.md#api-client-sign-in)). An unmapped phrase is a
`404`; nothing is queued.

Say "Add to my Woolworths cart with Personal Shopper" and answer "What do you
want to add?", or "Add several items to my cart with Personal Shopper" to be
asked "What next?" after each item until you say "that's it". The "Add Woolworths Product" intent ("Add a product to Personal
Shopper") adds a trigger word to the user's items from a product link instead; it
does not add to the cart.
