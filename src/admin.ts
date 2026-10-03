import { randomBytes } from 'node:crypto'
import formbody from '@fastify/formbody'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppConfig } from './config.ts'
import { loadItems, normalizeWord, saveItems, type ItemMapping, type ItemsConfig } from './items.ts'

const SESSION_COOKIE = 'ps_admin_session'
const LOGIN_RATE_LIMIT_MAX = 10
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

export async function registerAdmin(app: FastifyInstance, config: AppConfig): Promise<void> {
  await app.register(async (admin) => {
    await admin.register(formbody)

    // Held in memory only, so a restart invalidates every session. Logging
    // out rotates it, which revokes every other open session too — there's
    // no per-device session store to invalidate individually, and for a
    // single-admin household tool an all-or-nothing logout is a fine trade.
    let sessionToken = randomBytes(32).toString('hex')

    admin.addHook('onRequest', async (request, reply) => {
      if (request.url.startsWith('/admin/login')) {
        return
      }
      if (isAuthorized(request, config.sharedSecret, sessionToken)) {
        return
      }
      if (wantsJson(request)) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
      if (request.method === 'GET') {
        return reply.redirect('/admin/login')
      }
      reply.code(401).send('Authentication required')
    })

    admin.get('/admin/login', async (_request, reply) => {
      reply.type('text/html').send(renderLoginPage())
    })

    admin.post<{ Body: { secret: string } }>(
      '/admin/login',
      { config: { rateLimit: { max: LOGIN_RATE_LIMIT_MAX, timeWindow: '1 minute' } } },
      async (request, reply) => {
        if (request.body.secret !== config.sharedSecret) {
          reply.code(401).type('text/html').send(renderLoginPage('Incorrect secret.'))
          return
        }
        reply
          .header(
            'set-cookie',
            sessionCookie(sessionToken, SESSION_MAX_AGE_SECONDS, request.protocol === 'https'),
          )
          .redirect('/admin')
      },
    )

    admin.post('/admin/logout', async (request, reply) => {
      sessionToken = randomBytes(32).toString('hex')
      reply
        .header('set-cookie', sessionCookie('', 0, request.protocol === 'https'))
        .redirect('/admin/login')
    })

    admin.get('/admin', async (_request, reply) => {
      const items = await loadItems(config.itemsPath)
      reply.type('text/html').send(renderPage(items))
    })

    admin.get('/admin/items', async () => {
      const items = await loadItems(config.itemsPath)
      return {
        items: Object.entries(items)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([word, mapping]) => ({ word, ...mapping })),
      }
    })

    admin.post<{
      Body: { word?: string; url?: string; name?: string; quantity?: string | number }
    }>('/admin/items', async (request, reply) => {
      const { word, url, name, quantity } = request.body
      const items = await loadItems(config.itemsPath)
      const stockcode = parseStockcode(url ?? '')
      const error = !word?.trim()
        ? 'A trigger word is required.'
        : !stockcode
          ? 'Could not find a stockcode in that URL — paste a link like /shop/productdetails/123456/product-name, or the stockcode itself.'
          : undefined
      if (error || !word || !stockcode) {
        if (wantsJson(request)) {
          return reply.code(400).send({ error })
        }
        return reply.code(400).type('text/html').send(renderPage(items, error))
      }
      const trimmedName = name?.trim()
      const mapping: ItemMapping = {
        stockcode,
        quantity: Math.max(1, Number(quantity) || 1),
        ...(trimmedName ? { name: trimmedName } : {}),
      }
      items[normalizeWord(word)] = mapping
      await saveItems(config.itemsPath, items)
      if (wantsJson(request)) {
        return reply.code(201).send({ word: normalizeWord(word), ...mapping })
      }
      return reply.redirect('/admin')
    })

    admin.post<{ Params: { word: string } }>(
      '/admin/items/:word/delete',
      async (request, reply) => {
        const items = await loadItems(config.itemsPath)
        delete items[normalizeWord(request.params.word)]
        await saveItems(config.itemsPath, items)
        if (wantsJson(request)) {
          return reply.code(204).send()
        }
        return reply.redirect('/admin')
      },
    )
  })
}

function isAuthorized(
  request: FastifyRequest,
  sharedSecret: string,
  sessionToken: string,
): boolean {
  const header = request.headers.authorization
  if (header === `Basic ${Buffer.from(`admin:${sharedSecret}`).toString('base64')}`) {
    return true
  }
  return readCookie(request.headers.cookie, SESSION_COOKIE) === sessionToken
}

// API clients (the iOS app) opt in with `Accept: application/json` and get
// JSON bodies and status codes instead of the browser flow's redirects.
function wantsJson(request: FastifyRequest): boolean {
  return request.headers.accept?.includes('application/json') ?? false
}

function readCookie(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name)?.[1]
}

// `Secure` only over HTTPS, so local development on plain HTTP still works.
function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
}

