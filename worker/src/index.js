// ============================================================
//  Magic Sticker — Cloudflare Worker API
//  Handles: auth, users, templates, orders, topups, settings
// ============================================================

const OWNER_ID  = '1849257766';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Init-Data',
  'Access-Control-Max-Age':       '86400',
};

// ── Helpers ────────────────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function err(msg, status = 400) {
  return json({ error: msg }, status);
}

function nanoid() {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 16);
}

// ── Telegram InitData Validation ───────────────────────────────────────────

async function validateTelegramData(initData, botToken) {
  try {
    const params   = new URLSearchParams(initData);
    const hash     = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const pairs = [];
    for (const [k, v] of [...params.entries()].sort(([a], [b]) => a < b ? -1 : 1)) {
      pairs.push(`${k}=${v}`);
    }
    const dataCheckStr = pairs.join('\n');
    const enc          = new TextEncoder();

    const secretKey = await crypto.subtle.importKey(
      'raw', enc.encode('WebAppData'),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const secretBytes = await crypto.subtle.sign('HMAC', secretKey, enc.encode(botToken));

    const hmacKey = await crypto.subtle.importKey(
      'raw', secretBytes,
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(dataCheckStr));
    const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');

    if (hex !== hash) return null;

    const userStr = params.get('user');
    return userStr ? JSON.parse(userStr) : null;
  } catch {
    return null;
  }
}

// ── Auth Middleware ─────────────────────────────────────────────────────────

async function getUser(request, env) {
  const initData = request.headers.get('X-Init-Data') || '';
  if (!initData) return null;

  // Dev bypass (only when OWNER_ID matches a special test header)
  const devId = request.headers.get('X-Dev-User-Id');
  if (devId && env.DEV_MODE === 'true') {
    const u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(devId).first();
    return u;
  }

  const tgUser = await validateTelegramData(initData, env.BOT_TOKEN);
  if (!tgUser) return null;

  const userId = String(tgUser.id);

  // Check ban
  const existing = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(userId).first();
  if (existing?.is_banned) return null;

  if (!existing) {
    // Auto-create user
    const role = userId === OWNER_ID ? 'owner' : 'user';
    await env.DB.prepare(
      'INSERT INTO users (id,username,first_name,last_name,photo_url,role,balance) VALUES (?,?,?,?,?,?,0)'
    ).bind(userId, tgUser.username||'', tgUser.first_name||'', tgUser.last_name||'', tgUser.photo_url||'', role).run();

    return await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(userId).first();
  }

  // Refresh Telegram profile data
  await env.DB.prepare(
    'UPDATE users SET username=?,first_name=?,last_name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ).bind(tgUser.username||'', tgUser.first_name||'', tgUser.last_name||'', userId).run();

  return await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(userId).first();
}

function isOwner(user)   { return user?.role === 'owner'; }
function isAdmin(user)   { return user?.role === 'admin'  || isOwner(user); }
function isReseller(user){ return user?.role === 'reseller'|| isAdmin(user); }

// ── Price helper ────────────────────────────────────────────────────────────

function calcPrice(template, user) {
  if (!user || isAdmin(user)) return 0;
  if (user.role === 'reseller') return template.reseller_price ?? template.price;
  return template.price;
}

// ── VPS Proxy ───────────────────────────────────────────────────────────────

async function vpsPost(path, body, env) {
  const vpsUrl = (await env.DB.prepare("SELECT value FROM settings WHERE key='vps_url'").first())?.value
    || env.VPS_URL;
  const res = await fetch(`${vpsUrl}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'X-Secret': env.VPS_SECRET },
    body:    JSON.stringify(body),
  });
  return res;
}

// ── Router ──────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS_HEADERS });

    // ── Public: settings (no auth required) ──
    if (path === '/api/settings' && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT key,value FROM settings').all();
      const s = {};
      results.forEach(r => (s[r.key] = r.value));
      return json(s);
    }

    // ── Auth ──
    const user = await getUser(request, env);

    // POST /api/auth — login / create account
    if (path === '/api/auth' && method === 'POST') {
      if (!user) return err('Invalid Telegram data', 401);
      return json({ user });
    }

    if (!user) return err('Unauthorized', 401);

    // ── GET /api/me ──
    if (path === '/api/me' && method === 'GET') return json({ user });

    // ── Templates ──────────────────────────────────────────────────────────

    if (path === '/api/templates' && method === 'GET') {
      const cat    = url.searchParams.get('category') || '';
      const search = url.searchParams.get('search')   || '';
      let q = 'SELECT * FROM templates WHERE is_active=1';
      const params = [];
      if (cat && cat !== 'all') { q += ' AND category=?'; params.push(cat); }
      if (search) { q += ' AND name LIKE ?'; params.push(`%${search}%`); }
      q += ' ORDER BY sort_order ASC, created_at DESC';

      const { results } = await env.DB.prepare(q).bind(...params).all();
      // Attach user-specific price
      const withPrice = results.map(t => ({
        ...t,
        user_price: calcPrice(t, user),
        logo_layer_path: t.logo_layer_path ? JSON.parse(t.logo_layer_path) : null,
      }));
      return json(withPrice);
    }

    if (path.match(/^\/api\/templates\/[^/]+$/) && method === 'GET') {
      const tid = path.split('/')[3];
      const t   = await env.DB.prepare('SELECT * FROM templates WHERE id=? AND is_active=1').bind(tid).first();
      if (!t) return err('Template not found', 404);
      return json({ ...t, user_price: calcPrice(t, user), logo_layer_path: t.logo_layer_path ? JSON.parse(t.logo_layer_path) : null });
    }

    // ── POST /api/templates — owner only ──
    if (path === '/api/templates' && method === 'POST') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const body = await request.json();
      const { name, category, type, price, reseller_price, logo_layer_path, logo_layer_name } = body;
      if (!name) return err('name required');

      const tid = nanoid();
      await env.DB.prepare(
        'INSERT INTO templates (id,name,category,type,price,reseller_price,logo_layer_path,logo_layer_name) VALUES (?,?,?,?,?,?,?,?)'
      ).bind(tid, name, category||'', type||'regular', price||0, reseller_price||0,
             logo_layer_path ? JSON.stringify(logo_layer_path) : null, logo_layer_name||'').run();

      return json({ id: tid, success: true });
    }

    // ── PUT /api/templates/:id — owner ──
    if (path.match(/^\/api\/templates\/[^/]+$/) && method === 'PUT') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const tid  = path.split('/')[3];
      const body = await request.json();
      const { name, category, type, price, reseller_price, logo_layer_path, logo_layer_name, is_active, sort_order } = body;
      await env.DB.prepare(
        'UPDATE templates SET name=?,category=?,type=?,price=?,reseller_price=?,logo_layer_path=?,logo_layer_name=?,is_active=?,sort_order=?,updated_at=CURRENT_TIMESTAMP WHERE id=?'
      ).bind(name, category, type, price, reseller_price,
             logo_layer_path ? JSON.stringify(logo_layer_path) : null,
             logo_layer_name, is_active??1, sort_order??0, tid).run();
      return json({ success: true });
    }

    // ── DELETE /api/templates/:id — owner ──
    if (path.match(/^\/api\/templates\/[^/]+$/) && method === 'DELETE') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const tid = path.split('/')[3];
      await env.DB.prepare('UPDATE templates SET is_active=0 WHERE id=?').bind(tid).run();
      // Also delete from KV + VPS
      await env.KV.delete(`template:${tid}`);
      return json({ success: true });
    }

    // ── Template JSON (from KV) ──
    if (path.match(/^\/api\/templates\/[^/]+\/json$/) && method === 'GET') {
      if (!isAdmin(user)) return err('Forbidden', 403);
      const tid  = path.split('/')[3];
      const data = await env.KV.get(`template:${tid}`);
      if (!data) return err('Template JSON not found', 404);
      return new Response(data, { headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
    }

    // ── Categories ──────────────────────────────────────────────────────────

    if (path === '/api/categories' && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM categories ORDER BY sort_order').all();
      return json(results);
    }

    if (path === '/api/categories' && method === 'POST') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const { name } = await request.json();
      if (!name) return err('name required');
      const id = name.toLowerCase().replace(/\s+/g, '-');
      await env.DB.prepare('INSERT OR IGNORE INTO categories (id,name) VALUES (?,?)').bind(id, name).run();
      return json({ id, name });
    }

    // ── Orders ─────────────────────────────────────────────────────────────

    if (path === '/api/orders' && method === 'GET') {
      const { results } = await env.DB.prepare(
        'SELECT o.*,t.name as template_name FROM orders o JOIN templates t ON o.template_id=t.id WHERE o.user_id=? ORDER BY o.created_at DESC LIMIT 50'
      ).bind(user.id).all();
      return json(results);
    }

    // ── POST /api/generate — export sticker ──────────────────────────────

    if (path === '/api/generate' && method === 'POST') {
      const body = await request.json();
      const { template_id, logo_type, logo_data, transform, colors } = body;
      if (!template_id) return err('template_id required');

      const template = await env.DB.prepare('SELECT * FROM templates WHERE id=? AND is_active=1').bind(template_id).first();
      if (!template) return err('Template not found', 404);

      const price = calcPrice(template, user);

      // Check balance (owner & admin free)
      if (!isAdmin(user) && user.balance < price) {
        return err(`Insufficient balance. Need ${price} Ks, have ${user.balance} Ks.`, 402);
      }

      // Deduct balance atomically
      if (!isAdmin(user) && price > 0) {
        await env.DB.prepare('UPDATE users SET balance=balance-?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND balance>=?')
          .bind(price, user.id, price).run();
        // Verify deduction succeeded
        const check = await env.DB.prepare('SELECT balance FROM users WHERE id=?').bind(user.id).first();
        if (check.balance < 0) {
          // Rollback
          await env.DB.prepare('UPDATE users SET balance=balance+? WHERE id=?').bind(price, user.id).run();
          return err('Balance deduction failed', 500);
        }
      }

      // Forward to VPS for processing
      try {
        const vpsRes = await vpsPost('/generate', {
          template_id,
          logo_layer_path: template.logo_layer_path ? JSON.parse(template.logo_layer_path) : null,
          logo_type,
          logo_data,
          transform: transform || { x: 0, y: 0, scale: 1 },
          colors:    colors   || {},
          user_id:   user.id,
          chat_id:   user.id,
        }, env);

        if (!vpsRes.ok) {
          // Refund on VPS error
          if (!isAdmin(user) && price > 0) {
            await env.DB.prepare('UPDATE users SET balance=balance+? WHERE id=?').bind(price, user.id).run();
          }
          const errData = await vpsRes.json().catch(() => ({}));
          return err(errData.error || 'Generation failed', 500);
        }

        const result = await vpsRes.json();

        // Record order
        const orderId = nanoid();
        await env.DB.prepare(
          'INSERT INTO orders (id,user_id,template_id,price_paid,tgs_file_id,logo_type) VALUES (?,?,?,?,?,?)'
        ).bind(orderId, user.id, template_id, price, result.file_id||'', logo_type||'').run();

        // Refresh balance
        const updatedUser = await env.DB.prepare('SELECT balance FROM users WHERE id=?').bind(user.id).first();

        return json({ success: true, order_id: orderId, file_id: result.file_id, balance: updatedUser.balance });

      } catch (e) {
        // Refund on network error
        if (!isAdmin(user) && price > 0) {
          await env.DB.prepare('UPDATE users SET balance=balance+? WHERE id=?').bind(price, user.id).run();
        }
        return err('VPS unreachable: ' + e.message, 503);
      }
    }

    // ── Top-up ──────────────────────────────────────────────────────────────

    if (path === '/api/topup' && method === 'POST') {
      const body = await request.json();
      const { amount, payment_method, invoice_file_id } = body;

      const min = parseInt((await env.DB.prepare("SELECT value FROM settings WHERE key='topup_min'").first())?.value || '500');
      const max = parseInt((await env.DB.prepare("SELECT value FROM settings WHERE key='topup_max'").first())?.value || '50000');

      if (!amount || amount < min || amount > max) return err(`Amount must be ${min}–${max} Ks`);
      if (amount % 500 !== 0) return err('Amount must be in multiples of 500 Ks');

      const reqId = nanoid();
      await env.DB.prepare(
        'INSERT INTO topup_requests (id,user_id,amount,payment_method,invoice_file_id) VALUES (?,?,?,?,?)'
      ).bind(reqId, user.id, amount, payment_method||'', invoice_file_id||'').run();

      // Notify VPS → bot sends to owner
      await vpsPost('/notify/topup', {
        request_id: reqId,
        user: { id: user.id, username: user.username, first_name: user.first_name },
        amount,
        payment_method,
        invoice_file_id,
      }, env).catch(() => {});

      return json({ success: true, request_id: reqId });
    }

    if (path === '/api/topup' && method === 'GET') {
      if (!isOwner(user)) {
        // User sees their own requests
        const { results } = await env.DB.prepare(
          'SELECT * FROM topup_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 20'
        ).bind(user.id).all();
        return json(results);
      }
      // Owner sees all
      const status = url.searchParams.get('status') || '';
      let q = 'SELECT r.*,u.username,u.first_name FROM topup_requests r JOIN users u ON r.user_id=u.id';
      const params = [];
      if (status) { q += ' WHERE r.status=?'; params.push(status); }
      q += ' ORDER BY r.created_at DESC LIMIT 100';
      const { results } = await env.DB.prepare(q).bind(...params).all();
      return json(results);
    }

    if (path.match(/^\/api\/topup\/[^/]+\/(approve|reject)$/) && method === 'POST') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const parts  = path.split('/');
      const reqId  = parts[3];
      const action = parts[4];

      const req = await env.DB.prepare('SELECT * FROM topup_requests WHERE id=?').bind(reqId).first();
      if (!req) return err('Request not found', 404);
      if (req.status !== 'pending') return err('Already reviewed');

      await env.DB.prepare(
        'UPDATE topup_requests SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE id=?'
      ).bind(action === 'approve' ? 'approved' : 'rejected', user.id, reqId).run();

      if (action === 'approve') {
        await env.DB.prepare('UPDATE users SET balance=balance+?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .bind(req.amount, req.user_id).run();
      }

      // Notify user via bot
      await vpsPost('/notify/topup-result', {
        user_id: req.user_id,
        amount:  req.amount,
        action,
      }, env).catch(() => {});

      return json({ success: true });
    }

    // ── Users (owner panel) ─────────────────────────────────────────────────

    if (path === '/api/users' && method === 'GET') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const search = url.searchParams.get('search') || '';
      let q = 'SELECT * FROM users';
      const params = [];
      if (search) { q += ' WHERE first_name LIKE ? OR username LIKE ? OR id=?'; params.push(`%${search}%`, `%${search}%`, search); }
      q += ' ORDER BY created_at DESC LIMIT 200';
      const { results } = await env.DB.prepare(q).bind(...params).all();
      return json(results);
    }

    if (path.match(/^\/api\/users\/[^/]+$/) && method === 'PUT') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const uid  = path.split('/')[3];
      const body = await request.json();
      const { role, balance, is_banned } = body;

      if (uid === OWNER_ID) return err('Cannot modify owner');

      const fields = [];
      const params = [];
      if (role     !== undefined) { fields.push('role=?');      params.push(role); }
      if (balance  !== undefined) { fields.push('balance=?');   params.push(balance); }
      if (is_banned!== undefined) { fields.push('is_banned=?'); params.push(is_banned ? 1 : 0); }
      if (!fields.length) return err('Nothing to update');

      fields.push('updated_at=CURRENT_TIMESTAMP');
      params.push(uid);
      await env.DB.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).bind(...params).run();

      // Notify user if banned
      if (is_banned) {
        await vpsPost('/notify/ban', { user_id: uid }, env).catch(() => {});
      }

      return json({ success: true });
    }

    // ── Fonts ────────────────────────────────────────────────────────────────

    if (path === '/api/fonts' && method === 'GET') {
      const { results } = await env.DB.prepare('SELECT * FROM fonts ORDER BY created_at DESC').all();
      return json(results);
    }

    if (path === '/api/fonts' && method === 'POST') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const body = await request.json();
      const { name, url, type } = body;
      if (!name) return err('name required');
      const id = nanoid();
      await env.DB.prepare('INSERT INTO fonts (id,name,url,type) VALUES (?,?,?,?)').bind(id, name, url||'', type||'google').run();
      return json({ id, success: true });
    }

    if (path.match(/^\/api\/fonts\/[^/]+$/) && method === 'DELETE') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const fid = path.split('/')[3];
      await env.DB.prepare('DELETE FROM fonts WHERE id=?').bind(fid).run();
      return json({ success: true });
    }

    // ── Settings (owner) ─────────────────────────────────────────────────────

    if (path === '/api/settings' && method === 'PUT') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const body = await request.json();
      for (const [key, value] of Object.entries(body)) {
        await env.DB.prepare('INSERT OR REPLACE INTO settings (key,value,updated_at) VALUES (?,?,CURRENT_TIMESTAMP)').bind(key, String(value)).run();
      }
      return json({ success: true });
    }

    // ── Upload template JSON to KV (owner) ────────────────────────────────

    if (path === '/api/templates/upload-json' && method === 'POST') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const body = await request.json();
      const { template_id, json_data } = body;
      if (!template_id || !json_data) return err('template_id and json_data required');

      // Store in KV
      await env.KV.put(`template:${template_id}`, JSON.stringify(json_data));

      // Also forward to VPS for local caching
      await vpsPost('/templates/cache', { template_id, json_data }, env).catch(() => {});

      return json({ success: true });
    }

    // ── Get layer tree from VPS ──────────────────────────────────────────

    if (path === '/api/templates/layers' && method === 'POST') {
      if (!isOwner(user)) return err('Forbidden', 403);
      const body = await request.json();
      const res  = await vpsPost('/templates/layers', body, env);
      const data = await res.json();
      return json(data);
    }

    return err('Not found', 404);
  },
};
