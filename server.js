/* =============================
   GAME ZONE GAMING – Real-time server
   Express + sql.js + WebSocket
   ============================= */
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const dbMod = require('./db');

const PORT = parseInt(process.env.PORT || '3000', 10);
const app = express();

const q = dbMod.q;
const run = dbMod.run;
const txn = dbMod.txn;
const persist = dbMod.persist;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '20mb' }));

// ================= HELPERS =================
function nowISO() { return new Date().toISOString(); }
function todayStr(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
}
function nowMinutes() {
  const n = new Date();
  return n.getHours() * 60 + n.getMinutes();
}
function toMin(t) {
  const p = String(t || '00:00').split(':').map(Number);
  return (p[0] || 0) * 60 + (p[1] || 0);
}
function minToTime(m) {
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
function shiftDate(dateStr, delta) {
  const p = String(dateStr || '').split('-').map(Number);
  const d = new Date(p[0], (p[1] || 1) - 1, (p[2] || 1));
  d.setDate(d.getDate() + delta);
  return todayStr(d);
}
function sanitize(acc) {
  if (!acc) return acc;
  return { id: acc.id, name: acc.name, username: acc.username, phone: acc.phone, avatar: acc.avatar, favorite_game: acc.favorite_game, balance: acc.balance, points: acc.points, online: !!acc.online, last_seen: acc.last_seen, last_login: acc.last_login, created_at: acc.created_at };
}
function bearerToken(req) {
  const h = req.headers['authorization'] || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return req.query.token || '';
}
function getSession(token) {
  if (!token) return null;
  return q('SELECT * FROM sessions WHERE token = ?', [token])[0] || null;
}
function getAccount(id) {
  if (!id) return null;
  return q('SELECT * FROM accounts WHERE id = ?', [id])[0] || null;
}
function customerFromReq(req) {
  const s = getSession(bearerToken(req));
  if (!s || s.role !== 'customer') return null;
  return getAccount(s.account_id);
}
function adminFromReq(req) {
  const s = getSession(bearerToken(req));
  return (s && s.role === 'admin') ? s : null;
}

// ================= WEBSITE CONTENT VALIDATION =================
const CONTENT_KEYS = new Set(['site', 'hero', 'features', 'booking', 'prices', 'offers', 'games', 'contact', 'footer', 'sections', 'new_features']);
const SECTION_IDS = ['features', 'booking', 'prices', 'offers', 'games', 'contact'];
const DEVICE_TYPES = ['standard', 'vip'];
const MAX_IMAGE = 2500000;

function validateContent(key, value) {
  const errs = [];
  if (!CONTENT_KEYS.has(key)) { errs.push('Unknown content key: ' + key); return errs; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) { errs.push('Content must be a JSON object'); return errs; }

  const str = (v, max, name) => { if (typeof v !== 'string') errs.push(name + ' must be text'); else if (v.length > max) errs.push(name + ' is too long'); };
  const img = (v, name) => { if (v === undefined || v === null) return; if (v !== '' && !(typeof v === 'string' && v.startsWith('data:image/') && v.length <= MAX_IMAGE)) errs.push(name + ' must be a valid image (max ' + (MAX_IMAGE / 1000000) + 'MB)'); };
  const bool = (v, name) => { if (v !== undefined && typeof v !== 'boolean') errs.push(name + ' must be true/false'); };
  const num = (v, name, min) => { if (v !== undefined && !(typeof v === 'number' && isFinite(v) && (min === undefined || v >= min))) errs.push(name + ' must be a valid number'); };
  const arr = (v, name, max) => { if (v == null) return null; if (!Array.isArray(v)) { errs.push(name + ' must be a list'); return null; } if (v.length > max) errs.push(name + ' has too many items'); return v; };

  switch (key) {
    case 'site':
      str(value.title, 300, 'Title'); str(value.name, 100, 'Name'); str(value.sub, 100, 'Subtitle');
      str(value.icon, 20, 'Icon'); str(value.navBrand, 50, 'Nav brand'); str(value.footerName, 100, 'Footer name'); img(value.logoImage, 'Logo');
      break;
    case 'hero':
      str(value.tagline, 500, 'Tagline'); img(value.bgImage, 'Background');
      if (value.btnBook) { str(value.btnBook.label, 100, 'Book button text'); str(value.btnBook.href, 500, 'Book button link'); bool(value.btnBook.visible, 'Book button visible'); }
      if (value.btnLogin) { str(value.btnLogin.label, 100, 'Login button text'); bool(value.btnLogin.visible, 'Login button visible'); }
      (arr(value.stats, 'Stats', 12) || []).forEach((s, i) => { str(s.num, 50, 'Stat value'); str(s.label, 100, 'Stat label'); });
      break;
    case 'features':
      str(value.label, 200, 'Label'); str(value.titleBefore, 200, 'Title'); str(value.titleGlow, 100, 'Highlight');
      (arr(value.cards, 'Feature cards', 12) || []).forEach(x => { str(x.icon, 50, 'Card icon'); str(x.title, 150, 'Card title'); str(x.desc, 1000, 'Card description'); });
      break;
    case 'booking':
      str(value.label, 200, 'Label'); str(value.titleBefore, 200, 'Title'); str(value.titleGlow, 100, 'Highlight');
      str(value.depositTitle, 200, 'Deposit title'); str(value.depositText, 300, 'Deposit text'); str(value.submit, 200, 'Submit text');
      break;
    case 'prices':
      str(value.label, 200, 'Label'); str(value.titleBefore, 200, 'Title'); str(value.titleGlow, 100, 'Highlight');
      (arr(value.cards, 'Price cards', 12) || []).forEach(c => {
        if (!DEVICE_TYPES.includes(c.variant) && c.variant !== 'addons') errs.push('Invalid card variant: ' + c.variant);
        str(c.icon, 100, 'Card icon'); str(c.title, 150, 'Card title'); str(c.crown, 50, 'Crown');
        (arr(c.rows, 'Price rows', 12) || []).forEach(r => {
          str(r.label, 150, 'Row label'); num(r.price, 'Row price', 0); str(r.suffix, 20, 'Row suffix'); str(r.prefix, 20, 'Row prefix'); bool(r.featured, 'Row featured');
        });
      });
      break;
    case 'offers':
      str(value.label, 200, 'Label'); str(value.titleBefore, 200, 'Title'); str(value.titleGlow, 100, 'Highlight');
      (arr(value.cards, 'Offer cards', 12) || []).forEach(o => {
        str(o.tier, 50, 'Tier'); str(o.badge, 100, 'Badge'); str(o.amount, 50, 'Amount'); str(o.amountSuffix, 20, 'Amount suffix');
        str(o.desc, 300, 'Description'); str(o.bonusLabel, 100, 'Bonus label'); str(o.bonus, 100, 'Bonus'); str(o.total, 100, 'Total');
        str(o.btn, 100, 'Button'); num(o.amountData, 'Membership amount', 0);
      });
      break;
    case 'games':
      str(value.label, 200, 'Label'); str(value.titleBefore, 200, 'Title'); str(value.titleGlow, 100, 'Highlight');
      (arr(value.tabs, 'Game tabs', 12) || []).forEach(t => {
        str(t.id, 30, 'Tab id'); str(t.icon, 50, 'Tab icon'); str(t.label, 50, 'Tab label');
        (arr(t.games, 'Games', 100) || []).forEach(g => { str(g.icon, 50, 'Game icon'); str(g.name, 150, 'Game name'); img(g.image, 'Game image'); });
      });
      break;
    case 'contact':
      str(value.label, 200, 'Label'); str(value.titleBefore, 200, 'Title'); str(value.titleGlow, 100, 'Highlight');
      (arr(value.items, 'Contact items', 12) || []).forEach(it => {
        if (it.type !== 'link' && it.type !== 'plain') errs.push('Invalid contact item type: ' + it.type);
        str(it.icon, 50, 'Contact icon'); str(it.title, 150, 'Contact title'); str(it.value, 500, 'Contact value'); str(it.href, 800, 'Contact link');
      });
      if (value.map) { str(value.map.url, 800, 'Map link'); img(value.map.image, 'Map image'); }
      break;
    case 'footer':
      str(value.text, 500, 'Footer text'); str(value.copy, 300, 'Copyright');
      (arr(value.links, 'Footer links', 20) || []).forEach(l => { str(l.label, 150, 'Link label'); str(l.href, 500, 'Link href'); });
      break;
    case 'sections': {
      (arr(value.hidden, 'Hidden sections', 10) || []).forEach(s => { if (!SECTION_IDS.includes(s)) errs.push('Unknown section: ' + s); });
      (arr(value.order, 'Section order', 10) || []).forEach(s => { if (!SECTION_IDS.includes(s)) errs.push('Unknown section: ' + s); });
      break;
    }
    case 'new_features': {
      const feats = Array.isArray(value.items) ? value.items : (Array.isArray(value.features) ? value.features : null);
      if (!feats) { errs.push('Features must be a list'); break; }
      if (feats.length > 30) errs.push('Features has too many items');
      feats.forEach(f => {
        str(f.id, 100, 'Feature id'); str(f.label, 200, 'Feature label'); str(f.desc, 1000, 'Feature description'); bool(f.enabled, 'Feature enabled');
      });
      break;
    }
  }
  return errs;
}

// ================= REAL-TIME BROADCAST =================
const wss = new WebSocketServer({ noServer: true });
function broadcast(type, payload) {
  const msg = JSON.stringify({ type, data: payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

// ================= DEVICE SNAPSHOT =================
function getDeviceSnapshot(date) {
  const target = date || todayStr();
  const nowMin = nowMinutes();
  const devs = dbMod.getDevices();
  const scheduled = q("SELECT * FROM bookings WHERE date = ? AND status IN ('pending','active') AND manual = 0", [target]);
  return devs.map(d => {
    const rel = scheduled.filter(b => (JSON.parse(b.pcs || '[]')).includes(d.pc));
    const occupied = rel.find(b => {
      const s = toMin(b.time), e = s + (b.duration || 0);
      return nowMin >= s && nowMin < e;
    });
    const upcoming = rel.filter(b => toMin(b.time) > nowMin).sort((a, b) => toMin(a.time) - toMin(b.time))[0];
    let color, label, detail, bookingId = null, manual = false;
    if (d.status === 'manual_occupied') {
      color = 'red'; label = 'Occupied'; detail = 'Manual: ' + (d.manual_name || 'Walk-in'); manual = true;
    } else if (occupied) {
      color = 'red'; label = 'Occupied'; detail = occupied.name + ' · ' + occupied.time; bookingId = occupied.id;
    } else if (upcoming) {
      color = 'yellow'; label = 'Reserved'; detail = upcoming.name + ' at ' + upcoming.time; bookingId = upcoming.id;
    } else {
      color = 'green'; label = 'Available'; detail = '';
    }
    return { pc: d.pc, type: d.type, color, label, detail, manual, bookingId };
  });
}
function devicesChanged(date) {
  broadcast('devices_changed', { devices: getDeviceSnapshot(date), date: date || todayStr() });
}

// ================= POINTS =================
function pointsPerHourFor(pc) {
  const type = dbMod.deviceTypeOf(pc);
  const s = dbMod.getSettings();
  const rate = type === 'vip' ? parseFloat(s.points_vip_per_hour) : parseFloat(s.points_std_per_hour);
  return isNaN(rate) ? 0 : rate;
}
function usedMinutes(b) {
  const nowMs = Date.now();
  if (b.duration && b.duration > 0) {
    const start = new Date(b.date + 'T' + b.time).getTime();
    const end = start + b.duration * 60000;
    if (nowMs <= start) return 0;
    return Math.max(0, Math.floor((Math.min(nowMs, end) - start) / 60000));
  }
  const started = new Date(b.started_at || b.created_at).getTime();
  return Math.max(0, Math.floor((nowMs - started) / 60000));
}
function awardPointsForBooking(b) {
  if (!b || b.points_awarded) return;
  const pcs = JSON.parse(b.pcs || '[]');
  if (!pcs.length) return;
  const mins = usedMinutes(b);
  if (mins <= 0) return;
  let total = 0;
  for (const pc of pcs) total += Math.floor(mins * pointsPerHourFor(pc) / 60);
  if (total <= 0) return;
  txn(() => {
    run('UPDATE bookings SET points_awarded = 1 WHERE id = ? AND points_awarded = 0', [b.id]);
    const acc = b.account_id ? getAccount(b.account_id) : null;
    if (acc) {
      const np = (acc.points || 0) + total;
      run('UPDATE accounts SET points = ? WHERE id = ?', [np, acc.id]);
      dbMod.addTransaction({ account_id: b.account_id, type: 'points_earned', points: total, ref_type: 'booking', ref_id: b.id, reason: 'Points earned from completed booking', performed_by: 'system' });
      broadcast('accounts_changed', { account: sanitize({ ...acc, points: np }) });
    }
  });
  broadcast('bookings_changed', { booking: { id: b.id, points_awarded: 1, points_earned: total } });
}

// ================= PRICING (server-side, config-driven) =================
function priceForBooking(pcs, duration) {
  const s = dbMod.getSettings();
  const breakdown = pcs.map(pc => {
    const rate = dbMod.deviceTypeOf(pc) === 'vip' ? (parseFloat(s.vip_price_per_hour) || 0) : (parseFloat(s.standard_price_per_hour) || 0);
    const amount = Math.round(rate * (duration || 0) / 60 * 100) / 100;
    return { pc, rate, amount };
  });
  const total = Math.round(breakdown.reduce((x, y) => x + y.amount, 0) * 100) / 100;
  return { total, breakdown };
}
function priceLabel(total) {
  return Math.round(total * 100) / 100;
}

// ================= BOOKING LIFECYCLE (server time) =================
function lifeCycleTick() {
  const today = todayStr();
  const nowMin = nowMinutes();
  const pending = q("SELECT * FROM bookings WHERE status IN ('pending','active')");
  let changed = false;
  const completed = [];
  const started = [];
  for (const b of pending) {
    if (b.manual) continue; // manual walk-in sessions are released by admin only
    const startM = toMin(b.time);
    const endM = startM + (b.duration || 0);
    // auto-start: reservation time reached (server clock) → becomes ACTIVE → device RED
    if (b.status === 'pending' && b.date === today && startM <= nowMin && nowMin < endM) {
      run("UPDATE bookings SET status = 'active', started_at = ? WHERE id = ?", [nowISO(), b.id]);
      changed = true;
      started.push(b);
      continue;
    }
    const past = b.date < today || (b.date === today && nowMin >= endM);
    if (past) {
      run("UPDATE bookings SET status = 'completed', ended_at = ? WHERE id = ?", [nowISO(), b.id]);
      changed = true;
      completed.push(b);
    }
  }
  if (changed) {
    for (const b of completed) awardPointsForBooking(b);
    broadcast('bookings_changed', { lifecycle: { completed: completed.map(x => x.id), started: started.map(x => x.id) } });
    devicesChanged(today);
  }
  // presence timeout
  const cutoff = new Date(Date.now() - 90000).toISOString();
  const stale = q('SELECT id FROM accounts WHERE online = 1 AND (last_seen = "" OR last_seen < ?)', [cutoff]);
  for (const a of stale) {
    run('UPDATE accounts SET online = 0 WHERE id = ?', [a.id]);
    const acc = getAccount(a.id);
    if (acc) broadcast('presence_changed', { account: sanitize(acc) });
  }
}

// ================= BOOKING CONFLICT (server side) =================
function bookingPCs(b) {
  try { const p = JSON.parse(b.pcs || '[]'); return Array.isArray(p) ? p : []; } catch { return []; }
}
function checkConflict(date, time, duration, pcs) {
  const start = toMin(time);
  const end = start + duration;
  if (end <= start) return { conflict: true, reason: 'Invalid duration' };
  // 1) A manually occupied device blocks ANY online reservation (manual session has no end time).
  const devs = dbMod.getDevices();
  for (const pc of pcs) {
    const d = devs.find(x => x.pc === pc);
    if (d && d.status === 'manual_occupied') return { conflict: true, manual: true, reason: 'Device is manually occupied', pc };
  }
  // 2) Overlap windows from same-date reservations.
  const rows = q("SELECT * FROM bookings WHERE date = ? AND status IN ('pending','active') AND manual = 0", [date]);
  // 3) Reservations from the previous day that spilled past midnight into this date.
  const spill = q("SELECT * FROM bookings WHERE date = ? AND status IN ('pending','active') AND manual = 0", [shiftDate(date, -1)])
    .filter(b => toMin(b.time) + (b.duration || 0) > 1440);
  for (const b of rows.concat(spill)) {
    const bPcs = bookingPCs(b);
    const shared = pcs.find(pc => bPcs.includes(pc));
    if (!shared) continue;
    let wStart, wEnd;
    if (b.date === date) {
      wStart = toMin(b.time);
      wEnd = Math.min(wStart + (b.duration || 0), 1440);
    } else {
      wStart = 0;
      wEnd = Math.min(toMin(b.time) + (b.duration || 0) - 1440, 1440);
    }
    if (start < wEnd && wStart < end) {
      return { conflict: true, booking: b, pc: shared };
    }
  }
  // 4) This booking spills past midnight → also check the next date.
  if (end > 1440) {
    const spillEnd = end - 1440;
    const nextRows = q("SELECT * FROM bookings WHERE date = ? AND status IN ('pending','active') AND manual = 0", [shiftDate(date, 1)]);
    for (const b of nextRows) {
      const bPcs = bookingPCs(b);
      const shared = pcs.find(pc => bPcs.includes(pc));
      if (!shared) continue;
      const bStart = toMin(b.time);
      const bEnd = Math.min(bStart + (b.duration || 0), 1440);
      if (0 < bEnd && bStart < spillEnd) {
        return { conflict: true, booking: b, pc: shared };
      }
    }
  }
  return null;
}

// ============ AUTH ============
app.post('/api/auth/register', (req, res) => {
  const { name, phone, password, username } = req.body || {};
  if (!name || !String(name).trim() || !phone || !password) return res.status(400).json({ error: 'Name, phone and password are required' });
  const ph = String(phone).trim();
  if (String(password).length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
  let id;
  try {
    id = txn(() => {
      if (username && String(username).trim()) {
        const dupU = q('SELECT id FROM accounts WHERE username = ?', [String(username).trim()])[0];
        if (dupU) throw { code: 409, message: 'Username already registered' };
      }
      return run('INSERT INTO accounts (name, username, phone, password, avatar, favorite_game, balance, points, created_at, last_login, last_seen, online) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [
        String(name).trim(), username ? String(username).trim() : null, ph, dbMod.hashPw(password), '', '', 0, 0, nowISO(), nowISO(), nowISO(), 1
      ]);
    });
  } catch (e) {
    if (e && e.code === 409) return res.status(409).json({ error: e.message });
    if (String(e.message || '').includes('UNIQUE')) return res.status(409).json({ error: 'Phone already registered' });
    return res.status(500).json({ error: 'Registration failed' });
  }
  run('DELETE FROM sessions WHERE account_id = ? AND role = ?', [id, 'customer']);
  const token = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO sessions (token, account_id, role, created_at) VALUES (?,?,?,?)', [token, id, 'customer', nowISO()]);
  const acc = sanitize(getAccount(id));
  broadcast('accounts_changed', { account: acc });
  broadcast('presence_changed', { account: acc });
  res.status(201).json({ token, account: acc });
});

app.post('/api/auth/login', (req, res) => {
  const { phone, password } = req.body || {};
  const acc = q('SELECT * FROM accounts WHERE phone = ?', [String(phone || '').trim()])[0];
  if (!acc || !dbMod.verifyPw(String(password || ''), acc.password)) return res.status(401).json({ error: 'Wrong phone or password' });
  run('DELETE FROM sessions WHERE account_id = ? AND role = ?', [acc.id, 'customer']);
  const token = crypto.randomBytes(24).toString('hex');
  run('INSERT INTO sessions (token, account_id, role, created_at) VALUES (?,?,?,?)', [token, acc.id, 'customer', nowISO()]);
  txn(() => run('UPDATE accounts SET last_login = ?, last_seen = ?, online = 1 WHERE id = ?', [nowISO(), nowISO(), acc.id]));
  const updated = sanitize(getAccount(acc.id));
  broadcast('accounts_changed', { account: updated });
  broadcast('presence_changed', { account: updated });
  res.json({ token, account: updated });
});

app.post('/api/auth/logout', (req, res) => {
  const token = bearerToken(req);
  const s = getSession(token);
  if (s && s.role === 'customer' && s.account_id) {
    txn(() => run('UPDATE accounts SET online = 0 WHERE id = ?', [s.account_id]));
    const acc = sanitize(getAccount(s.account_id));
    if (acc) broadcast('presence_changed', { account: acc });
  }
  run('DELETE FROM sessions WHERE token = ?', [token]);
  res.json({ ok: true });
});

app.post('/api/auth/heartbeat', (req, res) => {
  const token = bearerToken(req);
  const s = getSession(token);
  if (!s || s.role !== 'customer') return res.json({ ok: false });
  const acc = getAccount(s.account_id);
  if (!acc) return res.json({ ok: false });
  const offline = !!(req.body && req.body.offline);
  if (offline) {
    run('UPDATE accounts SET online = 0, last_seen = ? WHERE id = ?', [new Date(0).toISOString(), acc.id]);
  } else {
    const wasOffline = !acc.online;
    run('UPDATE accounts SET online = 1, last_seen = ? WHERE id = ?', [nowISO(), acc.id]);
    if (wasOffline) broadcast('presence_changed', { account: sanitize(getAccount(acc.id)) });
  }
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const acc = customerFromReq(req);
  if (!acc) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ account: sanitize(acc) });
});

// ============ ADMIN AUTH ============
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  const s = dbMod.getSettings();
  if (String(username || '') === s.admin_user && String(password || '') === s.admin_pass) {
    run('DELETE FROM sessions WHERE account_id = ? AND role = ?', [0, 'admin']);
    const token = crypto.randomBytes(24).toString('hex');
    run('INSERT INTO sessions (token, account_id, role, created_at) VALUES (?,?,?,?)', [token, 0, 'admin', nowISO()]);
    return res.json({ token });
  }
  res.status(401).json({ error: 'Wrong username or password' });
});

