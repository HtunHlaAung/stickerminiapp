// ============================================================
//  Magic Sticker — Cloudflare Worker API  (FIXED v2)
//  Fixes:
//   1. isOwner/isAdmin/isReseller helpers now defined
//   2. Route ordering fixed (specific before generic /:id)
//   3. colour_groups saved in template INSERT + UPDATE
//   4. Template JSON accessible to ALL authenticated users
//   5. Owner panel auth via X-Owner-Secret header
//   6. /api/templates/layers route now reachable
//   7. /:id regex tightened to not catch named sub-paths
// ============================================================

const OWNER_ID = '1849257766';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Init-Data,X-Owner-Secret',
  'Access-Control-Max-Age':       '86400',
};

// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
function err(msg, status = 400) { return json({ error: msg }, status); }
function nanoid() { return crypto.randomUUID().replace(/-/g, '').substring(0, 16); }

// ── FIX #1: Role helpers (were completely missing before) ──────
function isOwner(user)    { return user?.role === 'owner'; }
function isAdmin(user)    { return user?.role === 'admin'    || isOwner(user); }
function isReseller(user) { return user?.role === 'reseller' || isAdmin(user); }

// ─────────────────────────────────────────────────────────────
//  TELEGRAM INIT-DATA VALIDATION  (HMAC-SHA256)
// ─────────────────────────────────────────────────────────────

async function validateTelegramData(initData, botToken) {
  try {
    const params = new URLSearchParams(initData);
    const hash   = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const pairs = [...params.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const enc = new TextEncoder();

    const secretKey = await crypto.subtle.importKey(
      'raw', enc.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const secretBytes = await crypto.subtle.sign('HMAC', secretKey, enc.encode(botToken));

    const hmacKey = await crypto.subtle.importKey(
      'raw', secretBytes,
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(pairs));
    const hex = Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, '0')).join('');

    if (hex !== hash) return null;

    const userStr = params.get('user');
    return userStr ? JSON.parse(userStr) : null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
//  AUTH  (getUser)
// ─────────────────────────────────────────────────────────────

async function getUser(request, env) {
  // ── FIX #5: Owner panel bypass via X-Owner-Secret header ──────
  // owner.html sends this header so it can access the API
  // without needing Telegram initData
  const ownerSecret = request.headers.get('X-Owner-Secret');
  if (ownerSecret && ownerSecret === env.OWNER_SECRET) {
    let owner = await env.DB.prepare(
      'SELECT * FROM users WHERE id=?'
    ).bind(OWNER_ID).first();
    if (!owner) {
      await env.DB.prepare(
        'INSERT OR IGNORE INTO users (id,username,first_name,role,balance) VALUES (?,?,?,?,0)'
      ).bind(OWNER_ID, 'owner', 'Owner', 'owner').run();
      owner = await env.DB.prepare(
        'SELECT * FROM users WHERE id=?'
      ).bind(OWNER_ID).first();
    }
    return owner;
  }

  // ── Dev mode (set DEV_MODE=true in Cloudflare vars) ──────────
  if (env.DEV_MODE === 'true') {
    const devId = request.headers.get('X-Dev-User-Id') || OWNER_ID;
    let u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(devId).first();
    if (!u) {
      const role = devId === OWNER_ID ? 'owner' : 'user';
      await env.DB.prepare(
        'INSERT OR IGNORE INTO users (id,username,first_name,role,balance) VALUES (?,?,?,?,0)'
      ).bind(devId, 'dev', 'Dev User', role).run();
      u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(devId).first();
    }
    return u;
  }

  // ── Normal Telegram WebApp auth ───────────────────────────────
  const initData = request.headers.get('X-Init-Data') || '';
  if (!initData) return null;

  const tgUser = await validateTelegramData(initData, env.BOT_TOKEN);
  if (!tgUser) return null;

  const userId = String(tgUser.id);

  const existing = await env.DB.prepare(
    'SELECT * FROM users WHERE id=?'
  ).bind(userId).first();

  // Block banned users immediately
  if (existing?.is_banned) return null;

  if (!existing) {
    // Auto-create account
    const role = userId === OWNER_ID ? 'owner' : 'user';
    await env.DB.prepare(
      'INSERT INTO users (id,username,first_name,last_name,photo_url,role,balance) VALUES (?,?,?,?,?,?,0)'
    ).bind(
      userId,
      tgUser.username   || '',
      tgUser.first_name || '',
      tgUser.last_name  || '',
      tgUser.photo_url  || '',
      role,
    ).run();
  } else {
    // Refresh Telegram profile data on every login
    await env.DB.prepare(
      'UPDATE users SET username=?,first_name=?,last_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?'
    ).bind(
      tgUser.username   || '',
      tgUser.first_name || '',
      tgUser.last_name  || '',
      userId,
    ).run();
  }

  return await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(userId).first();
}

// ─────────────────────────────────────────────────────────────
//  PRICE CALCULATOR
// ─────────────────────────────────────────────────────────────

function calcPrice(template, user) {
  if (!user || isAdmin(user))   return 0;
  if (user.role === 'reseller') return Number(template.reseller_price ?? template.price);
  return Number(template.price);
}

// ─────────────────────────────────────────────────────────────
//  VPS PROXY
// ─────────────────────────────────────────────────────────────

async function vpsPost(path, body, env) {
  const vpsUrl = env.VPS_URL || 'http://139.180.208.16:3000';
  const res = await fetch(`${vpsUrl}${path}`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Secret':     env.VPS_SECRET,
    },
    body: JSON.stringify(body),
    cf:   { cacheTtl: 0, cacheEverything: false },
  });
  return res;
}

