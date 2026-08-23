# Siri / HomePod setup

This lives entirely in Apple's Shortcuts app — nothing here is part of this
repo's code. Confirmed working end-to-end against a live cart.

There's no native "when a reminder is added" trigger in Shortcuts, and no
way to record a custom Siri phrase with an embedded free-text slot (that's
only available to real installed apps built with Apple's App Intents
framework, not user-created Shortcuts) — so this doesn't use Reminders at
all. Instead, one Shortcut with a fixed trigger phrase asks a follow-up
question and captures your spoken answer.

## 1. Build the shortcut

1. Shortcuts app → **+** → New Shortcut.
2. Add action **Dictate Text**.
3. Add action **Get Contents of URL**:
   - URL: the PC's LAN IP, e.g. `http://192.168.1.50:3000/items` (see
     [`deployment.md`](deployment.md) for reserving a static DHCP lease so
     this doesn't change)
   - Method: `POST`
   - Headers: `Authorization: Bearer <SHARED_SECRET>`, `Content-Type: application/json`
   - Request Body (JSON): `{ "item": [Dictated Text] }` — use Dictate Text's
     result as the magic variable.
4. Name it (e.g. "Add to Shopping List").

Don't add a "Speak Text" prompt before **Dictate Text** — Siri already asks
its own fixed question ("What's the text?") when this action runs via
voice, and there's no way to suppress or customize it. Adding your own
prompt just doubles it up.

## 2. Record the Siri phrase

In the shortcut's settings (⋯ menu → settings icon) → **Add to Siri** →
record a phrase, e.g. "Add to shopping list".

## 3. Run it

"Hey Siri, add to shopping list" (on the HomePod or your phone) → Siri asks
"What's the text?" → say the item name → it's added to the cart.

Since items still need a `stockcode` mapping in `items.yml` to actually add
anything (via `/admin` or the Chrome extension), this isn't truly
free-text — it just moves the "what did you say" matching from a custom
phrase per item to whatever you say after Siri's prompt, checked against
`items.yml`'s keys.

## Home-network only

Only works while the triggering device is on home WiFi — the LAN IP isn't
reachable from cellular/away from home. If it's tried while out, it fails
silently until you're back home; there's no offline queue or retry.