app.post('/api/admin/logout', (req, res) => {
  run('DELETE FROM sessions WHERE token = ?', [bearerToken(req)]);
  res.json({ ok: true });
});

// ============ ACCOUNTS ============
app.get('/api/accounts', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  res.json({ accounts: q('SELECT * FROM accounts ORDER BY id DESC').map(sanitize) });
});

app.get('/api/accounts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const admin = adminFromReq(req);
  const cust = customerFromReq(req);
  const acc = getAccount(id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (!admin && (!cust || cust.id !== id)) return res.status(403).json({ error: 'Forbidden' });
  const bookings = q('SELECT * FROM bookings WHERE phone = ? OR account_id = ? ORDER BY date DESC, time DESC', [acc.phone, id]);
  const transactions = dbMod.getTransactions(id).map(r => ({ ...r, delta_balance: r.amount, delta_points: r.points }));
  res.json({ account: sanitize(acc), bookings, transactions });
});

app.patch('/api/accounts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const acc = getAccount(id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  const admin = !!adminFromReq(req);
  const cust = customerFromReq(req);
  if (!admin && (!cust || cust.id !== id)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body || {};
  const updates = {};
  const allowedOwner = ['avatar', 'password', 'favorite_game', 'name', 'username'];
  for (const k of Object.keys(b)) {
    if (admin && ['name', 'username', 'phone', 'avatar', 'favorite_game', 'balance', 'points', 'password'].includes(k)) updates[k] = b[k];
    else if (!admin && allowedOwner.includes(k)) updates[k] = b[k];
  }
  if (updates.avatar !== undefined && String(updates.avatar).length > 1500000) return res.status(400).json({ error: 'Avatar too large' });
  if (updates.favorite_game !== undefined) {
    if (typeof updates.favorite_game !== 'string') return res.status(400).json({ error: 'Favorite game must be text' });
    updates.favorite_game = updates.favorite_game.trim().slice(0, 150);
  }
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'Nothing to update' });
  if (updates.phone !== undefined) {
    const dup = q('SELECT id FROM accounts WHERE phone = ? AND id != ?', [String(updates.phone).trim(), id])[0];
    if (dup) return res.status(409).json({ error: 'Phone already registered' });
    updates.phone = String(updates.phone).trim();
  }
  if (updates.username !== undefined && String(updates.username).trim()) {
    const dup = q('SELECT id FROM accounts WHERE username = ? AND id != ?', [String(updates.username).trim(), id])[0];
    if (dup) return res.status(409).json({ error: 'Username already registered' });
    updates.username = String(updates.username).trim();
  }
  if (updates.password !== undefined) updates.password = dbMod.hashPw(updates.password);
  const prevB = acc.balance || 0;
  const prevP = acc.points || 0;
  const admSession = adminFromReq(req);
  const admName = admin && admSession ? String((getAccount(admSession.account_id) || {}).name || admSession.account_id) : 'admin';
  txn(() => {
    for (const k of Object.keys(updates)) {
      let v = updates[k];
      if (v === undefined) continue;
      if (k === 'balance') v = parseFloat(v) || 0;
      if (k === 'points') v = parseInt(v, 10) || 0;
      run('UPDATE accounts SET ' + k + ' = ? WHERE id = ?', [v, id]);
    }
    if (admin && updates.balance !== undefined && (acc.balance !== updates.balance)) {
      dbMod.addTransaction({ account_id: id, type: 'admin_balance', amount: Math.round((Number(updates.balance) - prevB) * 100) / 100, reason: 'Admin set balance via profile (previous ' + prevB + ')', performed_by: admName });
    }
    if (admin && updates.points !== undefined && (acc.points !== updates.points)) {
      dbMod.addTransaction({ account_id: id, type: 'admin_points', points: (parseInt(updates.points, 10) || 0) - prevP, reason: 'Admin set points via profile (previous ' + prevP + ')', performed_by: admName });
    }
  });
