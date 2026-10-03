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

The iOS app ([`ios/README.md`](../ios/README.md)) exposes the "Add Woolworths
Product" App Intent to Shortcuts and Siri ("Add a product to Personal
Shopper"). It adds a trigger word to `items.yml` from a product link; it does
not add to the cart. Voice cart additions through the app's App Intent come with
the iOS app's Google sign-in ([`auth.md`](auth.md#api-client-sign-in)).
