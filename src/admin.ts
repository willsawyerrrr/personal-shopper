import formbody from '@fastify/formbody'
import type { FastifyInstance } from 'fastify'
import type { AppConfig } from './config.ts'
import { loadItems, normalizeWord, saveItems, type ItemsConfig } from './items.ts'

export async function registerAdmin(app: FastifyInstance, config: AppConfig): Promise<void> {
  await app.register(async (admin) => {
    await admin.register(formbody)

    admin.addHook('onRequest', async (request, reply) => {
      const header = request.headers.authorization
      const valid =
        header === `Basic ${Buffer.from(`admin:${config.sharedSecret}`).toString('base64')}`
      if (!valid) {
        reply.header('WWW-Authenticate', 'Basic realm="personal-shopper admin"')
        return reply.code(401).send('Authentication required')
      }
    })

    admin.get('/admin', async (_request, reply) => {
      const items = await loadItems(config.itemsPath)
      reply.type('text/html').send(renderPage(items))
    })

    admin.post<{ Body: { word: string; url: string; name?: string; quantity?: string } }>(
      '/admin/items',
      async (request, reply) => {
        const { word, url, name, quantity } = request.body
        const stockcode = parseStockcode(url)
        if (!stockcode) {
          const items = await loadItems(config.itemsPath)
          reply
            .type('text/html')
            .send(
              renderPage(
                items,
                'Could not find a stockcode in that URL — paste a link like /shop/productdetails/123456/product-name, or the stockcode itself.',
              ),
            )
          return
        }
        const items = await loadItems(config.itemsPath)
        const trimmedName = name?.trim()
        items[normalizeWord(word)] = {
          stockcode,
          quantity: Math.max(1, Number(quantity) || 1),
          ...(trimmedName ? { name: trimmedName } : {}),
        }
        await saveItems(config.itemsPath, items)
        return reply.redirect('/admin')
      },
    )

    admin.post<{ Params: { word: string } }>(
      '/admin/items/:word/delete',
      async (request, reply) => {
        const items = await loadItems(config.itemsPath)
        delete items[normalizeWord(request.params.word)]
        await saveItems(config.itemsPath, items)
        return reply.redirect('/admin')
      },
    )
  })
}

function parseStockcode(input: string): number | undefined {
  const trimmed = input.trim()
  const fromPath = trimmed.match(/productdetails\/(\d+)/)
  if (fromPath?.[1]) {
    return Number(fromPath[1])
  }
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined
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
  <style>
    body { font-family: system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 2rem; }
    th, td { text-align: left; padding: 0.5rem; border-bottom: 1px solid #ddd; }
    form.add label { display: block; margin-bottom: 0.75rem; }
    form.add input { width: 100%; padding: 0.4rem; box-sizing: border-box; }
    button { padding: 0.4rem 0.8rem; }
    .error { color: #b00020; margin-bottom: 1rem; }
    .hint { color: #666; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>Shopping list items</h1>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
  <table>
    <thead><tr><th>Word</th><th>Name</th><th>Stockcode</th><th>Qty</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="5">No items configured yet.</td></tr>'}</tbody>
  </table>
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