const updated = sanitize(getAccount(id));
  broadcast('accounts_changed', { account: updated });
  res.json({ account: updated });
});

// ============ GAME SUGGESTIONS ============
function findGameInLibrary(name) {
  const g = dbMod.getContent('games');
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  for (const t of (g && Array.isArray(g.tabs)) ? g.tabs : []) {
    for (const gm of (Array.isArray(t.games) ? t.games : [])) {
      if (String(gm.name || '').trim().toLowerCase() === wanted) return { tab: t.id, name: gm.name };
    }
  }
  return null;
}
function validSuggestionImage(img) {
  if (img === '' || img == null) return null;
  if (typeof img !== 'string') return 'Invalid image';
  if (img.length > MAX_IMAGE) return 'Image too large (max 2MB)';
  if (!img.startsWith('data:image/')) return 'Invalid image';
  return null;
}

app.get('/api/suggestions', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const rows = q('SELECT * FROM game_suggestions ORDER BY id DESC');
  res.json({ suggestions: rows });
});

// customer submits a game suggestion (game name required, image optional)
app.post('/api/suggestions', (req, res) => {
  const cust = customerFromReq(req);
  if (!cust) return res.status(401).json({ error: 'Login required' });
  const b = req.body || {};
  const name = String(b.game_name || '').trim();
  const img = b.image == null ? '' : String(b.image).trim();
  if (!name) return res.status(400).json({ error: 'Game name is required' });
  if (name.length > 150) return res.status(400).json({ error: 'Game name is too long' });
  const imgErr = validSuggestionImage(img);
  if (imgErr) return res.status(400).json({ error: imgErr });
  const dup = q('SELECT id FROM game_suggestions WHERE account_id = ? AND status = ? AND LOWER(game_name) = ?', [cust.id, 'pending', name.toLowerCase()])[0];
  if (dup) return res.status(409).json({ error: 'You already have a pending suggestion for this game' });
  const existing = findGameInLibrary(name);
  let created = null;
  txn(() => {
    const now = nowISO();
    run('INSERT INTO game_suggestions (account_id, customer_name, customer_phone, game_name, image, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', [cust.id, cust.name, cust.phone, name, img, 'pending', now, now]);
    created = q('SELECT * FROM game_suggestions ORDER BY id DESC')[0];
  });
  broadcast('suggestions_changed', { suggestion: created });
  res.status(201).json({ suggestion: created, already_in_library: !!existing, existing });
});

