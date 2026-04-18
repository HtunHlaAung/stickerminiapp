'use strict';
const fs   = require('fs');
const path = require('path');
const { parseTGS, compressToTGS, getLayerAtPath } = require('./tgsParser');
const { svgToLottieLayer, textToLottieLayer, hexToLottieRGB } = require('./svgToLottie');

const TEMPLATES_DIR = process.env.TEMPLATES_DIR || '/var/stickerminiapp/templates';
const EXPORTS_DIR   = process.env.EXPORTS_DIR   || '/var/stickerminiapp/exports';
const MAX_TGS_BYTES = 64 * 1024; // 64 KB Telegram limit

/**
 * Main sticker generation pipeline.
 *
 * @param {object} opts
 * @param {string}   opts.template_id
 * @param {number[]} opts.logo_layer_path  e.g. [0,2,1]
 * @param {string}   opts.logo_type        'text' | 'svg' | 'tgs'
 * @param {object}   opts.logo_data
 * @param {object}   opts.transform        { x, y, scale }
 * @param {object}   opts.colors           { '#oldHex': '#newHex', ... }
 * @param {string}   opts.user_id
 * @returns {string} path to generated .tgs file
 */
async function generateSticker(opts) {
  const { template_id, logo_layer_path, logo_type, logo_data, transform, colors, user_id } = opts;

  // 1. Load template JSON
  const tplPath = path.join(TEMPLATES_DIR, `${template_id}.json`);
  if (!fs.existsSync(tplPath)) throw new Error(`Template ${template_id} not found on VPS`);

  const json = JSON.parse(fs.readFileSync(tplPath, 'utf8'));

  // 2. Apply color edits
  if (colors && Object.keys(colors).length) {
    applyColorEdits(json, colors);
  }

  // 3. Build logo layer
  let logoLayer = null;

  if (logo_type === 'text' && logo_data?.text) {
    logoLayer = textToLottieLayer(
      logo_data.text,
      logo_data.color  || '#ffffff',
      logo_data.font   || 'Arial',
      transform
    );
  } else if (logo_type === 'svg' && logo_data?.svg) {
    logoLayer = svgToLottieLayer(logo_data.svg, transform);
  } else if (logo_type === 'tgs' && logo_data?.buffer) {
    const buf       = Buffer.from(logo_data.buffer, 'base64');
    const logoJson  = parseTGS(buf);
    logoLayer       = buildLogoLayerFromLottie(logoJson, transform);
  }

  // 4. Inject logo layer
  if (logoLayer && logo_layer_path && logo_layer_path.length > 0) {
    injectLogoLayer(json, logo_layer_path, logoLayer);
  } else if (logoLayer) {
    // Append as top layer
    json.layers.unshift(logoLayer);
  }

  // 5. Validate & normalize animation params
  ensureAnimationParams(json);

  // 6. Compress to TGS
  let tgsBuffer = compressToTGS(json);

  // 7. Size check — try to reduce if over limit
  if (tgsBuffer.length > MAX_TGS_BYTES) {
    tgsBuffer = await reduceSize(json, tgsBuffer);
  }

  if (tgsBuffer.length > MAX_TGS_BYTES) {
    throw new Error(`Generated sticker (${tgsBuffer.length} bytes) exceeds Telegram's 64KB limit. Simplify your logo.`);
  }

  // 8. Save to disk
  const outName = `${user_id}_${template_id}_${Date.now()}.tgs`;
  const outPath = path.join(EXPORTS_DIR, outName);
  fs.writeFileSync(outPath, tgsBuffer);

  return outPath;
}

// ── Color Editing ──────────────────────────────────────────────────────────

