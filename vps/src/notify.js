'use strict';
const express = require('express');
const router  = express.Router();
const bot     = require('../bot');

// POST /notify/topup — send owner topup notification
router.post('/topup', async (req, res) => {
  const { request_id, user, amount, payment_method, invoice_file_id } = req.body;
  try {
    await bot.notifyOwnerTopup({ request_id, user, amount, payment_method, invoice_file_id });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /notify/topup-result — notify user of topup outcome
router.post('/topup-result', async (req, res) => {
  const { user_id, amount, action } = req.body;
  try {
    await bot.notifyUserTopupResult(user_id, amount, action);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /notify/ban — notify user they are banned
router.post('/ban', async (req, res) => {
  const { user_id } = req.body;
  try {
    await bot.notifyUserBanned(user_id);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