// admin approve / reject
app.patch('/api/suggestions/:id', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const id = parseInt(req.params.id, 10);
  const row = q('SELECT * FROM game_suggestions WHERE id = ?', [id])[0];
  if (!row) return res.status(404).json({ error: 'Suggestion not found' });
  const status = String((req.body || {}).status || '');
  if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  txn(() => run('UPDATE game_suggestions SET status = ?, updated_at = ? WHERE id = ?', [status, nowISO(), id]));
  const updated = q('SELECT * FROM game_suggestions WHERE id = ?', [id])[0];
  let note = null;
  if (status === 'approved') {
    const found = findGameInLibrary(updated.game_name);
    note = found ? { already_in_library: true, tab: found.tab, name: found.name } : { already_in_library: false };
  }
  broadcast('suggestions_changed', { suggestion: updated, note });
  res.json({ suggestion: updated, note });
});

app.delete('/api/suggestions/:id', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const id = parseInt(req.params.id, 10);
  const row = q('SELECT * FROM game_suggestions WHERE id = ?', [id])[0];
  if (!row) return res.status(404).json({ error: 'Suggestion not found' });
  txn(() => run('DELETE FROM game_suggestions WHERE id = ?', [id]));
  broadcast('suggestions_changed', { deleted: id });
  res.json({ ok: true });
});

// ============ PACKAGES ============
function validPackage(b) {
  const errs = [];
  const out = {};
  if (b.name !== undefined) { const n = String(b.name || '').trim(); if (!n) errs.push('Package name is required'); else if (n.length > 120) errs.push('Package name is too long'); else out.name = n; }
  if (b.device_type !== undefined) { if (!DEVICE_TYPES.includes(b.device_type)) errs.push('Device type must be standard or vip'); else out.device_type = b.device_type; }
  if (b.duration !== undefined) { const d = parseInt(b.duration, 10); if (isNaN(d) || d < 15 || d > 1440) errs.push('Duration must be between 15 and 1440 minutes'); else out.duration = d; }
  if (b.price !== undefined) { const p = Number(b.price); if (!isFinite(p) || p < 0) errs.push('Price must be a valid number ≥ 0'); else out.price = Math.round(p * 100) / 100; }
  if (b.description !== undefined) { const d = String(b.description || ''); if (d.length > 500) errs.push('Description is too long'); else out.description = d; }
  if (b.status !== undefined) { if (!['active', 'inactive'].includes(b.status)) errs.push('Status must be active or inactive'); else out.status = b.status; }
  return { errs, out };
}