function applyColorEdits(json, colorMap) {
  // colorMap: { '#oldHex': '#newHex' }
  const entries = Object.entries(colorMap).map(([oldHex, newHex]) => ({
    old: hexToNormArray(oldHex),
    new: hexToLottieRGB(newHex).slice(0, 3),
  }));

  function patchColor(arr) {
    if (!Array.isArray(arr) || arr.length < 3) return;
    for (const entry of entries) {
      if (colorsMatch(arr, entry.old)) {
        arr[0] = entry.new[0];
        arr[1] = entry.new[1];
        arr[2] = entry.new[2];
        return;
      }
    }
  }

  function scanShape(s) {
    if (!s) return;
    if ((s.ty === 'fl' || s.ty === 'st') && s.c?.k) {
      if (Array.isArray(s.c.k) && typeof s.c.k[0] === 'number') {
        patchColor(s.c.k);
      } else if (Array.isArray(s.c.k)) {
        s.c.k.forEach(kf => {
          if (kf.s) patchColor(kf.s);
          if (kf.e) patchColor(kf.e);
        });
      }
    }
    if (s.it) s.it.forEach(scanShape);
  }

  function scanLayer(layer) {
    if (!layer) return;
    if (layer.shapes) layer.shapes.forEach(scanShape);
    if (layer.layers) layer.layers.forEach(scanLayer);
    // Text layer color
    if (layer.ty === 5 && layer.t?.d?.k) {
      layer.t.d.k.forEach(kf => {
        if (kf.s?.fc) patchColor(kf.s.fc);
        if (kf.s?.sc) patchColor(kf.s.sc);
      });
    }
  }

  (json.layers || []).forEach(scanLayer);
}

function hexToNormArray(hex) {
  hex = (hex || '#000').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c+c).join('');
  return [
    parseInt(hex.substring(0,2),16)/255,
    parseInt(hex.substring(2,4),16)/255,
    parseInt(hex.substring(4,6),16)/255,
  ];
}

function colorsMatch(a, b, tol = 0.04) {
  return Math.abs(a[0]-b[0]) < tol && Math.abs(a[1]-b[1]) < tol && Math.abs(a[2]-b[2]) < tol;
}

// ── Layer Injection ────────────────────────────────────────────────────────

function injectLogoLayer(json, logoLayerPath, logoLayer) {
  // Navigate to parent and replace the target layer index
  const pathCopy = [...logoLayerPath];
  const lastIdx  = pathCopy.pop();
  let layers     = json.layers;

  for (const idx of pathCopy) {
    if (!layers[idx]?.layers) {
      layers[idx].layers = [];
    }
    layers = layers[idx].layers;
  }

  // Replace target layer with logoLayer
  if (lastIdx < layers.length) {
    const target = layers[lastIdx];
    // Inherit animation timing from replaced layer
    logoLayer.ip = target.ip || 0;
    logoLayer.op = target.op || json.op || 60;
    logoLayer.st = target.st || 0;
    layers[lastIdx] = logoLayer;
  } else {
    layers.push(logoLayer);
  }
}

function buildLogoLayerFromLottie(logoJson, transform) {
  // Extract first layer from the logo lottie as a precomp-style group
  if (!logoJson.layers || !logoJson.layers.length) throw new Error('Empty TGS logo');
  const sc = transform.scale || 1;

  return {
    ddd: 0, ind: 99, ty: 4, nm: 'LOGO_LAYER', sr: 1,
    ks: {
      o: { a:0, k:100 },
      r: { a:0, k:0 },
      p: { a:0, k:[256+(transform.x||0), 256+(transform.y||0), 0] },
      a: { a:0, k:[0,0,0] },
      s: { a:0, k:[sc*100, sc*100, 100] },
    },
    ao: 0,
    shapes: logoJson.layers[0].shapes || [],
    ip: 0, op: 60, st: 0, bm: 0,
  };
}

// ── Animation param normalization ──────────────────────────────────────────

function ensureAnimationParams(json) {
  if (!json.fr) json.fr = 60;
  if (!json.ip) json.ip = 0;
  if (!json.op) json.op = 60;
  if (!json.w)  json.w  = 512;
  if (!json.h)  json.h  = 512;
  json.ddd = 0;

  // Ensure all layers have valid ip/op
  function fixLayer(l) {
    if (!l) return;
    if (l.ip == null) l.ip = 0;
    if (l.op == null) l.op = json.op;
    if (l.st == null) l.st = 0;
    if (l.layers) l.layers.forEach(fixLayer);
  }
  (json.layers || []).forEach(fixLayer);
}

// ── Size reduction ─────────────────────────────────────────────────────────

async function reduceSize(json, originalBuffer) {
  // Strategy 1: Remove markers
  delete json.markers;

  // Strategy 2: Reduce precision of numbers
  const str     = JSON.stringify(json, (key, val) => {
    if (typeof val === 'number') return parseFloat(val.toFixed(3));
    return val;
  });
  const reduced = compressToTGS(JSON.parse(str));
  if (reduced.length <= MAX_TGS_BYTES) return reduced;

  // Strategy 3: Remove extra metadata
  delete json.meta;
  delete json.nm;
  return compressToTGS(json);
}

module.exports = { generateSticker };
