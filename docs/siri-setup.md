# Siri / HomePod setup

This lives entirely in Apple's Shortcuts app — nothing here is part of this
repo's code.

## 1. Shared Reminders list

Create an iCloud Reminders list (e.g. "Grocery List") and share it with your
partner so both Apple IDs can add to it. Saying "Hey Siri, add milk to
Grocery List" on either HomePod adds "milk" as a reminder — Apple's built-in
NLU handles arbitrary item text without any custom Siri phrase.

## 2. Personal automation

On an iPhone that's reliably on and connected (this is what actually runs the
automation — HomePod triggers the Siri request, but the automation itself
executes on the paired phone):

1. Shortcuts app → **Automation** → **+** → **Create Personal Automation**.
2. Trigger: **Reminders** → **When a reminder is added** → select the shared
   list.
3. Add action **Get Contents of URL**:
   - URL: your deployed webhook, e.g. `https://shopper.willsawyerrrr.dev/items`
   - Method: `POST`
   - Headers: `Authorization: Bearer <SHARED_SECRET>`, `Content-Type: application/json`
   - Request Body (JSON): `{ "item": "Shortcut Input" }` — use the magic
     variable for the reminder's title as the `item` value.
4. Add a following action to mark the reminder complete (or delete it) so the
   list doesn't re-trigger and stays tidy.
5. Turn **off** "Ask Before Running".

## 3. One-time network permission

The first time any personal automation makes a network request, iOS asks for
confirmation even with "Ask Before Running" off — a one-time OS-level gate,
not a per-run prompt. Trigger it once manually (add an item, confirm the
prompt) before relying on it running unattended.