app.get('/api/packages', (req, res) => {
  res.json({ packages: q('SELECT * FROM packages ORDER BY id') });
});

app.post('/api/packages', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const { errs, out } = validPackage(req.body || {});
  if (errs.length) return res.status(400).json({ error: 'Validation failed', details: errs });
  if (!out.name || !out.duration || out.price === undefined) return res.status(400).json({ error: 'Name, duration and price are required' });
  const now = nowISO();
  const id = txn(() => run('INSERT INTO packages (name, device_type, duration, price, description, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', [
    out.name, out.device_type || 'standard', out.duration, out.price, out.description || '', out.status || 'active', now, now
  ]));
  const created = q('SELECT * FROM packages WHERE id = ?', [id])[0];
  broadcast('packages_changed', { package: created });
  res.status(201).json({ package: created });
});

app.patch('/api/packages/:id', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const id = parseInt(req.params.id, 10);
  const row = q('SELECT * FROM packages WHERE id = ?', [id])[0];
  if (!row) return res.status(404).json({ error: 'Package not found' });
  const { errs, out } = validPackage(req.body || {});
  if (errs.length) return res.status(400).json({ error: 'Validation failed', details: errs });
  Object.assign(out, { updated_at: nowISO() });
  txn(() => {
    for (const k of Object.keys(out)) run('UPDATE packages SET ' + k + ' = ? WHERE id = ?', [out[k], id]);
  });
  const updated = q('SELECT * FROM packages WHERE id = ?', [id])[0];
  broadcast('packages_changed', { package: updated });
  res.json({ package: updated });
});

app.delete('/api/packages/:id', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const id = parseInt(req.params.id, 10);
  const row = q('SELECT * FROM packages WHERE id = ?', [id])[0];
  if (!row) return res.status(404).json({ error: 'Package not found' });
  txn(() => run('DELETE FROM packages WHERE id = ?', [id]));
  broadcast('packages_changed', { deleted: id });
  res.json({ ok: true });
});

// ============ TRANSACTIONS LEDGER ============
app.get('/api/transactions', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const wire = dbMod.getTransactions().map(r => {
    const acc = getAccount(r.account_id);
    return { ...r, delta_balance: r.amount, delta_points: r.points, customer_name: acc ? acc.name : (String(r.account_id) === '0' ? '—' : '#' + r.account_id) };
  });
  res.json({ transactions: wire });
});

app.post('/api/accounts/:id/convert-points', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const cust = customerFromReq(req);
  if (!cust || cust.id !== id) return res.status(403).json({ error: 'Forbidden' });
  const acc = getAccount(id);
  const pts = parseInt((req.body || {}).points, 10);
  const rate = dbMod.numSetting('points_per_egp') || 10;
  if (!pts || pts < rate) return res.status(400).json({ error: 'Minimum ' + rate + ' points' });
  if (pts > (acc.points || 0)) return res.status(400).json({ error: 'Not enough points' });
  const egp = Math.floor(pts / rate);
  txn(() => {
    run('UPDATE accounts SET points = points - ?, balance = balance + ? WHERE id = ?', [pts, egp, id]);
    dbMod.addTransaction({ account_id: id, type: 'points_converted', amount: egp, points: -pts, reason: 'Converted ' + pts + ' points at ' + rate + ' pts/EGP', performed_by: 'system' });
  });
  const updated = sanitize(getAccount(id));
  broadcast('accounts_changed', { account: updated });
  res.json({ account: updated, egp });
});

// admin balance management (server-side validated, no partial writes)
app.post('/api/accounts/:id/balance', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const id = parseInt(req.params.id, 10);
  const acc = getAccount(id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  const b = req.body || {};
  const action = String(b.action || '');
  const amount = Number(b.amount);
  if (!['add', 'set'].includes(action)) return res.status(400).json({ error: 'Invalid action, use add or set' });
  if (!isFinite(amount)) return res.status(400).json({ error: 'Invalid amount' });
  const previous = acc.balance || 0;
  const newVal = action === 'set' ? amount : previous + amount;
  if (newVal < 0) return res.status(400).json({ error: 'Result would be negative' });
  const admin = adminFromReq(req);
  const admName = admin ? String((getAccount(admin.account_id) || {}).name || admin.account_id) : 'admin';
  txn(() => {
    run('UPDATE accounts SET balance = ? WHERE id = ?', [newVal, id]);
    dbMod.addTransaction({ account_id: id, type: 'admin_balance', amount: Math.round((newVal - previous) * 100) / 100, reason: 'Admin ' + action + ' balance (previous ' + previous + ')', performed_by: admName });
  });
  const updated = sanitize(getAccount(id));
  broadcast('accounts_changed', { account: updated });
  res.json({ account: updated, action, amount, previous });
});

// admin points management (server-side validated)
app.post('/api/accounts/:id/points', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const id = parseInt(req.params.id, 10);
  const acc = getAccount(id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  const b = req.body || {};
  const action = String(b.action || '');
  const amount = parseInt(b.amount, 10);
  if (!['add', 'set'].includes(action)) return res.status(400).json({ error: 'Invalid action, use add or set' });
  if (isNaN(amount)) return res.status(400).json({ error: 'Invalid amount' });
  const previous = acc.points || 0;
  const newVal = action === 'set' ? amount : previous + amount;
  if (newVal < 0) return res.status(400).json({ error: 'Result would be negative' });
  const admin = adminFromReq(req);
  const admName = admin ? String((getAccount(admin.account_id) || {}).name || admin.account_id) : 'admin';
  txn(() => {
    run('UPDATE accounts SET points = ? WHERE id = ?', [newVal, id]);
    dbMod.addTransaction({ account_id: id, type: 'admin_points', points: newVal - previous, reason: 'Admin ' + action + ' points (previous ' + previous + ')', performed_by: admName });
  });
  const updated = sanitize(getAccount(id));
  broadcast('accounts_changed', { account: updated });
  res.json({ account: updated, action, amount, previous });
});

app.delete('/api/accounts/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const acc = getAccount(id);
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  const admin = !!adminFromReq(req);
  const cust = customerFromReq(req);
  if (!admin && (!cust || cust.id !== id)) return res.status(403).json({ error: 'Forbidden' });
  txn(() => {
    run('DELETE FROM sessions WHERE account_id = ?', [id]);
    run('DELETE FROM bookings WHERE account_id = ? OR phone = ?', [id, acc.phone]);
    run('DELETE FROM memberships WHERE account_id = ?', [id]);
    run('DELETE FROM accounts WHERE id = ?', [id]);
  });
  broadcast('accounts_changed', { deleted: id });
  broadcast('bookings_changed', { deleted: { accountId: id } });
  res.json({ ok: true });
});

// ============ BOOKINGS ============
app.get('/api/bookings', (req, res) => {
  const admin = adminFromReq(req);
  const cust = customerFromReq(req);
  if (admin) return res.json({ bookings: q('SELECT * FROM bookings ORDER BY id DESC') });
  if (cust) return res.json({ bookings: q('SELECT * FROM bookings WHERE account_id = ? OR phone = ? ORDER BY id DESC', [cust.id, cust.phone]) });
  res.json({ bookings: [] });
});

