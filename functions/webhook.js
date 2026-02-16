export async function onRequestPost(context) {
  const { request, env } = context

  let update
  try {
    update = await request.json()
  } catch {
    return new Response('ok')
  }

  if (!update.message) {
    return new Response('ok')
  }

  const chatId = update.message.chat.id
  const text = update.message.text

  // Handle /start
  if (text === '/start') {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '🚀 Welcome to Sticker Mini App!\nSend your SVG logo to begin.'
      })
    })
  }

  return new Response('ok')
}
