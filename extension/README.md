# Add item

A Chrome extension, not part of the Fastify service — adds the Woolworths
product page you're currently looking at to `items.yml` via the same
`POST /admin/items` endpoint the web admin UI (`src/admin.ts`) already
exposes, without switching tabs to copy the URL across by hand.

Not covered by `pnpm run lint`, `typecheck`, or `coverage` — plain
browser-extension JS, no build step, nothing under `src/`.

## Load it

Distributed as an unpacked extension rather than through the Chrome Web
Store — no developer account, fee, or public listing needed for something
this small and single-user.

1. `chrome://extensions` → enable Developer Mode → Load unpacked → this
   folder.
2. Click the extension icon → "Options" (or right-click the icon → Options)
   → set your server URL (`http://localhost:3000` for local dev, or your
   production Cloudflare Tunnel hostname) and `SHARED_SECRET`. Stored in
   `chrome.storage.local` — this browser only, never synced to Google.
3. On any `woolworths.com.au/shop/productdetails/...` page, click the icon.
   The product URL and a name (from the page's `<title>`) are prefilled;
   type a trigger word and quantity, then submit.

## Permissions

- `activeTab` / `scripting` — read the current tab's URL and title only when
  you open the popup, to prefill the form. No `tabs`, no broad host access
  to browse tabs you haven't opened the popup on.
- `storage` — save your server URL and secret locally.
- `host_permissions` for the server itself (`localhost:3000` and the
  production hostname) — required for the popup's `fetch` to reach it at
  all; extension pages aren't otherwise exempt from the target needing to
  allow cross-origin requests, and this server sets no CORS headers.

## What this doesn't cover

- No product search — same constraint as the web admin UI. You still need
  to already be on the product's page.
- No feedback beyond "Added." / "Failed (\<status\>)" in the popup — check
  `/admin` if you want to confirm what actually landed in `items.yml`.
- A non-Woolworths-product-page tab hides the form entirely rather than
  showing a disabled one.