app.post('/api/bookings', (req, res) => {
  const b = req.body || {};
  const pcs = Array.isArray(b.pcs) ? b.pcs.map(String).map(s => s.trim()).filter(Boolean) : [];
  const known = new Set(dbMod.getDevices().map(d => d.pc));
  if (!pcs.length) return res.status(400).json({ error: 'Select at least one PC' });
  for (const pc of pcs) if (!known.has(pc)) return res.status(400).json({ error: 'Unknown PC: ' + pc });
  const date = String(b.date || '');
  const time = String(b.time || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'Invalid date or time' });
  let duration = parseInt(b.duration, 10);
  if (isNaN(duration) || duration <= 0) duration = 60;
  let cust = customerFromReq(req);
  // PART 5: admin can create a reservation for an existing customer (manual counter booking)
  // – the same table, validation, price engine and availability rules apply.
  const adm = adminFromReq(req);
  if (!cust && adm && b.account_id) {
    const linkId = parseInt(b.account_id, 10) || 0;
    if (linkId <= 0) return res.status(400).json({ error: 'Invalid customer' });
    const acc = getAccount(linkId);
    if (!acc) return res.status(400).json({ error: 'Customer not found' });
    cust = acc;
  }
  const name = String((cust && cust.name) || b.name || '').trim();
  const phone = String((cust && cust.phone) || b.phone || '').trim();
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone are required' });

  const nowMs = Date.now();
  const startMs = new Date(date + 'T' + time).getTime();
  if (startMs + duration * 60000 <= nowMs) return res.status(400).json({ error: 'Booking time is in the past' });

  const conflict = checkConflict(date, time, duration, pcs);
  if (conflict) {
    if (conflict.manual) return res.status(409).json({ error: conflict.reason, conflict: { pc: conflict.pc, manual: true } });
    const cb = conflict.booking;
    return res.status(409).json({ error: 'PC is already booked in this period', conflict: { pc: conflict.pc, name: cb.name, start: cb.time, end: minToTime(toMin(cb.time) + (cb.duration || 0)) } });
  }

  // final price is always calculated server-side from the current database config
  const price = priceForBooking(pcs, duration);
  const payWithBalance = !!b.pay_with_balance && !!cust;
  let created = null;

  if (payWithBalance) {
    if (price.total <= 0) return res.status(400).json({ error: 'Booking price is zero, nothing to pay' });
    let outcome = null;
    txn(() => {
      const acc = getAccount(cust.id);
      if ((acc.balance || 0) < price.total) { outcome = { insufficient: true }; return; }
      const id = run('INSERT INTO bookings (account_id, name, phone, pcs, duration, addon, date, time, status, manual, created_at, price, balance_paid) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
        cust.id, name, phone, JSON.stringify(pcs), duration, String(b.addon || 'None'), date, time, 'pending', 0, nowISO(), price.total, price.total
      ]);
      run('UPDATE accounts SET balance = balance - ? WHERE id = ?', [price.total, cust.id]);
      dbMod.addTransaction({ account_id: cust.id, type: 'booking_payment', amount: -price.total, ref_type: 'booking', ref_id: id, reason: 'Booking paid from balance (' + pcs.join(', ') + ' · ' + duration + ' min)', performed_by: 'system' });
      outcome = { id };
    });
    if (outcome && outcome.insufficient) {
      const bal = getAccount(cust.id).balance || 0;
      return res.status(402).json({ error: 'Insufficient balance — need ' + price.total + ' EGP, current balance ' + bal, price: price.total, balance: bal });
    }
    created = q('SELECT * FROM bookings WHERE id = ?', [outcome.id])[0];
    const acc = getAccount(cust.id);
    broadcast('accounts_changed', { account: sanitize(acc) });
  } else {
    const id = txn(() => run('INSERT INTO bookings (account_id, name, phone, pcs, duration, addon, date, time, status, manual, created_at, price) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [
      cust ? cust.id : null, name, phone, JSON.stringify(pcs), duration, String(b.addon || 'None'), date, time, 'pending', 0, nowISO(), price.total
    ]));
    created = q('SELECT * FROM bookings WHERE id = ?', [id])[0];
  }

  broadcast('bookings_changed', { booking: created });
  devicesChanged(date);
  res.status(201).json({ booking: created, price: { total: price.total, breakdown: price.breakdown } });
});

// public availability check (used by live conflict widget in the booking form)
app.post('/api/availability', (req, res) => {
  const b = req.body || {};
  const pcs = Array.isArray(b.pcs) ? b.pcs.map(String).map(s => s.trim()).filter(Boolean) : [];
  const date = String(b.date || '');
  const time = String(b.time || '');
  const duration = parseInt(b.duration, 10) || 60;
  if (!pcs.length || !date || !time) return res.json({ conflicts: [], nextFree: null });
  const conflicts = [];
  let nextFree = null;
  // manually occupied devices are unavailable for every time slot
  const devs = dbMod.getDevices();
  for (const pc of pcs) {
    const d = devs.find(x => x.pc === pc);
    if (d && d.status === 'manual_occupied') conflicts.push({ pc, name: 'Manually occupied', start: 'Now', end: 'Until released' });
  }
  const list = q("SELECT * FROM bookings WHERE date = ? AND status IN ('pending','active') AND manual = 0", [date]);
  for (const x of list) {
    const xPcs = bookingPCs(x);
    const shared = pcs.find(pc => xPcs.includes(pc));
    if (!shared) continue;
    const start = toMin(time), end = start + duration;
    const xStart = toMin(x.time), xEnd = xStart + (x.duration || 0);
    if (start < xEnd && xStart < end) {
      conflicts.push({ pc: shared, name: x.name, start: x.time, end: minToTime(xEnd) });
    } else if (xEnd > start && (!nextFree || xEnd < nextFree)) {
      nextFree = xEnd;
    }
  }
  res.json({ conflicts: conflicts.sort((a, b) => a.start.localeCompare(b.start)), nextFree: nextFree === null ? null : minToTime(nextFree) });
});

app.patch('/api/bookings/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = q('SELECT * FROM bookings WHERE id = ?', [id])[0];
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  const admin = !!adminFromReq(req);
  const cust = customerFromReq(req);
  const body = req.body || {};
  const requested = String(body.status || '');
  if (!admin) {
    if (!cust || (cust.id !== b.account_id && cust.phone !== b.phone)) return res.status(403).json({ error: 'Forbidden' });
    if (requested !== 'cancelled') return res.status(403).json({ error: 'Forbidden' });
    if (b.status !== 'pending') return res.status(400).json({ error: 'Only pending reservations can be cancelled' });
    if (b.date < todayStr() || (b.date === todayStr() && nowMinutes() >= toMin(b.time))) return res.status(400).json({ error: 'This reservation already started' });
  }
  const newStatus = admin ? (requested || b.status) : 'cancelled';
  // PART 5: refund the exact paid amount when an UNUSED (pending) paid reservation is cancelled.
  // Business rule: money taken only for service rendered; unused reservations get the paid amount back.
  // Started/completed reservations are not refunded. Ledger gets a booking_refund audit row.
  const refundable = newStatus === 'cancelled' && b.status !== 'cancelled' && (b.balance_paid || 0) > 0 && b.status === 'pending' && !!b.account_id;
  const admSession = admin && adminFromReq(req);
  const admName = admin && admSession ? String((getAccount(admSession.account_id) || {}).name || admSession.account_id) : 'admin';
  txn(() => {
    if (newStatus === 'active' && b.status !== 'active') run('UPDATE bookings SET started_at = ? WHERE id = ?', [nowISO(), id]);
    if (['completed', 'cancelled'].includes(newStatus)) run('UPDATE bookings SET status = ?, ended_at = ? WHERE id = ?', [newStatus, nowISO(), id]);
    else run('UPDATE bookings SET status = ? WHERE id = ?', [newStatus, id]);
    if (refundable) {
      run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [b.balance_paid, b.account_id]);
      dbMod.addTransaction({ account_id: b.account_id, type: 'booking_refund', amount: b.balance_paid, ref_type: 'booking', ref_id: id, reason: 'Cancelled reservation refund (paid ' + b.balance_paid + ' EGP)', performed_by: admin ? admName : 'customer' });
    }
  });
  if (refundable) broadcast('accounts_changed', { account: sanitize(getAccount(b.account_id)) });
  if (newStatus === 'completed') awardPointsForBooking({ ...b, status: 'completed', ended_at: nowISO() });
  const updated = q('SELECT * FROM bookings WHERE id = ?', [id])[0];
  broadcast('bookings_changed', { booking: updated });
  devicesChanged(b.date);
  res.json({ booking: updated });
});

