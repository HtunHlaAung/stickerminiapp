'use strict';
const pako = require('pako');

/**
 * Parse a .tgs (gzip'd Lottie JSON) buffer and return the JSON object.
 */
function parseTGS(buffer) {
  try {
    const decompressed = pako.inflate(buffer, { to: 'string' });
    return JSON.parse(decompressed);
  } catch (e) {
    throw new Error('Invalid TGS file: ' + e.message);
  }
}

/**
 * Compress a Lottie JSON object to a .tgs buffer.
 */
function compressToTGS(json) {
  const str    = typeof json === 'string' ? json : JSON.stringify(json);
  const input  = new TextEncoder().encode(str);
  const output = pako.gzip(input, { level: 9 });
  return Buffer.from(output);
}

/**
 * Recursively extract all layer paths from a Lottie JSON.
 * Returns an array of { path, name, type, ind }
 */
function extractLayerTree(json) {
  const tree = [];

  function walk(layers, pathSoFar) {
    if (!Array.isArray(layers)) return;
    layers.forEach((layer, idx) => {
      const currentPath = [...pathSoFar, idx];
      tree.push({
        path:     currentPath,
        name:     layer.nm  || `Layer ${idx}`,
        type:     layer.ty,
        typeName: layerTypeName(layer.ty),
        ind:      layer.ind,
        hasChildren: Array.isArray(layer.layers) && layer.layers.length > 0,
        isShape:  layer.ty === 4,
        isText:   layer.ty === 5,
        isImage:  layer.ty === 2,
        isNull:   layer.ty === 3,
      });
      if (Array.isArray(layer.layers)) {
        walk(layer.layers, currentPath);
      }
    });
  }

  walk(json.layers || [], []);
  return tree;
}

function layerTypeName(ty) {
  const types = {
    0: 'Precomp', 1: 'Solid', 2: 'Image',
    3: 'Null',    4: 'Shape', 5: 'Text',
    6: 'Audio',   7: 'Video', 8: 'ImageSeq',
    9: 'SubForm', 10: 'Data',
  };
  return types[ty] || `Type ${ty}`;
}

/**
 * Get a layer at a given path from the Lottie JSON.
 */
function getLayerAtPath(json, path) {
  let layers = json.layers;
  let layer  = null;
  for (let i = 0; i < path.length; i++) {
    const idx = path[i];
    if (!Array.isArray(layers) || idx >= layers.length) return null;
    layer  = layers[idx];
    layers = layer.layers || [];
  }
  return layer;
}

/**
 * Extract all colors from a Lottie JSON.
 * Returns array of { path, color: [r,g,b] normalized 0-1 }
 */
function extractColors(json) {
  const colors = [];

  function hexToNorm(hex) {
    hex = hex.replace('#', '');
    return [
      parseInt(hex.substring(0, 2), 16) / 255,
      parseInt(hex.substring(2, 4), 16) / 255,
      parseInt(hex.substring(4, 6), 16) / 255,
    ];
  }

  function scanValue(val, path) {
    if (!val) return;
    // Color keyframe array (4 floats)
    if (Array.isArray(val) && val.length >= 3 && typeof val[0] === 'number' && val[0] <= 1 && val[1] <= 1 && val[2] <= 1) {
      colors.push({ path, color: val.slice(0, 3) });
      return;
    }
    if (typeof val === 'object') {
      if (val.k !== undefined) {
        if (Array.isArray(val.k) && val.k.length >= 3 && typeof val.k[0] === 'number') {
          colors.push({ path: [...path, 'k'], color: val.k.slice(0, 3) });
        } else if (Array.isArray(val.k)) {
          val.k.forEach((kf, i) => {
            if (kf.s) scanValue(kf.s, [...path, 'k', i, 's']);
            if (kf.e) scanValue(kf.e, [...path, 'k', i, 'e']);
          });
        }
      }
    }
  }

  function scanShape(shape, path) {
    if (!shape) return;
    if (shape.ty === 'fl' || shape.ty === 'st') {
      scanValue(shape.c, [...path, 'c']);
    }
    if (shape.it) shape.it.forEach((s, i) => scanShape(s, [...path, 'it', i]));
  }

  function scanLayer(layer, path) {
    if (!layer) return;
    if (layer.shapes) layer.shapes.forEach((s, i) => scanShape(s, [...path, 'shapes', i]));
    if (layer.layers) layer.layers.forEach((l, i) => scanLayer(l, [...path, 'layers', i]));
  }

  (json.layers || []).forEach((l, i) => scanLayer(l, ['layers', i]));
  return colors;
}

/**
 * Group similar colors together (within a threshold).
 */
function groupColors(colors, threshold = 0.05) {
  const groups = [];

  colors.forEach(entry => {
    const [r, g, b] = entry.color;
    const existing  = groups.find(g => {
      return Math.abs(g.r - r) < threshold &&
             Math.abs(g.g - g) < threshold &&
             Math.abs(g.b - b) < threshold;
    });
    if (existing) {
      existing.paths.push(entry.path);
    } else {
      groups.push({ r, g, b, paths: [entry.path] });
    }
  });

  return groups.map(g => ({
    hex:   rgbNormToHex(g.r, g.g, g.b),
    paths: g.paths,
  }));
}

function rgbNormToHex(r, g, b) {
  const toHex = v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

module.exports = { parseTGS, compressToTGS, extractLayerTree, getLayerAtPath, extractColors, groupColors, rgbNormToHex };
