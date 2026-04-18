'use strict';
const express  = require('express');
const router   = express.Router();
const { generateSticker } = require('../engine/stickerGen');
const { sendSticker }     = require('../bot');
const path  = require('path');
const fs    = require('fs');

/**
 * POST /generate
 * Body: { template_id, logo_layer_path, logo_type, logo_data, transform, colors, user_id, chat_id }
 */
router.post('/', async (req, res) => {
  const { template_id, logo_layer_path, logo_type, logo_data, transform, colors, user_id, chat_id } = req.body;

  if (!template_id) return res.status(400).json({ error: 'template_id required' });
  if (!user_id)     return res.status(400).json({ error: 'user_id required' });

  let tgsPath = null;
  try {
    tgsPath = await generateSticker({
      template_id,
      logo_layer_path: logo_layer_path || [],
      logo_type:       logo_type || 'text',
      logo_data:       logo_data || {},
      transform:       transform || { x: 0, y: 0, scale: 1 },
      colors:          colors    || {},
      user_id,
    });

    // Send sticker to user via Telegram bot
    const targetId = chat_id || user_id;
    let fileId = null;
    try {
      fileId = await sendSticker(targetId, tgsPath);
    } catch (botErr) {
      console.error('[GENERATE] Bot send error:', botErr.message);
    }

    res.json({ success: true, file_id: fileId, size: fs.statSync(tgsPath).size });
  } catch (e) {
    console.error('[GENERATE] Error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    // Clean up temp file after 60s
    if (tgsPath) {
      setTimeout(() => fs.unlink(tgsPath, () => {}), 60000);
    }
  }
});

module.exports = router;
