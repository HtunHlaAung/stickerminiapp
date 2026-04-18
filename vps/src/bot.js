'use strict';
const TelegramBot = require('node-telegram-bot-api');
const path        = require('path');
const fs          = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID  = process.env.OWNER_ID;
const APP_URL   = `https://HtunHlaAung.github.io/stickerminiapp`;

let bot = null;

function init() {
  if (!BOT_TOKEN) { console.error('[BOT] BOT_TOKEN missing'); return; }

  bot = new TelegramBot(BOT_TOKEN, { polling: true });

  bot.on('polling_error', err => console.error('[BOT] Polling error:', err.message));

  // ── /start ──────────────────────────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      await bot.sendMessage(chatId,
        `✨ *Welcome to Magic Sticker!*\n\nCreate stunning animated stickers with your brand logo.\n\n🎨 Choose a template, add your logo, and export instantly!`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              {
                text: '🎨 Open Sticker Creator',
                web_app: { url: APP_URL },
              }
            ], [
              { text: '💰 Top Up Balance', callback_data: 'topup_info' },
              { text: 'ℹ️ Help', callback_data: 'help' },
            ]],
          },
        }
      );
    } catch (e) {
      console.error('[BOT] /start error:', e.message);
    }
  });

  // ── Callback queries ────────────────────────────────────────────────────
  bot.on('callback_query', async (cb) => {
    const data   = cb.data || '';
    const chatId = cb.message.chat.id;
    const msgId  = cb.message.message_id;

    await bot.answerCallbackQuery(cb.id).catch(() => {});

    if (data === 'topup_info') {
      await bot.sendMessage(chatId,
        '💳 *Top Up Balance*\n\nOpen the Mini App → Account → Top Up\n\nMinimum: 500 Ks\nMaximum: 50,000 Ks\n\nAmounts must be multiples of 500.',
        { parse_mode: 'Markdown' }
      );
    }

    if (data === 'help') {
      await bot.sendMessage(chatId,
        '❓ *How to use Magic Sticker*\n\n1️⃣ Open the app\n2️⃣ Go to *Logo* tab → set your logo\n3️⃣ Go to *Designs* tab → pick a template\n4️⃣ Customize colors & position\n5️⃣ Click *Export* → sticker sent here!\n\n💰 Balance is used per export.',
        { parse_mode: 'Markdown' }
      );
    }

    // Owner topup approval
    if (data.startsWith('topup_approve:')) {
      const reqId = data.replace('topup_approve:', '');
      await handleTopupAction(chatId, msgId, reqId, 'approve', cb);
    }
    if (data.startsWith('topup_reject:')) {
      const reqId = data.replace('topup_reject:', '');
      await handleTopupAction(chatId, msgId, reqId, 'reject', cb);
    }
    if (data.startsWith('topup_ban:')) {
      const parts  = data.split(':');
      const reqId  = parts[1];
      const userId = parts[2];
      await handleBanUser(chatId, msgId, reqId, userId);
    }
  });

  console.log('[BOT] Telegram bot started');
}

// ── Owner topup action ────────────────────────────────────────────────────

async function handleTopupAction(chatId, msgId, reqId, action, cb) {
  try {
    const axios = require('axios');
    const workerUrl = process.env.WORKER_URL;

    // We call the worker with a special internal token
    // The worker handles D1 update + user notification
    const res = await axios.post(`${workerUrl}/api/topup/${reqId}/${action}`, {}, {
      headers: {
        'X-Init-Data': `owner_action=1&user=${JSON.stringify({ id: OWNER_ID })}`,
        'X-Internal-Secret': process.env.VPS_SECRET,
      },
    });

    const emoji = action === 'approve' ? '✅' : '❌';
    await bot.editMessageText(
      `${emoji} Top-up request *${action}d* by owner.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('[BOT] Topup action error:', e.message);
  }
}

async function handleBanUser(chatId, msgId, reqId, userId) {
  try {
    const axios = require('axios');
    await axios.put(`${process.env.WORKER_URL}/api/users/${userId}`, { is_banned: 1 }, {
      headers: { 'X-Internal-Secret': process.env.VPS_SECRET },
    });
    await bot.editMessageText(
      `🚫 User <code>${userId}</code> has been *banned*.`,
      { chat_id: chatId, message_id: msgId, parse_mode: 'Markdown' }
    );
    // Notify banned user
    await bot.sendMessage(userId,
      '🚫 *Your account has been banned.*\n\nContact support if you believe this is a mistake.',
      { parse_mode: 'Markdown' }
    ).catch(() => {});
  } catch (e) {
    console.error('[BOT] Ban error:', e.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────

async function sendSticker(chatId, filePath) {
  if (!bot) throw new Error('Bot not initialized');
  const stream = fs.createReadStream(filePath);
  const msg    = await bot.sendDocument(chatId, stream, {
    caption: '🎉 Your animated sticker is ready! Import it into your Telegram sticker pack.',
  }, {
    filename:    'sticker.tgs',
    contentType: 'application/x-tgsticker',
  });
  return msg?.document?.file_id;
}

async function notifyOwnerTopup({ request_id, user, amount, payment_method, invoice_file_id }) {
  if (!bot) return;
  try {
    const userName = user.first_name + (user.username ? ` (@${user.username})` : '');
    const text = `💳 *New Top-Up Request*\n\n👤 User: ${userName}\n🆔 ID: \`${user.id}\`\n💰 Amount: *${amount.toLocaleString()} Ks*\n🏦 Method: ${payment_method || 'Not specified'}`;

    const keyboard = {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `topup_approve:${request_id}` },
        { text: '❌ Reject',  callback_data: `topup_reject:${request_id}` },
      ], [
        { text: '🚫 Ban User', callback_data: `topup_ban:${request_id}:${user.id}` },
      ]],
    };

    if (invoice_file_id) {
      await bot.sendPhoto(OWNER_ID, invoice_file_id, {
        caption:       text,
        parse_mode:    'Markdown',
        reply_markup:  keyboard,
      });
    } else {
      await bot.sendMessage(OWNER_ID, text, { parse_mode: 'Markdown', reply_markup: keyboard });
    }
  } catch (e) {
    console.error('[BOT] notifyOwnerTopup error:', e.message);
  }
}

async function notifyUserTopupResult(userId, amount, action) {
  if (!bot) return;
  try {
    const msg = action === 'approve'
      ? `✅ *Top-Up Approved!*\n\n💰 *${amount.toLocaleString()} Ks* has been added to your balance.\n\nOpen the app to create your sticker!`
      : `❌ *Top-Up Rejected*\n\nYour request for ${amount.toLocaleString()} Ks was rejected.\n\nPlease contact support if this is an error.`;
    await bot.sendMessage(userId, msg, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('[BOT] notifyUserTopupResult error:', e.message);
  }
}

async function notifyUserBanned(userId) {
  if (!bot) return;
  try {
    await bot.sendMessage(userId,
      '🚫 *Your account has been banned.*\n\nContact the owner if you believe this is a mistake.',
      { parse_mode: 'Markdown' }
    );
  } catch (e) {}
}

module.exports = { init, sendSticker, notifyOwnerTopup, notifyUserTopupResult, notifyUserBanned };
