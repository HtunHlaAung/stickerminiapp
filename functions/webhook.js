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

  if (text === '/start') {
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: "🚀 Welcome to Sticker Mini App!\nOpen the editor below:",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🎨 Open Editor",
                web_app: {
                  url: "https://stickerminiapp.pages.dev/"
                }
              }
            ]
          ]
        }
      })
    })
  }

  return new Response('ok')
}