function parseStockcode(input: string): number | undefined {
  const trimmed = input.trim()
  const fromPath = trimmed.match(/productdetails\/(\d+)/)
  if (fromPath?.[1]) {
    return Number(fromPath[1])
  }
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined
}

const PAGE_STYLES = `
  :root {
    --color-bg: #f6f7f5;
    --color-surface: #ffffff;
    --color-border: #dde1db;
    --color-text: #1f2a24;
    --color-text-muted: #667066;
    --color-accent: #1f7a4d;
    --color-accent-hover: #17603c;
    --color-danger: #b3261e;
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    max-width: 640px;
    margin: 2.5rem auto;
    padding: 0 1rem;
    background: var(--color-bg);
    color: var(--color-text);
  }
  h1 { font-size: 1.3rem; font-weight: 600; margin: 0 0 1.25rem; }
  h2 { font-size: 1rem; font-weight: 600; margin: 0 0 0.5rem; }
  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
    padding: 1.25rem 1.5rem;
    margin-bottom: 1.5rem;
  }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid var(--color-border); font-size: 0.9rem; }
  th { color: var(--color-text-muted); font-weight: 500; }
  label { display: block; margin-bottom: 0.85rem; font-size: 0.8rem; font-weight: 500; color: var(--color-text-muted); }
  input {
    width: 100%;
    margin-top: 0.3rem;
    padding: 0.5rem 0.6rem;
    font-size: 0.9rem;
    font-family: inherit;
    color: var(--color-text);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius);
  }
  input:focus {
    outline: none;
    border-color: var(--color-accent);
    box-shadow: 0 0 0 3px rgb(31 122 77 / 15%);
  }
  button {
    padding: 0.5rem 1rem;
    font-size: 0.9rem;
    font-weight: 600;
    font-family: inherit;
    color: #fff;
    background: var(--color-accent);
    border: none;
    border-radius: var(--radius);
    cursor: pointer;
  }
  button:hover { background: var(--color-accent-hover); }
  table button {
    padding: 0.3rem 0.6rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--color-danger);
    background: transparent;
    border: 1px solid var(--color-border);
  }
  table button:hover { background: var(--color-bg); }
  .error { color: var(--color-danger); margin: 0 0 1rem; font-size: 0.9rem; }
  .hint { color: var(--color-text-muted); font-size: 0.85rem; margin: 0 0 1rem; }
  .top-bar { display: flex; align-items: center; justify-content: space-between; }
  .logout {
    padding: 0.3rem 0.7rem;
    font-size: 0.8rem;
    font-weight: 500;
    color: var(--color-text-muted);
    background: transparent;
    border: 1px solid var(--color-border);
  }
  .logout:hover { background: var(--color-surface); }
`

function renderLoginPage(error?: string): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>personal-shopper — sign in</title>
  <style>
    ${PAGE_STYLES}
    body { max-width: 360px; margin-top: 6rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Personal Shopper admin</h1>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/admin/login">
      <label>Shared secret
        <input name="secret" type="password" autocomplete="current-password" required autofocus>
      </label>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`
}

function renderPage(items: ItemsConfig, error?: string): string {
  const rows = Object.entries(items)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([word, mapping]) => `
        <tr>
          <td>${escapeHtml(word)}</td>
          <td>${escapeHtml(mapping.name ?? '')}</td>
          <td>${mapping.stockcode}</td>
          <td>${mapping.quantity}</td>
          <td>
            <form method="post" action="/admin/items/${encodeURIComponent(word)}/delete">
              <button type="submit">Remove</button>
            </form>
          </td>
        </tr>`,
    )
    .join('')

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>personal-shopper — items</title>
  <style>${PAGE_STYLES}</style>
</head>
<body>
  <div class="top-bar">
    <h1>Shopping list items</h1>
    <form method="post" action="/admin/logout">
      <button type="submit" class="logout">Log out</button>
    </form>
  </div>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <div class="card">
    <table>
      <thead><tr><th>Word</th><th>Name</th><th>Stockcode</th><th>Qty</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No items configured yet.</td></tr>'}</tbody>
    </table>
  </div>
  <div class="card">
    <h2>Add an item</h2>
    <p class="hint">Find the product on woolworths.com.au and paste its URL below.</p>
    <form class="add" method="post" action="/admin/items">
      <label>Trigger word (what you'll say to Siri)
        <input name="word" required placeholder="milk">
      </label>
      <label>Woolworths product URL or stockcode
        <input name="url" required placeholder="https://www.woolworths.com.au/shop/productdetails/888137/...">
      </label>
      <label>Display name (optional)
        <input name="name" placeholder="Woolworths Full Cream Milk 2L">
      </label>
      <label>Quantity
        <input name="quantity" type="number" min="1" value="1">
      </label>
      <button type="submit">Add item</button>
    </form>
  </div>
</body>
</html>`
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