app.delete('/api/bookings/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const admin = !!adminFromReq(req);
  const cust = customerFromReq(req);
  const b = q('SELECT * FROM bookings WHERE id = ?', [id])[0];
  if (!b) return res.status(404).json({ error: 'Booking not found' });
  if (!admin && (!cust || (cust.id !== b.account_id && cust.phone !== b.phone))) return res.status(403).json({ error: 'Forbidden' });
  txn(() => run('DELETE FROM bookings WHERE id = ?', [id]));
  broadcast('bookings_changed', { deleted: { id } });
  devicesChanged(b.date);
  res.json({ ok: true });
});

// ============ DEVICES ============
app.get('/api/devices', (req, res) => {
  const date = req.query.date || todayStr();
  res.json({ date, devices: getDeviceSnapshot(date), settings: {
    points_std_per_hour: dbMod.numSetting('points_std_per_hour'),
    points_vip_per_hour: dbMod.numSetting('points_vip_per_hour'),
    standard_price_per_hour: dbMod.numSetting('standard_price_per_hour'),
    vip_price_per_hour: dbMod.numSetting('vip_price_per_hour')
  } });
});

app.post('/api/devices/manual-busy', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const b = req.body || {};
  const pcs = Array.isArray(b.pcs) ? (b.pcs).map(String) : [];
  const force = b.force === true;
  const name = String(b.name || 'Walk-in').trim() || 'Walk-in';
  if (!pcs.length) return res.status(400).json({ error: 'Select at least one PC' });
  const known = new Set(dbMod.getDevices().map(d => d.pc));
  for (const pc of pcs) if (!known.has(pc)) return res.status(400).json({ error: 'Unknown PC: ' + pc });
  // PART 5: warn (do not silently overwrite) when a reservation already occupies this device.
  // A manual session is open-ended → it conflicts with any reservation that has not ended yet.
  if (!force) {
    const pre = q("SELECT * FROM bookings WHERE status IN ('pending','active') AND manual = 0");
    const conflicts = [];
    for (const pc of pcs) {
      for (const r of pre) {
        if (!bookingPCs(r).includes(pc)) continue;
        const startMs = new Date(r.date + 'T' + r.time).getTime();
        if (!isNaN(startMs) && startMs + (r.duration || 0) * 60000 > Date.now()) {
          conflicts.push({ pc, booking: { id: r.id, name: r.name, date: r.date, time: r.time, duration: r.duration } });
        }
      }
    }
    if (conflicts.length) return res.status(409).json({ error: 'This device has a reservation — manual occupation would cover it', manual_conflict: true, conflicts });
  }
  const now = nowISO();
  txn(() => {
    for (const pc of pcs) {
      run('INSERT INTO devices (pc, type, status, manual_name, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(pc) DO UPDATE SET status = ?, manual_name = ?, updated_at = ?', [
        pc, dbMod.deviceTypeOf(pc), 'manual_occupied', name, now, 'manual_occupied', name, now
      ]);
      const existing = q("SELECT id FROM bookings WHERE manual = 1 AND status = 'active' AND pcs LIKE ?", ['%"' + pc + '"%'])[0];
      if (!existing) {
        run('INSERT INTO bookings (account_id, name, phone, pcs, duration, addon, date, time, status, manual, created_at, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', [
          null, name, 'N/A', JSON.stringify([pc]), 0, 'None', todayStr(), minToTime(nowMinutes()), 'active', 1, now, now
        ]);
      }
    }
  });
  broadcast('bookings_changed', { manual: 'busy', pcs });
  devicesChanged(todayStr());
  res.json({ ok: true, devices: getDeviceSnapshot() });
});

app.post('/api/devices/manual-free', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const pcs = Array.isArray((req.body || {}).pcs) ? (req.body.pcs).map(String) : [];
  if (!pcs.length) return res.status(400).json({ error: 'Select at least one PC' });
  const completedBookings = [];
  txn(() => {
    for (const pc of pcs) {
      run('UPDATE devices SET status = ?, manual_name = ?, updated_at = ? WHERE pc = ?', ['available', '', nowISO(), pc]);
      const man = q("SELECT * FROM bookings WHERE manual = 1 AND status = 'active'");
      for (const b of man) {
        if (bookingPCs(b).includes(pc)) {
          run("UPDATE bookings SET status = 'completed', ended_at = ? WHERE id = ?", [nowISO(), b.id]);
          completedBookings.push(b);
        }
      }
    }
  });
  for (const b of completedBookings) awardPointsForBooking({ ...b, status: 'completed', ended_at: nowISO() });
  broadcast('bookings_changed', { manual: 'free', pcs });
  devicesChanged(todayStr());
  res.json({ ok: true, devices: getDeviceSnapshot() });
});

// ============ DEVICES CRUD ============
app.post('/api/devices', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const b = req.body || {};
  const pc = String(b.pc || '').trim();
  const type = DEVICE_TYPES.includes(b.type) ? b.type : 'standard';
  if (!/^[\w\- ]{2,20}$/.test(pc)) return res.status(400).json({ error: 'Invalid device name (2-20 letters/numbers, dash or space)' });
  const dup = q('SELECT pc FROM devices WHERE pc = ?', [pc])[0];
  if (dup) return res.status(409).json({ error: 'Device already exists' });
  txn(() => run('INSERT INTO devices (pc, type, status, manual_name, updated_at) VALUES (?,?,?,?,?)', [pc, type, 'available', '', nowISO()]));
  broadcast('devices_changed', { devices: getDeviceSnapshot() });
  res.status(201).json({ ok: true, device: { pc, type } });
});

app.patch('/api/devices/:pc', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const oldPc = String(req.params.pc || '');
  const cur = q('SELECT * FROM devices WHERE pc = ?', [oldPc])[0];
  if (!cur) return res.status(404).json({ error: 'Device not found' });
  const b = req.body || {};
  let newPc = oldPc;
  let type = cur.type;
  if (b.pc !== undefined) {
    newPc = String(b.pc).trim();
    if (!/^[\w\- ]{2,20}$/.test(newPc)) return res.status(400).json({ error: 'Invalid device name' });
    if (newPc !== oldPc) {
      const dup = q('SELECT pc FROM devices WHERE pc = ?', [newPc])[0];
      if (dup) return res.status(409).json({ error: 'Device name already exists' });
    }
  }
  if (b.type !== undefined) {
    if (!DEVICE_TYPES.includes(b.type)) return res.status(400).json({ error: 'Invalid device type' });
    type = b.type;
  }
  txn(() => {
    if (newPc !== oldPc) {
      // rewrite PC references inside pending/active booking JSON so data stays consistent
      const rows = q("SELECT id, pcs FROM bookings WHERE status IN ('pending','active')");
      for (const r of rows) {
        let arr;
        try { arr = JSON.parse(r.pcs || '[]'); } catch { continue; }
        if (arr.includes(oldPc)) {
          run('UPDATE bookings SET pcs = ? WHERE id = ?', [JSON.stringify(arr.map(x => x === oldPc ? newPc : x)), r.id]);
        }
      }
    }
    run('UPDATE devices SET pc = ?, type = ?, updated_at = ? WHERE pc = ?', [newPc, type, nowISO(), oldPc]);
  });
  broadcast('devices_changed', { devices: getDeviceSnapshot() });
  res.json({ ok: true, device: { pc: newPc, type } });
});