// ─────────────────────────────────────────────────────────────
//  ROUTE REGEXES — FIX #7: tight patterns, won't shadow sub-paths
//  Template IDs are 16-char hex (nanoid). Named sub-paths like
//  "upload-json" and "layers" will never match these patterns.
// ─────────────────────────────────────────────────────────────

const TPL_ID_RE    = /^\/api\/templates\/([a-f0-9]{12,32})$/;
const TPL_JSON_RE  = /^\/api\/templates\/([a-f0-9]{12,32})\/json$/;
const USER_ID_RE   = /^\/api\/users\/([^/]+)$/;
const FONT_ID_RE   = /^\/api\/fonts\/([^/]+)$/;
const TOPUP_ACT_RE = /^\/api\/topup\/([^/]+)\/(approve|reject)$/;

// ─────────────────────────────────────────────────────────────
//  MAIN FETCH HANDLER
// ─────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    // CORS preflight
    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    // ── Public routes (no auth needed) ───────────────────────────

    if (path === '/api/settings' && method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT key,value FROM settings'
      ).all();
      const s = {};
      results.forEach(r => (s[r.key] = r.value));
      return json(s);
    }

    if (path === '/api/categories' && method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM categories ORDER BY sort_order'
      ).all();
      return json(results);
    }

    // ── Resolve authenticated user ────────────────────────────────
    const user = await getUser(request, env);

    if (path === '/api/auth' && method === 'POST') {
      if (!user) return err('Invalid Telegram data — open from Telegram', 401);
      return json({ user });
    }

    if (!user) return err('Unauthorized', 401);

    if (path === '/api/me' && method === 'GET') return json({ user });

    // ════════════════════════════════════════════════════════════
    //  TEMPLATES
    //  IMPORTANT: specific named sub-paths MUST come before /:id
    // ════════════════════════════════════════════════════════════

    // POST /api/templates/upload-json  — store Lottie JSON in KV
    // FIX #2: This is now BEFORE the /:id routes
    if (path === '/api/templates/upload-json' && method === 'POST') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const body = await request.json();
      const { template_id, json_data } = body;
      if (!template_id || !json_data)
        return err('template_id and json_data required');

      const jsonStr = typeof json_data === 'string'
        ? json_data : JSON.stringify(json_data);

      // Save raw JSON to KV (used for preview & generation)
      await env.KV.put(`template:${template_id}`, jsonStr);

      // Also cache on VPS disk (faster generation)
      const parsed = typeof json_data === 'string'
        ? JSON.parse(json_data) : json_data;
      await vpsPost('/templates/cache', { template_id, json_data: parsed }, env)
        .catch(e => console.error('VPS cache error:', e.message));

      return json({ success: true });
    }

    // POST /api/templates/layers  — extract layer tree via VPS
    // FIX #6: This was unreachable before (caught by /:id regex)
    if (path === '/api/templates/layers' && method === 'POST') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const body = await request.json();
      try {
        const res = await vpsPost('/templates/layers', body, env);
        if (!res.ok) {
          const e = await res.json().catch(() => ({}));
          return err(e.error || 'VPS layer extraction failed', 500);
        }
        return json(await res.json());
      } catch (e) {
        return err('VPS unreachable: ' + e.message, 503);
      }
    }

    // GET /api/templates  — list (all authenticated users)
    if (path === '/api/templates' && method === 'GET') {
      const cat    = url.searchParams.get('category') || '';
      const search = url.searchParams.get('search')   || '';
      let q = 'SELECT * FROM templates WHERE is_active=1';
      const params = [];
      if (cat && cat !== 'all') { q += ' AND category=?'; params.push(cat); }
      if (search)               { q += ' AND name LIKE ?'; params.push(`%${search}%`); }
      q += ' ORDER BY sort_order ASC, created_at DESC';

      const { results } = await env.DB.prepare(q).bind(...params).all();
      return json(results.map(t => ({
        ...t,
        user_price:      calcPrice(t, user),
        logo_layer_path: t.logo_layer_path ? JSON.parse(t.logo_layer_path) : null,
        colour_groups:   t.colour_groups || '[]',
      })));
    }

    // POST /api/templates  — create (owner only)
    // FIX #3: colour_groups now included in INSERT
    if (path === '/api/templates' && method === 'POST') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const body = await request.json();
      const {
        name, category, type, price, reseller_price,
        logo_layer_path, logo_layer_name, colour_groups,
      } = body;
      if (!name) return err('name required');

      const tid = nanoid();
      await env.DB.prepare(
        `INSERT INTO templates
           (id, name, category, type, price, reseller_price,
            logo_layer_path, logo_layer_name, colour_groups)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).bind(
        tid,
        name,
        category || '',
        type || 'regular',
        Number(price) || 0,
        Number(reseller_price) || 0,
        logo_layer_path
          ? JSON.stringify(logo_layer_path) : null,
        logo_layer_name || '',
        colour_groups
          ? (typeof colour_groups === 'string' ? colour_groups : JSON.stringify(colour_groups))
          : '[]',
      ).run();

      return json({ id: tid, success: true });
    }

    // GET /api/templates/:id  — single template detail
    // FIX #7: Uses TPL_ID_RE — won't catch "upload-json" or "layers"
    if (TPL_ID_RE.test(path) && method === 'GET') {
      const tid = TPL_ID_RE.exec(path)[1];
      const t   = await env.DB.prepare(
        'SELECT * FROM templates WHERE id=? AND is_active=1'
      ).bind(tid).first();
      if (!t) return err('Template not found', 404);
      return json({
        ...t,
        user_price:      calcPrice(t, user),
        logo_layer_path: t.logo_layer_path ? JSON.parse(t.logo_layer_path) : null,
        colour_groups:   t.colour_groups || '[]',
      });
    }

    // PUT /api/templates/:id  — update (owner only)
    // FIX #3: colour_groups now included in UPDATE
    if (TPL_ID_RE.test(path) && method === 'PUT') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const tid  = TPL_ID_RE.exec(path)[1];
      const body = await request.json();
      const {
        name, category, type, price, reseller_price,
        logo_layer_path, logo_layer_name, colour_groups,
        is_active, sort_order,
      } = body;

      await env.DB.prepare(
        `UPDATE templates SET
           name=?, category=?, type=?, price=?, reseller_price=?,
           logo_layer_path=?, logo_layer_name=?, colour_groups=?,
           is_active=?, sort_order=?, updated_at=CURRENT_TIMESTAMP
         WHERE id=?`
      ).bind(
        name,
        category || '',
        type || 'regular',
        Number(price) || 0,
        Number(reseller_price) || 0,
        logo_layer_path
          ? JSON.stringify(logo_layer_path) : null,
        logo_layer_name || '',
        colour_groups
          ? (typeof colour_groups === 'string' ? colour_groups : JSON.stringify(colour_groups))
          : '[]',
        is_active  ?? 1,
        sort_order ?? 0,
        tid,
      ).run();

      return json({ success: true });
    }

    // DELETE /api/templates/:id  — soft delete (owner only)
    if (TPL_ID_RE.test(path) && method === 'DELETE') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const tid = TPL_ID_RE.exec(path)[1];
      await env.DB.prepare(
        'UPDATE templates SET is_active=0 WHERE id=?'
      ).bind(tid).run();
      await env.KV.delete(`template:${tid}`).catch(() => {});
      return json({ success: true });
    }

    // GET /api/templates/:id/json  — load raw Lottie JSON from KV
    // FIX #4: accessible to ALL authenticated users (was isAdmin-only)
    if (TPL_JSON_RE.test(path) && method === 'GET') {
      const tid  = TPL_JSON_RE.exec(path)[1];
      const data = await env.KV.get(`template:${tid}`);
      if (!data) return err('Template JSON not found — upload animation first', 404);
      return new Response(data, {
        headers: { 'Content-Type': 'application/json', ...CORS },
      });
    }

    // ════════════════════════════════════════════════════════════
    //  CATEGORIES
    // ════════════════════════════════════════════════════════════

    if (path === '/api/categories' && method === 'POST') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const { name } = await request.json();
      if (!name) return err('name required');
      const id = name.toLowerCase().replace(/\s+/g, '-');
      await env.DB.prepare(
        'INSERT OR IGNORE INTO categories (id,name) VALUES (?,?)'
      ).bind(id, name).run();
      return json({ id, name, success: true });
    }

    if (path === '/api/categories' && method === 'DELETE') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const { id } = await request.json();
      if (!id) return err('id required');
      await env.DB.prepare('DELETE FROM categories WHERE id=?').bind(id).run();
      return json({ success: true });
    }

    // ════════════════════════════════════════════════════════════
    //  ORDERS
    // ════════════════════════════════════════════════════════════

    if (path === '/api/orders' && method === 'GET') {
      const { results } = await env.DB.prepare(
        `SELECT o.*, t.name AS template_name
         FROM orders o
         JOIN templates t ON o.template_id = t.id
         WHERE o.user_id = ?
         ORDER BY o.created_at DESC
         LIMIT 50`
      ).bind(user.id).all();
      return json(results);
    }

    // ════════════════════════════════════════════════════════════
    //  GENERATE — EXPORT STICKER
    // ════════════════════════════════════════════════════════════

    if (path === '/api/generate' && method === 'POST') {
      const body = await request.json();
      const { template_id, logo_type, logo_data, transform, colors } = body;
      if (!template_id) return err('template_id required');

      const template = await env.DB.prepare(
        'SELECT * FROM templates WHERE id=? AND is_active=1'
      ).bind(template_id).first();
      if (!template) return err('Template not found', 404);

      const price = calcPrice(template, user);

      // Balance check
      if (!isAdmin(user) && user.balance < price) {
        return err(
          `Insufficient balance. Need ${price} Ks, have ${user.balance} Ks.`,
          402
        );
      }

      // Atomic deduction — WHERE clause prevents double-spend
      if (!isAdmin(user) && price > 0) {
        const deduct = await env.DB.prepare(
          'UPDATE users SET balance=balance-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND balance>=?'
        ).bind(price, user.id, price).run();

        if (!deduct.meta?.changes || deduct.meta.changes === 0) {
          return err('Insufficient balance', 402);
        }
      }

      // Forward to VPS
      try {
        const vpsRes = await vpsPost('/generate', {
          template_id,
          logo_layer_path: template.logo_layer_path
            ? JSON.parse(template.logo_layer_path) : null,
          logo_type,
          logo_data,
          transform: transform || { x: 0, y: 0, scale: 1 },
          colors:    colors   || {},
          user_id:   user.id,
          chat_id:   user.id,
        }, env);

        if (!vpsRes.ok) {
          // Refund balance
          if (!isAdmin(user) && price > 0) {
            await env.DB.prepare(
              'UPDATE users SET balance=balance+? WHERE id=?'
            ).bind(price, user.id).run();
          }
          const e = await vpsRes.json().catch(() => ({}));
          return err(e.error || 'Sticker generation failed', 500);
        }

        const result = await vpsRes.json();

        // Record order
        const orderId = nanoid();
        await env.DB.prepare(
          'INSERT INTO orders (id,user_id,template_id,price_paid,tgs_file_id,logo_type) VALUES (?,?,?,?,?,?)'
        ).bind(
          orderId, user.id, template_id, price,
          result.file_id || '', logo_type || '',
        ).run();

        const updatedUser = await env.DB.prepare(
          'SELECT balance FROM users WHERE id=?'
        ).bind(user.id).first();

        return json({
          success:  true,
          order_id: orderId,
          file_id:  result.file_id,
          balance:  updatedUser.balance,
        });

      } catch (e) {
        // Refund on network error
        if (!isAdmin(user) && price > 0) {
          await env.DB.prepare(
            'UPDATE users SET balance=balance+? WHERE id=?'
          ).bind(price, user.id).run();
        }
        return err('VPS unreachable: ' + e.message, 503);
      }
    }

    // ════════════════════════════════════════════════════════════
    //  TOP-UP
    // ════════════════════════════════════════════════════════════

    if (path === '/api/topup' && method === 'POST') {
      const body = await request.json();
      const { amount, payment_method, invoice_file_id } = body;

      const minRow = await env.DB.prepare(
        "SELECT value FROM settings WHERE key='topup_min'"
      ).first();
      const maxRow = await env.DB.prepare(
        "SELECT value FROM settings WHERE key='topup_max'"
      ).first();
      const min = parseInt(minRow?.value || '500');
      const max = parseInt(maxRow?.value || '50000');

      if (!amount || amount < min || amount > max)
        return err(`Amount must be between ${min} and ${max} Ks`);
      if (amount % 500 !== 0)
        return err('Amount must be a multiple of 500 Ks');

      const reqId = nanoid();
      await env.DB.prepare(
        'INSERT INTO topup_requests (id,user_id,amount,payment_method,invoice_file_id) VALUES (?,?,?,?,?)'
      ).bind(reqId, user.id, amount, payment_method || '', invoice_file_id || '').run();

      await vpsPost('/notify/topup', {
        request_id:     reqId,
        user:           { id: user.id, username: user.username, first_name: user.first_name },
        amount,
        payment_method,
        invoice_file_id,
      }, env).catch(e => console.error('notify/topup:', e.message));

      return json({ success: true, request_id: reqId });
    }

    if (path === '/api/topup' && method === 'GET') {
      if (!isOwner(user)) {
        const { results } = await env.DB.prepare(
          'SELECT * FROM topup_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 20'
        ).bind(user.id).all();
        return json(results);
      }
      const status = url.searchParams.get('status') || '';
      let q = `SELECT r.*, u.username, u.first_name
               FROM topup_requests r JOIN users u ON r.user_id=u.id`;
      const params = [];
      if (status) { q += ' WHERE r.status=?'; params.push(status); }
      q += ' ORDER BY r.created_at DESC LIMIT 100';
      const { results } = await env.DB.prepare(q).bind(...params).all();
      return json(results);
    }

    // POST /api/topup/:id/approve|reject  (owner only)
    if (TOPUP_ACT_RE.test(path) && method === 'POST') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const [, reqId, action] = TOPUP_ACT_RE.exec(path);

      const req = await env.DB.prepare(
        'SELECT * FROM topup_requests WHERE id=?'
      ).bind(reqId).first();
      if (!req)                    return err('Request not found', 404);
      if (req.status !== 'pending') return err('Already reviewed');

      await env.DB.prepare(
        'UPDATE topup_requests SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?'
      ).bind(action === 'approve' ? 'approved' : 'rejected', user.id, reqId).run();

      if (action === 'approve') {
        await env.DB.prepare(
          'UPDATE users SET balance=balance+?,updated_at=CURRENT_TIMESTAMP WHERE id=?'
        ).bind(req.amount, req.user_id).run();
      }

      await vpsPost('/notify/topup-result', {
        user_id: req.user_id,
        amount:  req.amount,
        action,
      }, env).catch(e => console.error('notify/topup-result:', e.message));

      return json({ success: true });
    }

    // ════════════════════════════════════════════════════════════
    //  USERS  (owner management)
    // ════════════════════════════════════════════════════════════

    if (path === '/api/users' && method === 'GET') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const search = url.searchParams.get('search') || '';
      let q = 'SELECT * FROM users';
      const params = [];
      if (search) {
        q += ' WHERE first_name LIKE ? OR username LIKE ? OR id=?';
        params.push(`%${search}%`, `%${search}%`, search);
      }
      q += ' ORDER BY created_at DESC LIMIT 200';
      const { results } = await env.DB.prepare(q).bind(...params).all();
      return json(results);
    }

    if (USER_ID_RE.test(path) && method === 'PUT') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const uid  = USER_ID_RE.exec(path)[1];
      const body = await request.json();

      if (uid === OWNER_ID) return err('Cannot modify the owner account');

      const { role, balance, is_banned } = body;
      const fields = [];
      const params = [];

      if (role      !== undefined) { fields.push('role=?');      params.push(role); }
      if (balance   !== undefined) { fields.push('balance=?');   params.push(Number(balance)); }
      if (is_banned !== undefined) { fields.push('is_banned=?'); params.push(is_banned ? 1 : 0); }

      if (!fields.length) return err('Nothing to update');
      fields.push('updated_at=CURRENT_TIMESTAMP');
      params.push(uid);

      await env.DB.prepare(
        `UPDATE users SET ${fields.join(',')} WHERE id=?`
      ).bind(...params).run();

      if (is_banned) {
        await vpsPost('/notify/ban', { user_id: uid }, env)
          .catch(e => console.error('notify/ban:', e.message));
      }

      return json({ success: true });
    }

    // ════════════════════════════════════════════════════════════
    //  FONTS
    // ════════════════════════════════════════════════════════════

    if (path === '/api/fonts' && method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT * FROM fonts ORDER BY name ASC'
      ).all();
      return json(results);
    }

    if (path === '/api/fonts' && method === 'POST') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const { name, url, type } = await request.json();
      if (!name) return err('name required');
      const id = nanoid();
      await env.DB.prepare(
        'INSERT INTO fonts (id,name,url,type) VALUES (?,?,?,?)'
      ).bind(id, name, url || '', type || 'google').run();
      return json({ id, success: true });
    }

    if (FONT_ID_RE.test(path) && method === 'DELETE') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const fid = FONT_ID_RE.exec(path)[1];
      await env.DB.prepare('DELETE FROM fonts WHERE id=?').bind(fid).run();
      return json({ success: true });
    }

    // ════════════════════════════════════════════════════════════
    //  SETTINGS  (owner only for PUT)
    // ════════════════════════════════════════════════════════════

    if (path === '/api/settings' && method === 'PUT') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const body = await request.json();
      for (const [key, value] of Object.entries(body)) {
        await env.DB.prepare(
          'INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)'
        ).bind(key, String(value)).run();
      }
      return json({ success: true });
    }

    // ════════════════════════════════════════════════════════════
    //  FALLBACK
    // ════════════════════════════════════════════════════════════

    return err('Not found', 404);
  },
};
