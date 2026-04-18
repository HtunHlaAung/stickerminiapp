'use strict';
const { SVGPathData, SVGPathDataTransformer } = require('svg-pathdata');

function staticValue(val) {
  return { a: 0, k: val, ix: 0 };
}

function hexToLottieRGB(hex) {
  hex = (hex || '#000000').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  return [
    parseFloat((parseInt(hex.substring(0,2),16)/255).toFixed(4)),
    parseFloat((parseInt(hex.substring(2,4),16)/255).toFixed(4)),
    parseFloat((parseInt(hex.substring(4,6),16)/255).toFixed(4)),
    1,
  ];
}

function parseSvgColor(color) {
  if (!color || color === 'none' || color === 'transparent') return [0,0,0,1];
  if (color.startsWith('#')) return hexToLottieRGB(color);
  const rgb = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (rgb) return [+rgb[1]/255, +rgb[2]/255, +rgb[3]/255, 1];
  const named = { black:[0,0,0,1], white:[1,1,1,1], red:[1,0,0,1], blue:[0,0,1,1] };
  return named[color.toLowerCase()] || [0,0,0,1];
}

function parseAttrs(attrStr) {
  const attrs = {};
  const re = /(\w[\w:-]*)=["']([^"']*)["']/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

function pathToLottieVertices(svgPath) {
  try {
    const data = new SVGPathData(svgPath).toAbs().normalizeHVZ()
      .transform(SVGPathDataTransformer.NORMALIZE_ST());
    const cmds = data.commands;
    const v=[], i=[], o=[];
    let closed=false, curX=0, curY=0;

    cmds.forEach(cmd => {
      if (cmd.type === SVGPathData.MOVE_TO) {
        curX=cmd.x; curY=cmd.y;
        v.push([curX,curY]); i.push([0,0]); o.push([0,0]);
      } else if (cmd.type === SVGPathData.LINE_TO) {
        curX=cmd.x; curY=cmd.y;
        v.push([curX,curY]); i.push([0,0]); o.push([0,0]);
      } else if (cmd.type === SVGPathData.CURVE_TO) {
        if (o.length) o[o.length-1] = [cmd.x1-curX, cmd.y1-curY];
        curX=cmd.x; curY=cmd.y;
        v.push([curX,curY]); i.push([cmd.x2-curX, cmd.y2-curY]); o.push([0,0]);
      } else if (cmd.type === SVGPathData.CLOSE_PATH) {
        closed=true;
      }
    });
    if (!v.length) return null;
    return { i, o, v, c: closed };
  } catch (e) { return null; }
}

function elementToLottieShape(tag, attrs) {
  let pathData = null;
  if (tag === 'path') {
    pathData = attrs.d || attrs.D;
  } else if (tag === 'rect') {
    const x=+attrs.x||0, y=+attrs.y||0, w=+attrs.width||0, h=+attrs.height||0;
    pathData = `M${x},${y} H${x+w} V${y+h} H${x} Z`;
  } else if (tag === 'circle') {
    const cx=+attrs.cx||0, cy=+attrs.cy||0, r=+attrs.r||0;
    pathData = `M${cx-r},${cy} A${r},${r},0,1,1,${cx+r},${cy} A${r},${r},0,1,1,${cx-r},${cy} Z`;
  } else if (tag === 'ellipse') {
    const cx=+attrs.cx||0,cy=+attrs.cy||0,rx=+attrs.rx||0,ry=+attrs.ry||0;
    pathData = `M${cx-rx},${cy} A${rx},${ry},0,1,1,${cx+rx},${cy} A${rx},${ry},0,1,1,${cx-rx},${cy} Z`;
  } else if (tag === 'polygon' || tag === 'polyline') {
    const pts = (attrs.points||'').trim().split(/[\s,]+/);
    if (pts.length < 4) return null;
    let d = `M${pts[0]},${pts[1]}`;
    for (let k=2; k<pts.length; k+=2) d += ` L${pts[k]},${pts[k+1]}`;
    if (tag==='polygon') d += ' Z';
    pathData = d;
  }
  if (!pathData) return null;

  const vertices = pathToLottieVertices(pathData);
  if (!vertices) return null;

  const fillColor = parseSvgColor(attrs.fill || '#000000');
  const fillOpacity = attrs['fill-opacity'] != null ? +attrs['fill-opacity']*100 : 100;

  const items = [
    { ty:'sh', nm:'Path', ks:{ a:0, k:vertices } },
    { ty:'fl', nm:'Fill', o:staticValue(fillOpacity), c:staticValue(fillColor), r:1 },
  ];

  if (attrs.stroke && attrs.stroke !== 'none') {
    items.push({
      ty:'st', nm:'Stroke',
      o:staticValue(100), c:staticValue(parseSvgColor(attrs.stroke)),
      w:staticValue(+(attrs['stroke-width']||1)), lc:2, lj:2, ml:4,
    });
  }

  items.push({ ty:'tr', p:staticValue([0,0]), a:staticValue([0,0]), s:staticValue([100,100]), r:staticValue(0), o:staticValue(100) });
  return { ty:'gr', nm:'Shape', it:items };
}

function svgToLottieLayer(svgString, transform={}) {
  const shapes=[];
  const tags = ['path','rect','circle','ellipse','polygon','polyline'];

  tags.forEach(tag => {
    const re = new RegExp(`<${tag}([^>]*?)\\s*/?>`, 'gi');
    let m;
    while ((m = re.exec(svgString)) !== null) {
      const s = elementToLottieShape(tag, parseAttrs(m[1]));
      if (s) shapes.push(s);
    }
  });

  if (!shapes.length) throw new Error('No convertible shapes found in SVG');

  const sc = transform.scale||1, tx = transform.x||0, ty2 = transform.y||0;

  return {
    ddd:0, ind:99, ty:4, nm:'LOGO_LAYER', sr:1,
    ks:{
      o:staticValue(100), r:staticValue(0),
      p:staticValue([256+tx, 256+ty2, 0]),
      a:staticValue([0,0,0]),
      s:staticValue([sc*100, sc*100, 100]),
    },
    ao:0,
    shapes:[{ ty:'gr', nm:'Logo', it:[...shapes, { ty:'tr', p:staticValue([0,0]), a:staticValue([0,0]), s:staticValue([100,100]), r:staticValue(0), o:staticValue(100), sk:staticValue(0), sa:staticValue(0) }] }],
    ip:0, op:60, st:0, bm:0,
  };
}

function textToLottieLayer(text, color, fontFamily, transform={}) {
  const sc = transform.scale||1;
  return {
    ddd:0, ind:99, ty:5, nm:'LOGO_TEXT', sr:1,
    ks:{
      o:staticValue(100), r:staticValue(0),
      p:staticValue([256+(transform.x||0), 256+(transform.y||0), 0]),
      a:staticValue([0,0,0]),
      s:staticValue([sc*100, sc*100, 100]),
    },
    ao:0,
    t:{
      d:{ k:[{ s:{ s:48, f:fontFamily||'Arial', t:text, j:1, tr:0, lh:57.6, ls:0, fc:hexToLottieRGB(color||'#ffffff').slice(0,3) }, t:0 }] },
      p:{}, m:{ g:1, a:staticValue([0,0]) }, a:[],
    },
    ip:0, op:60, st:0, bm:0,
  };
}

module.exports = { svgToLottieLayer, textToLottieLayer, hexToLottieRGB };