app.delete('/api/devices/:pc', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const pc = String(req.params.pc || '');
  const cur = q('SELECT * FROM devices WHERE pc = ?', [pc])[0];
  if (!cur) return res.status(404).json({ error: 'Device not found' });
  if (cur.status === 'manual_occupied') return res.status(409).json({ error: 'Device is manually occupied. Release it first.' });
  let touching = false;
  for (const r of q("SELECT pcs FROM bookings WHERE status IN ('pending','active')")) {
    try { if (JSON.parse(r.pcs || '[]').includes(pc)) { touching = true; break; } } catch {}
  }
  if (touching) return res.status(409).json({ error: 'Device has pending/active reservations. Cannot delete.' });
  txn(() => {
    run('DELETE FROM devices WHERE pc = ?', [pc]);
    run('DELETE FROM bookings WHERE manual = 1 AND pcs = ?', [JSON.stringify([pc])]);
  });
  broadcast('devices_changed', { devices: getDeviceSnapshot() });
  broadcast('bookings_changed', { deviceDeleted: pc });
  res.json({ ok: true });
});

// reservations affecting a specific device (admin)
app.get('/api/devices/:pc/bookings', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const pc = String(req.params.pc || '');
  const bookings = q('SELECT * FROM bookings ORDER BY id DESC').filter(b => bookingPCs(b).includes(pc));
  res.json({ pc, bookings });
});

// ============ MEMBERSHIPS ============
app.get('/api/memberships', (req, res) => {
  const admin = adminFromReq(req);
  const cust = customerFromReq(req);
  if (admin) return res.json({ memberships: q('SELECT * FROM memberships ORDER BY id DESC') });
  if (cust) return res.json({ memberships: q('SELECT * FROM memberships WHERE account_id = ? ORDER BY id DESC', [cust.id]) });
  res.json({ memberships: [] });
});

app.post('/api/memberships', (req, res) => {
  const cust = customerFromReq(req);
  if (!cust) return res.status(401).json({ error: 'Please login first' });
  const { tier, amount } = req.body || {};
  if (!tier || !amount) return res.status(400).json({ error: 'Missing tier or amount' });
  const pending = q("SELECT * FROM memberships WHERE account_id = ? AND tier = ? AND status = 'pending'", [cust.id, String(tier)])[0];
  if (pending) return res.status(409).json({ error: 'Request already sent' });
  const id = txn(() => run('INSERT INTO memberships (account_id, tier, amount, status, created_at) VALUES (?,?,?,?,?)', [cust.id, String(tier), parseFloat(amount) || 0, 'pending', nowISO()]));
  const created = q('SELECT * FROM memberships WHERE id = ?', [id])[0];
  broadcast('memberships_changed', { membership: created });
  res.status(201).json({ membership: created });
});

app.patch('/api/memberships/:id', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const id = parseInt(req.params.id, 10);
  const m = q('SELECT * FROM memberships WHERE id = ?', [id])[0];
  if (!m) return res.status(404).json({ error: 'Membership not found' });
  const status = String((req.body || {}).status || '');
  if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  txn(() => run('UPDATE memberships SET status = ? WHERE id = ?', [status, id]));
  if (status === 'approved' && m.status !== 'approved') {
    const acc = getAccount(m.account_id);
    if (acc) {
      txn(() => run('UPDATE accounts SET balance = balance + ? WHERE id = ?', [parseFloat(m.amount) || 0, m.account_id]));
  dbMod.addTransaction({ account_id: m.account_id, type: 'membership_credit', amount: parseFloat(m.amount) || 0, ref_type: 'membership', ref_id: m.id, reason: 'Approved ' + m.tier + ' membership', performed_by: 'admin' });
      broadcast('accounts_changed', { account: sanitize(getAccount(m.account_id)) });
    }
  }
  const updated = q('SELECT * FROM memberships WHERE id = ?', [id])[0];
  broadcast('memberships_changed', { membership: updated });
  res.json({ membership: updated });
});

// ============ SETTINGS ============
app.get('/api/settings', (req, res) => {
  res.json({ settings: dbMod.getSettings() });
});

app.put('/api/settings', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const b = req.body || {};
  const edits = {};
  if (b.points_std_per_hour !== undefined) edits.points_std_per_hour = Math.max(0, parseFloat(b.points_std_per_hour) || 0);
  if (b.points_vip_per_hour !== undefined) edits.points_vip_per_hour = Math.max(0, parseFloat(b.points_vip_per_hour) || 0);
  if (b.points_per_egp !== undefined) edits.points_per_egp = Math.max(1, parseInt(b.points_per_egp, 10) || 1);
  if (b.standard_price_per_hour !== undefined) edits.standard_price_per_hour = Math.max(0, parseFloat(b.standard_price_per_hour) || 0);
  if (b.vip_price_per_hour !== undefined) edits.vip_price_per_hour = Math.max(0, parseFloat(b.vip_price_per_hour) || 0);
  if (b.deposit !== undefined) edits.deposit = Math.max(0, parseFloat(b.deposit) || 0);
  if (b.admin_user !== undefined && String(b.admin_user).trim()) edits.admin_user = String(b.admin_user).trim();
  if (b.admin_pass !== undefined && String(b.admin_pass).length >= 4) edits.admin_pass = String(b.admin_pass);
  txn(() => { for (const k of Object.keys(edits)) dbMod.setSetting(k, edits[k]); });
  broadcast('settings_changed', { settings: dbMod.getSettings() });
  res.json({ settings: dbMod.getSettings() });
});

// ============ WEBSITE CONTENT (CMS) ============
app.get('/api/content', (req, res) => {
  const m = dbMod.getContentMap();
  res.json({ content: m, updated_at: m._updated_at || {} });
});

// admin writes one content section; validated server-side before any DB write
app.put('/api/content/:key', (req, res) => {
  if (!adminFromReq(req)) return res.status(401).json({ error: 'Admin only' });
  const key = String(req.params.key || '');
  const errs = validateContent(key, req.body);
  if (errs.length) return res.status(400).json({ error: 'Validation failed', details: errs });
  txn(() => dbMod.setContent(key, req.body));
  const value = dbMod.getContent(key);
  broadcast('content_changed', { key, value, updated_at: new Date().toISOString() });
  res.json({ ok: true, key, value });
});

// ============ STATIC (with privacy guard) ============
const BLOCKED = ['/node_modules', '/data', '/db.js', '/server.js', '/test.js'];
app.use((req, res, next) => {
  const p = req.path;
  if (BLOCKED.some(x => p === x || p.startsWith(x + '/')) || /^\/package(-lock)?\.json$/.test(p)) return res.status(404).end();
  next();
});
app.use(express.static(path.join(__dirname), { index: 'index.html' }));

const server = http.createServer(app);

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
});

setInterval(() => {
  for (const c of wss.clients) if (c.readyState === 1) c.send(JSON.stringify({ type: 'ping' }));
}, 25000);

setInterval(() => lifeCycleTick(), 30000);

async function start() {
  await dbMod.init();
  if (process.env.MIGRATE_DISABLED !== '1') {
    try { await require('./migrate').maybeMigrate(dbMod); } catch (e) { console.warn('Migration skipped:', e.message); }
  }
  server.listen(PORT, () => {
    console.log('GAME ZONE server running at http://localhost:' + PORT);
    console.log('Admin: http://localhost:' + PORT + '/admin.html');
  });
}

module.exports = { start, lifeCycleTick, getDeviceSnapshot, db: dbMod };

if (require.main === module) start();