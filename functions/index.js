import { Hono } from 'https://esm.sh/hono'

const app = new Hono()

async function sendMessage(env, chatId, text) {
  try {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    })
  } catch (e) { console.error('Failed to send message', e) }
}

app.get('/', (c) => c.text('Bot is online! ✅'))

app.get('/api/designs', async (c) => {
  const list = await c.env.DB.list({ prefix: 'design:' })
  const designs = []
  for (const key of list.keys) {
    const config = await c.env.DB.get(key.name, { type: 'json' })
    if (config?.enabled) designs.push(config)
  }
  return c.json(designs)
})

app.post('/api/upload-design', async (c) => {
  const body = await c.req.json()
  if (c.req.headers.get('x-admin-id') !== c.env.ADMIN_ID)
    return c.json({ error: 'Unauthorized' }, 401)

  await c.env.STICKERS.put(`designs/${body.id}/template.json`, JSON.stringify(body.template))
  await c.env.DB.put(`design:${body.id}`, JSON.stringify({
    id: body.id, name: body.name, price: body.price,
    logoLayer: body.logoLayer, groups: body.groups, enabled: true
  }))
  return c.json({ ok: true })
})

app.post('/api/create-invoice', async (c) => {
  const { userId, designId } = await c.req.json()
  const design = await c.env.DB.get(`design:${designId}`, { type: 'json' })
  if (!design?.enabled) return c.json({ error: 'Invalid design' }, 400)

  const invoiceId = `${userId}_${designId}_${Date.now()}`
  await c.env.DB.put(`invoice:${invoiceId}`, JSON.stringify({ userId, designId, paid: false }))
  return c.json({ invoiceId, price: design.price })
})

app.post('/webhook', async (c) => {
  let update
  try { update = await c.req.json() } catch { return c.json({ ok: true }) }
  if (update?.pre_checkout_query) return c.json({ ok: true })
  if (!update?.message?.successful_payment) return c.json({ ok: true })

  const msg = update.message
  const invoiceId = `${msg.from.id}_${msg.message_id}`
  await c.env.DB.put(`invoice:${invoiceId}`, JSON.stringify({ userId: msg.from.id, designId: 0, paid: true }))
  await sendMessage(c.env, msg.chat.id, '✅ Payment received! You can now generate your sticker.')
  return c.json({ ok: true })
})

app.post('/api/generate', async (c) => {
  const { userId, designId, logoSvg, logoScale, logoX, logoY, groupColors } = await c.req.json()
  const design = await c.env.DB.get(`design:${designId}`, { type: 'json' })
  if (!design) return c.json({ error: 'Invalid design' }, 400)

  const templateJson = await c.env.STICKERS.get(`designs/${designId}/template.json`, { type: 'json' })
  if (!templateJson) return c.json({ error: 'Template not found' }, 404)

  const modified = { ...templateJson }
  modified.layers.forEach(layer => {
    if (layer.name === design.logoLayer) layer.svg = logoSvg
    for (const group of design.groups) {
      if (groupColors[group.displayName] && group.layers.includes(layer.name))
        layer.color = groupColors[group.displayName]
    }
  })

  const tgsData = new TextEncoder().encode(JSON.stringify(modified))
  return c.json({ sticker: tgsData })
})

export default app
