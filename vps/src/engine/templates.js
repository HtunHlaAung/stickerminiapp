'use strict';
const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const { parseTGS, extractLayerTree, extractColors, groupColors } = require('../engine/tgsParser');

const TEMPLATES_DIR = process.env.TEMPLATES_DIR || '/var/stickerminiapp/templates';

// POST /templates/cache — store template JSON locally
router.post('/cache', (req, res) => {
  const { template_id, json_data } = req.body;
  if (!template_id || !json_data) return res.status(400).json({ error: 'template_id and json_data required' });

  try {
    const filePath = path.join(TEMPLATES_DIR, `${template_id}.json`);
    fs.writeFileSync(filePath, typeof json_data === 'string' ? json_data : JSON.stringify(json_data));
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /templates/layers — extract layer tree from uploaded JSON/TGS (base64)
router.post('/layers', (req, res) => {
  const { json_data, tgs_base64 } = req.body;

  try {
    let lottieJson;
    if (tgs_base64) {
      const buf = Buffer.from(tgs_base64, 'base64');
      lottieJson = parseTGS(buf);
    } else if (json_data) {
      lottieJson = typeof json_data === 'string' ? JSON.parse(json_data) : json_data;
    } else {
      return res.status(400).json({ error: 'json_data or tgs_base64 required' });
    }

    const layers  = extractLayerTree(lottieJson);
    const colors  = extractColors(lottieJson);
    const grouped = groupColors(colors);

    res.json({
      layers,
      colors: grouped,
      meta: {
        w:  lottieJson.w  || 512,
        h:  lottieJson.h  || 512,
        fr: lottieJson.fr || 60,
        ip: lottieJson.ip || 0,
        op: lottieJson.op || 60,
      },
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /templates/:id — remove cached file
router.delete('/:id', (req, res) => {
  const filePath = path.join(TEMPLATES_DIR, `${req.params.id}.json`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  res.json({ success: true });
});

module.exports = router;
