# Siri / HomePod setup

Siri reaches the cart through two paths: the Reminders list the server syncs,
and the iOS app's App Intent.

## Reminders list

The server drains an iCloud Reminders list into the cart (see
[`architecture.md`](architecture.md#reminders-queue)). Saying "Hey Siri, add
milk to my Shopping List" on a HomePod or iPhone adds a reminder titled
`milk`; within the sync interval the server resolves that against `items.yml`,
adds the mapped product to the cart and deletes the reminder.

Requirements:

- `ICLOUD_USERNAME` and `ICLOUD_APP_SPECIFIC_PASSWORD` are set on the server
  ([`deployment.md`](deployment.md#what-lives-where)).
- The Reminders list is named as `REMINDERS_LIST_NAME` (default "Shopping
  List") and is in the iCloud account that username belongs to.
- The spoken word has a mapping in `items.yml`: add it in `/admin`, the Chrome
  extension or the iOS app. A reminder with no mapping stays in the list and
  is retried every interval.
- Sync runs every `REMINDERS_SYNC_INTERVAL_MS` (default 5 minutes), so the
  cart updates after a delay, not instantly.

## iOS app App Intent

Siri calls the iOS app's App Intent
([`ios/README.md`](../ios/README.md)), which sends the spoken phrase to the
server as `POST /cart/items` with the app's bearer token
([`auth.md`](auth.md#adding-to-the-cart)). The server resolves the phrase
against `items.yml` and adds the mapped product to the cart immediately, with
no sync delay. The phrase needs a mapping in `items.yml`, and the app must be
signed in ([`auth.md`](auth.md#api-client-sign-in)). An unmapped phrase is a
`404` and an expired Woolworths session a `502`; nothing is queued.

Say "Add to my Woolworths cart with Personal Shopper" and answer "What do you
want to add?". The "Add Woolworths Product" intent ("Add a product to Personal
Shopper") adds a trigger word to `items.yml` from a product link instead; it
does not add to the cart.
