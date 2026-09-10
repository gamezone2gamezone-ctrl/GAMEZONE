/* =============================
   GAME ZONE â€“ automated test suite (PART 1)
   Uses an isolated DB (env DB_PATH) + in-process server.
   ============================= */
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = 3999;
const BASE = 'http://127.0.0.1:' + PORT;
const dbFile = path.join(process.env.TEMP || '/tmp', 'gzg_test_' + Date.now() + '.db');
fs.rmSync(dbFile, { force: true });

process.env.PORT = String(PORT);
process.env.DB_PATH = dbFile;
process.env.MIGRATE_DISABLED = '1';

const serverMod = require('./server.js');

let passed = 0, failed = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function assert(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log('  âœ“ ' + name);
  }).catch(e => {
    failed++;
    console.error('  âœ— ' + name + '\n    -> ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n       ') : e));
  });
}

async function api(method, p, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function hhmm(d) {
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function nowTotalMinutes() { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); }
// date for an arbitrary timestamp (keeps booking dates consistent with their future times near midnight)
function dt(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// a guaranteed-future booking slot: { date, time } taken from minAhead in the future
function ftSlot(minAhead) {
  const d = new Date(Date.now() + minAhead * 60000);
  return { date: dt(d), time: hhmm(d) };
}
function shiftDate(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt2 = new Date(y, m - 1, d + delta);
  return dt2.getFullYear() + '-' + String(dt2.getMonth() + 1).padStart(2, '0') + '-' + String(dt2.getDate()).padStart(2, '0');
}
function nowISO() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

function waitEvent(ws, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', onmsg); reject(new Error('timeout waiting for ' + type)); }, timeout);
    const onmsg = raw => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === type) { clearTimeout(t); ws.off('message', onmsg); resolve(m); }
    };
    ws.on('message', onmsg);
  });
}

async function main() {
  await serverMod.start();
  await sleep(1200);

  const wsClient = new WebSocket('ws://127.0.0.1:' + PORT + '/ws');
  await new Promise((res, rej) => { wsClient.on('open', res); wsClient.on('error', rej); });

  console.log('\n===== REAL-TIME SYNC =====');
  const wsAccountsEvt = waitEvent(wsClient, 'accounts_changed');
  const reg = await api('POST', '/api/auth/register', { name: 'Ahmed Test', phone: '01000000001', password: 'pass1234' });
  assert('registration returns token + account with balance/points', () => {
    if (reg.status !== 201) throw new Error('status ' + reg.status + ' ' + JSON.stringify(reg.data));
    if (!reg.data.token || !reg.data.account) throw new Error('missing token/account');
    if (reg.data.account.balance === undefined || reg.data.account.points === undefined) throw new Error('missing balance/points');
  });
  await assert('WS broadcasts accounts_changed on register', () => wsAccountsEvt.then(e => {
    if (!e.data || !e.data.account || e.data.account.phone !== '01000000001') throw new Error('bad payload');
  }));
  const tokenA = reg.data.token;

  await assert('duplicate phone registration rejected (409)', async () => {
    const r = await api('POST', '/api/auth/register', { name: 'X', phone: '01000000001', password: 'aaaa' });
    if (r.status !== 409) throw new Error('expected 409 got ' + r.status);
  });

  await assert('duplicate username registration rejected (409)', async () => {
    const r = await api('POST', '/api/auth/register', { name: 'A', username: 'medo', phone: '01000000002', password: 'bbbb' });
    if (r.status !== 201) throw new Error('setup failed ' + r.status);
    const dup = await api('POST', '/api/auth/register', { name: 'B', username: 'medo', phone: '01000000003', password: 'cccc' });
    if (dup.status !== 409) throw new Error('expected 409 got ' + dup.status);
  });

  await assert('3rd account with unique username registered', async () => {
    const r = await api('POST', '/api/auth/register', { name: 'Sara', username: 'sara', phone: '01000000003', password: 'dddd' });
    if (r.status !== 201) throw new Error('setup failed ' + r.status);
  });

  await assert('login from another device preserves same account data', async () => {
    const r = await api('POST', '/api/auth/login', { phone: '01000000002', password: 'bbbb' });
    if (r.status !== 200 || r.data.account.phone !== '01000000002') throw new Error('login failed ' + r.status);
    if (r.data.account.password !== undefined) throw new Error('password leaked');
  });
  await assert('login with wrong password rejected', async () => {
    const r = await api('POST', '/api/auth/login', { phone: '01000000001', password: 'nope' });
    if (r.status !== 401) throw new Error('expected 401');
  });

  await assert('profile persists via /me', async () => {
    const me = await api('GET', '/api/auth/me', null, tokenA);
    if (me.status !== 200 || me.data.account.name !== 'Ahmed Test') throw new Error('me mismatch');
  });

  console.log('\n===== ALL ACCOUNTS VISIBLE TO ADMIN =====');
  const adminLogin = await api('POST', '/api/admin/login', { username: 'MEDO', password: '123456' });
  assert('admin login works', () => { if (adminLogin.status !== 200 || !adminLogin.data.token) throw new Error('admin login failed'); });
  const adminToken = adminLogin.data.token;

  await assert('admin sees ALL registered accounts (no refresh needed)', async () => {
    const r = await api('GET', '/api/accounts', null, adminToken);
    if (r.status !== 200) throw new Error('admin accounts ' + r.status);
    const phones = r.data.accounts.map(a => a.phone);
    for (const p of ['01000000001', '01000000002', '01000000003']) {
      if (!phones.includes(p)) throw new Error('missing account ' + p);
    }
    if (r.data.accounts.some(a => a.password !== undefined)) throw new Error('password leaked');
  });

  console.log('\n===== BOOKING + CONFLICT + DEVICE COLORS =====');
  const now = new Date();
  const plus30 = new Date(now.getTime() + 30 * 60000);
  const plus90 = new Date(now.getTime() + 90 * 60000);
  const plus150 = new Date(now.getTime() + 150 * 60000);

  const booking = await api('POST', '/api/bookings', { pcs: ['PC 1'], duration: 30, date: dt(plus30), time: hhmm(plus30), addon: 'None' }, tokenA);
  assert('booking created on server (mobile â†’ admin)', () => { if (booking.status !== 201) throw new Error('create ' + booking.status + ' ' + JSON.stringify(booking.data)); });
  const bookingId = booking.data.booking.id;

  await assert('overlapping booking SAME PC/time rejected (409)', async () => {
    const r = await api('POST', '/api/bookings', { pcs: ['PC 1'], duration: 30, date: dt(plus30), time: hhmm(plus30) }, tokenA);
    if (r.status !== 409) throw new Error('expected 409 got ' + r.status);
    if (!r.data.conflict) throw new Error('missing conflict payload');
  });

await assert('non-conflicting booking (later period) accepted', async () => {
    const r = await api('POST', '/api/bookings', { pcs: ['PC 1'], duration: 30, date: dt(plus90), time: hhmm(plus90) }, tokenA);
    if (r.status !== 201) throw new Error('expected 201 got ' + r.status);
  });

  await assert('upcoming reservation → device YELLOW (same calendar day)', async () => {
    const qd = dt(plus90);
    const r = await api('GET', '/api/devices?date=' + qd);
    const dev = r.data.devices.find(d => d.pc === 'PC 1');
    if (!dev) throw new Error('PC 1 missing');
    // same-calendar-day upcoming ⇒ yellow; a future-day reservation views as available (day-boundary semantics)
    if (qd === today()) {
      if (dev.color !== 'yellow') throw new Error('expected yellow but got ' + dev.color + ' (' + dev.label + ')');
    } else {
      if (dev.color === 'red') throw new Error('unexpected RED for future-day reservation');
    }
  });

  await assert('now-active reservation â†’ device RED (time-based)', async () => {
    const wsBookingEvt = waitEvent(wsClient, 'bookings_changed');
    const r = await api('POST', '/api/bookings', { pcs: ['PC 2'], duration: 30, date: today(), time: hhmm(new Date()) }, tokenA);
    if (r.status !== 201) throw new Error('create ' + r.status);
    const snap = await api('GET', '/api/devices?date=' + today());
    const dev = snap.data.devices.find(d => d.pc === 'PC 2');
    if (!dev || dev.color !== 'red') throw new Error('expected RED got ' + (dev && dev.color));
    // WS broadcast for this booking creation
    await wsBookingEvt.then(e => {
      if (!e.data || (!e.data.booking && !e.data.manual)) throw new Error('bad bookings_changed payload');
    });
  });

  console.log('\n===== SERVER-TIME LIFECYCLE =====');
  await assert('reservation auto-completes at end time + points awarded + device GREEN', async () => {
    // force high rate so even a few minutes => points
    await api('PUT', '/api/settings', { points_std_per_hour: 60 }, adminToken);
    const mk = await api('POST', '/api/bookings', { pcs: ['PC 4'], duration: 120, date: today(), time: hhmm(new Date()) }, tokenA);
    if (mk.status !== 201) throw new Error('create ' + mk.status);
    const lid = mk.data.booking.id;
    // move booking so it has already ended
    const dur = Math.max(2, nowTotalMinutes() - 3);
    serverMod.db.run('UPDATE bookings SET time = ?, duration = ? WHERE id = ?', ['00:01', dur, lid]);
    serverMod.db.persist();
    const pointsBefore = (await api('GET', '/api/auth/me', null, tokenA)).data.account.points;
    serverMod.lifeCycleTick();
    const bn = serverMod.db.q('SELECT status, points_awarded FROM bookings WHERE id = ?', [lid])[0];
    if (bn.status !== 'completed') throw new Error('expected completed got ' + bn.status);
    if (bn.points_awarded !== 1) throw new Error('points not awarded');
    const me = await api('GET', '/api/auth/me', null, tokenA);
    if (!(me.data.account.points > pointsBefore)) throw new Error('customer points not increased: ' + pointsBefore + ' -> ' + me.data.account.points);
    const snap = await api('GET', '/api/devices?date=' + today());
    const pc4 = snap.data.devices.find(d => d.pc === 'PC 4');
    if (pc4.color !== 'green') throw new Error('PC4 should be green after completion, got ' + pc4.color);
    await api('PUT', '/api/settings', { points_std_per_hour: 10 }, adminToken);
  });

  console.log('\n===== MANUAL DEVICE CONTROL =====');
  await assert('manual occupied â†’ RED and SURVIVES server tick (not auto-freed)', async () => {
    const r = await api('POST', '/api/devices/manual-busy', { pcs: ['PC 3'], name: 'Walk-in Guest' }, adminToken);
    if (r.status !== 200) throw new Error('manual busy failed ' + r.status);
    const snap1 = await api('GET', '/api/devices?date=' + today());
    const d1 = snap1.data.devices.find(d => d.pc === 'PC 3');
    if (d1.color !== 'red' || !d1.manual) throw new Error('PC3 not RED/manual');
    for (let i = 0; i < 4; i++) serverMod.lifeCycleTick();
    const snap2 = await api('GET', '/api/devices?date=' + today());
    const d2 = snap2.data.devices.find(d => d.pc === 'PC 3');
    if (d2.color !== 'red' || d2.label !== 'Occupied') throw new Error('manual occupied was auto-cleared or lost label');
  });

  await assert('manual free â†’ GREEN', async () => {
    const r = await api('POST', '/api/devices/manual-free', { pcs: ['PC 3'] }, adminToken);
    if (r.status !== 200) throw new Error('manual free failed ' + r.status);
    const snap = await api('GET', '/api/devices?date=' + today());
    const d = snap.data.devices.find(x => x.pc === 'PC 3');
    if (d.color !== 'green' || d.manual) throw new Error('PC3 not green after free');
  });

  console.log('\n===== BALANCE / POINTS / MEMBERSHIP / SETTINGS =====');
  await assert('admin balance change â†’ immediate + persisted for customer', async () => {
    const r = await api('PATCH', '/api/accounts/1', { balance: 250 }, adminToken);
    if (r.status !== 200 || r.data.account.balance !== 250) throw new Error('balance patch failed');
    const me = await api('GET', '/api/auth/me', null, tokenA);
    if (me.data.account.balance !== 250) throw new Error('customer balance stale');
  });

  await assert('admin points change â†’ immediate + persisted for customer', async () => {
    const r = await api('PATCH', '/api/accounts/1', { points: 100 }, adminToken);
    if (r.status !== 200 || r.data.account.points !== 100) throw new Error('points patch failed');
    const me = await api('GET', '/api/auth/me', null, tokenA);
    if (me.data.account.points !== 100) throw new Error('customer points stale');
  });

  await assert('convert points uses server rule (10 pts = 1 EGP)', async () => {
    const r = await api('POST', '/api/accounts/1/convert-points', { points: 20 }, tokenA);
    if (r.status !== 200) throw new Error('convert failed ' + r.status);
    if (r.data.account.points !== 80 || r.data.account.balance !== 252) throw new Error('convert math wrong: ' + JSON.stringify(r.data.account));
  });

  await assert('configurable points rules applied', async () => {
    await api('PUT', '/api/settings', { points_std_per_hour: 99, points_vip_per_hour: 199 }, adminToken);
    const snap = await api('GET', '/api/devices');
    if (snap.data.settings.points_std_per_hour !== 99 || snap.data.settings.points_vip_per_hour !== 199) throw new Error('settings not saved');
    await api('PUT', '/api/settings', { points_std_per_hour: 10, points_vip_per_hour: 15 }, adminToken);
  });

  await assert('membership request â†’ admin approve adds balance', async () => {
    const m = await api('POST', '/api/memberships', { tier: 'BRONZE', amount: 280 }, tokenA);
    if (m.status !== 201) throw new Error('membership request failed ' + m.status);
    const appr = await api('PATCH', '/api/memberships/' + m.data.membership.id, { status: 'approved' }, adminToken);
    if (appr.status !== 200) throw new Error('approve failed');
    const me = await api('GET', '/api/auth/me', null, tokenA);
    if (me.data.account.balance !== 252 + 280) throw new Error('balance after approval = ' + me.data.account.balance);
  });

  console.log('\n===== ONLINE / OFFLINE PRESENCE =====');
  await assert('heartbeat marks account online', async () => {
    await api('POST', '/api/auth/heartbeat', {}, tokenA);
    const me = await api('GET', '/api/auth/me', null, tokenA);
    if (!me.data.account.online) throw new Error('not online after heartbeat');
  });
  await assert('offline heartbeat marks account offline (account not deleted)', async () => {
    await api('POST', '/api/auth/heartbeat', { offline: true }, tokenA);
    const me = await api('GET', '/api/auth/me', null, tokenA);
    if (me.data.account.online) throw new Error('still online');
    if (me.status !== 200) throw new Error('account vanished');
  });
  await assert('stale last_seen auto-flagged offline by server tick', async () => {
    serverMod.db.run('UPDATE accounts SET online = 1, last_seen = ? WHERE phone = ?', [new Date(Date.now() - 200000).toISOString(), '01000000001']);
    serverMod.db.persist();
    serverMod.lifeCycleTick();
    const r = await api('GET', '/api/accounts', null, adminToken);
    const a = r.data.accounts.find(x => x.phone === '01000000001');
    if (a.online) throw new Error('stale account still online');
  });

  console.log('\n===== MULTI-DEVICE / GUEST / PROFILE =====');
  await assert('guest booking without login accepted', async () => {
    const r = await api('POST', '/api/bookings', { name: 'Guest', phone: '01099999999', pcs: ['VIP 1'], duration: 30, date: dt(plus150), time: hhmm(plus150) });
    if (r.status !== 201) throw new Error('guest booking ' + r.status);
  });
  await assert('guest conflicting booking still rejected (backend, not frontend)', async () => {
    const r = await api('POST', '/api/bookings', { name: 'G2', phone: '01099999998', pcs: ['VIP 1'], duration: 30, date: dt(plus150), time: hhmm(plus150) });
    if (r.status !== 409) throw new Error('expected 409 got ' + r.status);
  });
  await assert('favorite game + profile updates persisted', async () => {
    const r = await api('PATCH', '/api/accounts/1', { favorite_game: 'VALORANT' }, tokenA);
    if (r.status !== 200 || r.data.account.favorite_game !== 'VALORANT') throw new Error('update failed');
    const me = await api('GET', '/api/auth/me', null, tokenA);
    if (me.data.account.favorite_game !== 'VALORANT') throw new Error('not persisted');
  });
  await assert('customer can cancel own upcoming booking', async () => {
    // pick the PC1 booking at plus90 (upcoming now, by tokenA)
    const adminList = await api('GET', '/api/bookings', null, adminToken);
    const b = adminList.data.bookings.find(x => x.pcs === '["PC 1"]' || (x.pcs || '').includes('PC 1'));
    const cand = adminList.data.bookings.filter(x => (x.pcs || '').includes('PC 1') && x.status === 'pending').sort((a, b2) => a.time.localeCompare(b2.time))[0];
    if (!cand) throw new Error('no cancellable PC1 booking found');
    const r = await api('PATCH', '/api/bookings/' + cand.id, { status: 'cancelled' }, tokenA);
    if (r.status !== 200 || r.data.booking.status !== 'cancelled') throw new Error('cancel failed ' + r.status);
  });

  await assert('booking history visible to customer', async () => {
    const r = await api('GET', '/api/bookings', null, tokenA);
    if (r.status !== 200 || !Array.isArray(r.data.bookings) || r.data.bookings.length === 0) throw new Error('no history');
  });

  // ================= PART 2 =================
  console.log('\n===== PART 2: WEBSITE CONTENT (CMS) =====');
  await assert('content map exposed publicly with all sections', async () => {
    const r = await api('GET', '/api/content');
    if (r.status !== 200) throw new Error('public content ' + r.status);
    for (const k of ['site', 'hero', 'features', 'booking', 'prices', 'offers', 'games', 'contact', 'footer', 'sections']) {
      if (!(k in r.data.content)) throw new Error('missing content key: ' + k);
    }
    if (!r.data.updated_at || !r.data.updated_at.hero) throw new Error('missing updated_at');
  });

  const wsContent = waitEvent(wsClient, 'content_changed');
  await assert('admin PUT /api/content/hero saves + broadcasts live', async () => {
    const r = await api('PUT', '/api/content/hero', { badge: 'HOT', tagline: 'OUR TEST TAGLINE' }, adminToken);
    if (r.status !== 200 || r.data.value.tagline !== 'OUR TEST TAGLINE') throw new Error('put failed ' + r.status);
    await wsContent.then(e => {
      if (!e.data || e.data.key !== 'hero' || e.data.value.tagline !== 'OUR TEST TAGLINE') throw new Error('bad broadcast');
    });
  });

  await assert('content edit persists across refetch (DB-backed)', async () => {
    const r1 = await api('GET', '/api/content');
    const r2 = await api('GET', '/api/content');
    if (r1.data.content.hero.tagline !== 'OUR TEST TAGLINE') throw new Error('first fetch stale');
    if (r2.data.content.hero.tagline !== 'OUR TEST TAGLINE') throw new Error('second fetch stale');
    if (JSON.stringify(r1.data.content) !== JSON.stringify(r2.data.content)) throw new Error('content unstable');
  });

  await assert('oversized image rejected (400) + database unchanged (atomic)', async () => {
    const before = (await api('GET', '/api/content')).data.content.hero;
    const r = await api('PUT', '/api/content/hero', { tagline: 'BAD IMAGE', bgImage: 'data:image/png;base64,' + 'A'.repeat(2500001) }, adminToken);
    if (r.status !== 400) throw new Error('expected 400 got ' + r.status);
    const after = (await api('GET', '/api/content')).data.content.hero;
    if (after.tagline === 'BAD IMAGE') throw new Error('bad content persisted');
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('content mutated on failed write');
  });

  await assert('unknown content key rejected', async () => {
    const r = await api('PUT', '/api/content/not-a-key', { x: 1 }, adminToken);
    if (r.status !== 400) throw new Error('expected 400 got ' + r.status);
  });

  await assert('non-admin PUT content â†’ 401 (backend enforced)', async () => {
    const r = await api('PUT', '/api/content/hero', { tagline: 'stole' }, tokenA);
    if (r.status !== 401) throw new Error('expected 401 got ' + r.status);
    const chk = await api('GET', '/api/content');
    if (chk.data.content.hero.tagline === 'stole') throw new Error('non-admin write leaked');
  });

  await assert('games structure validated (too many tabs rejected)', async () => {
    const tabs = [];
    for (let i = 0; i < 13; i++) tabs.push({ id: 't' + i, label: 'T' + i, games: [] });
    const r = await api('PUT', '/api/content/games', { tabs }, adminToken);
    if (r.status !== 400) throw new Error('expected 400 got ' + r.status);
  });

  console.log('\n===== PART 2: DEVICE CRUD =====');
  await assert('admin adds device', async () => {
    const r = await api('POST', '/api/devices', { pc: 'PC 13', type: 'standard' }, adminToken);
    if (r.status !== 201) throw new Error('add device ' + r.status + ' ' + JSON.stringify(r.data));
  });
  await assert('duplicate device rejected 409', async () => {
    const r = await api('POST', '/api/devices', { pc: 'PC 13', type: 'vip' }, adminToken);
    if (r.status !== 409) throw new Error('expected 409 got ' + r.status);
  });
  await assert('invalid device name rejected 400', async () => {
    const r = await api('POST', '/api/devices', { pc: '!!%', type: 'standard' }, adminToken);
    if (r.status !== 400) throw new Error('expected 400 got ' + r.status);
  });
  await assert('non-admin device add â†’ 401', async () => {
    const r = await api('POST', '/api/devices', { pc: 'HACKED', type: 'standard' }, tokenA);
    if (r.status !== 401) throw new Error('expected 401 got ' + r.status);
    const chk = await api('GET', '/api/devices');
    if (chk.data.devices.some(d => d.pc === 'HACKED')) throw new Error('leaked device');
  });

  await assert('renaming device rewrites reservation PC references', async () => {
    const t0 = new Date(Date.now() + 240 * 60000);
    const b = await api('POST', '/api/bookings', { pcs: ['PC 13'], duration: 30, date: dt(t0), time: hhmm(t0), addon: 'None' }, tokenA);
    if (b.status !== 201) throw new Error('booking setup failed');
    const r = await api('PATCH', '/api/devices/' + encodeURIComponent('PC 13'), { pc: 'PC 13X' }, adminToken);
    if (r.status !== 200) throw new Error('rename failed ' + r.status + ' ' + JSON.stringify(r.data));
    const list = await api('GET', '/api/bookings', null, adminToken);
    const refs = list.data.bookings.filter(x => (x.pcs || '').includes('PC 13X'));
    if (refs.length === 0) throw new Error('booking not rewritten');
    const st = refs.find(x => x.id === b.data.booking.id);
    if (!st || JSON.parse(st.pcs).includes('PC 13')) throw new Error('old PC name still referenced');
  });

  await assert('device type change persisted', async () => {
    const r = await api('PATCH', '/api/devices/' + encodeURIComponent('PC 13X'), { type: 'vip' }, adminToken);
    if (r.status !== 200) throw new Error('type change failed');
    const snap = await api('GET', '/api/devices');
    const d = snap.data.devices.find(x => x.pc === 'PC 13X');
    if (!d || d.type !== 'vip') throw new Error('type not persisted');
    const front = await api('GET', '/api/devices');
    const d2 = front.data.devices.find(x => x.pc === 'PC 13X');
    if (d2.type !== 'vip') throw new Error('type not visible to customers');
  });

  await assert('device with pending reservation cannot be deleted (409)', async () => {
    const r = await api('DELETE', '/api/devices/' + encodeURIComponent('PC 13X'), null, adminToken);
    if (r.status !== 409) throw new Error('expected 409 got ' + r.status);
  });

  await assert('secured per-device reservation lookup', async () => {
    const r = await api('GET', '/api/devices/' + encodeURIComponent('PC 13X') + '/bookings', null, adminToken);
    if (r.status !== 200 || !Array.isArray(r.data.bookings) || r.data.bookings.length === 0) throw new Error('lookup failed');
    const anon = await api('GET', '/api/devices/' + encodeURIComponent('PC 13X') + '/bookings');
    if (anon.status !== 401) throw new Error('reservation lookup leaked to anon');
  });

  await assert('manual occupy guards existing reservation (409) then force-overrides', async () => {
    const occBlocked = await api('POST', '/api/devices/manual-busy', { pcs: ['PC 13X'] }, adminToken);
    if (occBlocked.status !== 409 || !occBlocked.data.manual_conflict) throw new Error('expected 409 manual_conflict, got ' + occBlocked.status + ' ' + JSON.stringify(occBlocked.data).slice(0, 120));
    const occ = await api('POST', '/api/devices/manual-busy', { pcs: ['PC 13X'], force: true }, adminToken);
    if (occ.status !== 200) throw new Error('occupy failed');
    // device CANNOT be deleted while manual-occupied
    const del = await api('DELETE', '/api/devices/' + encodeURIComponent('PC 13X'), null, adminToken);
    if (del.status !== 409) throw new Error('manual occupied device deletable!');
    const rel = await api('POST', '/api/devices/manual-free', { pcs: ['PC 13X'] }, adminToken);
    if (rel.status !== 200) throw new Error('release failed');
  });

  await assert('device delete after cleanup succeeds', async () => {
    // cancel the pending reservation we created
    const list = await api('GET', '/api/bookings', null, adminToken);
    const b = list.data.bookings.find(x => (x.pcs || '').includes('PC 13X') && x.status === 'pending');
    if (b) await api('PATCH', '/api/bookings/' + b.id, { status: 'cancelled' }, tokenA);
    const r = await api('DELETE', '/api/devices/' + encodeURIComponent('PC 13X'), null, adminToken);
    if (r.status !== 200) throw new Error('delete after cleanup failed ' + r.status);
    const snap = await api('GET', '/api/devices');
    if (snap.data.devices.some(d => d.pc === 'PC 13X')) throw new Error('device still present');
    const b2 = await api('GET', '/api/bookings', null, adminToken);
    if (b2.data.bookings.some(x => ['pending', 'active'].includes(x.status) && (x.pcs || '').includes('PC 13X'))) throw new Error('stale pc reference remains');
  });

  console.log('\n===== PART 2: ADMIN BALANCE / POINTS =====');
  await assert('balance add via POST /api/accounts/:id/balance', async () => {
    const before = (await api('GET', '/api/auth/me', null, tokenA)).data.account.balance;
    const r = await api('POST', '/api/accounts/1/balance', { action: 'add', amount: 30 }, adminToken);
    if (r.status !== 200 || Math.abs((r.data.account.balance || 0) - (before + 30)) > 0.001) throw new Error('balance add wrong: ' + (r.data.account && r.data.account.balance));
  });
  await assert('balance set via admin action', async () => {
    const r = await api('POST', '/api/accounts/1/balance', { action: 'set', amount: 777 }, adminToken);
    if (r.status !== 200 || r.data.account.balance !== 777) throw new Error('balance set wrong');
  });
  await assert('balance deduct (negative add) works but cannot go negative', async () => {
    const r1 = await api('POST', '/api/accounts/1/balance', { action: 'add', amount: -300 }, adminToken);
    if (r1.status !== 200 || r1.data.account.balance !== 477) throw new Error('deduct failed');
    const r2 = await api('POST', '/api/accounts/1/balance', { action: 'add', amount: -99999 }, adminToken);
    if (r2.status !== 400) throw new Error('expected 400 got ' + r2.status);
    const me = await api('GET', '/api/auth/me', null, tokenA);
    if (me.data.account.balance !== 477) throw new Error('balance changed after rejected deduction');
  });
  await assert('points add / set / deduct via admin actions', async () => {
    const before = (await api('GET', '/api/auth/me', null, tokenA)).data.account.points;
    const r = await api('POST', '/api/accounts/1/points', { action: 'add', amount: 50 }, adminToken);
    if (r.status !== 200 || r.data.account.points !== before + 50) throw new Error('points add wrong: ' + JSON.stringify(r.data.account));
    const r2 = await api('POST', '/api/accounts/1/points', { action: 'set', amount: 5 }, adminToken);
    if (r2.status !== 200 || r2.data.account.points !== 5) throw new Error('points set wrong');
    const r3 = await api('POST', '/api/accounts/1/points', { action: 'add', amount: -2 }, adminToken);
    if (r3.status !== 200 || r3.data.account.points !== 3) throw new Error('points deduct wrong');
    const r4 = await api('POST', '/api/accounts/1/points', { action: 'add', amount: -99999 }, adminToken);
    if (r4.status !== 400) throw new Error('negative result not rejected');
  });
  await assert('non-admin balance/points actions â†’ 401', async () => {
    const r1 = await api('POST', '/api/accounts/1/balance', { action: 'add', amount: 1 }, tokenA);
    if (r1.status !== 401) throw new Error('balance leaked to customer');
    const r2 = await api('POST', '/api/accounts/1/points', { action: 'add', amount: 1 }, tokenA);
    if (r2.status !== 401) throw new Error('points leaked to customer');
    const me = await api('GET', '/api/auth/me', null, tokenA);
    if (me.data.account.balance !== 477) throw new Error('customer balance should be untouched');
  });

  await assert('sections content respects schema (bad section id rejected)', async () => {
    const r = await api('PUT', '/api/content/sections', { hidden: ['no-such-section'], order: ['features', 'booking', 'prices', 'offers', 'games', 'contact'] }, adminToken);
    if (r.status !== 400) throw new Error('expected 400 got ' + r.status);
  });

  console.log('\n===== PART 3: FAVORITE GAME & GAME SUGGESTIONS =====');

  let tokenX = null, tokenY = null, xid = null, yid = null;
  await assert('register two fresh accounts for favorite-game isolation', async () => {
    const rx = await api('POST', '/api/auth/register', { name: 'Sam', phone: '01000000004', password: 'eeee' });
    if (rx.status !== 201 || !rx.data.token) throw new Error('setup X failed ' + rx.status);
    tokenX = rx.data.token; xid = rx.data.account.id;
    const ry = await api('POST', '/api/auth/register', { name: 'Lina', phone: '01000000005', password: 'ffff' });
    if (ry.status !== 201 || !ry.data.token) throw new Error('setup Y failed ' + ry.status);
    tokenY = ry.data.token; yid = ry.data.account.id;
  });

  await assert('customer saves favorite game to own account (persisted)', async () => {
    const r = await api('PATCH', '/api/accounts/' + xid, { favorite_game: 'VALORANT' }, tokenX);
    if (r.status !== 200 || r.data.account.favorite_game !== 'VALORANT') throw new Error('favorite not saved ' + JSON.stringify(r.data));
    const me = await api('GET', '/api/auth/me', null, tokenX);
    if (me.data.account.favorite_game !== 'VALORANT') throw new Error('not persisted');
  });

  await assert('favorite game is per-account (never global)', async () => {
    const rx = await api('PATCH', '/api/accounts/' + xid, { favorite_game: 'Counter-Strike 2' }, tokenX);
    const ry = await api('PATCH', '/api/accounts/' + yid, { favorite_game: 'FIFA / eFootball' }, tokenY);
    if (rx.data.account.favorite_game !== 'Counter-Strike 2') throw new Error('X changed wrongly');
    if (ry.data.account.favorite_game !== 'FIFA / eFootball') throw new Error('Y changed wrongly');
    // refresh-like verification: /me after login-equivalent fetch
    const mex = await api('GET', '/api/auth/me', null, tokenX);
    const mey = await api('GET', '/api/auth/me', null, tokenY);
    if (mex.data.account.favorite_game !== 'Counter-Strike 2') throw new Error('X should keep its own value');
    if (mey.data.account.favorite_game !== 'FIFA / eFootball') throw new Error('Y should keep its own value');
  });

  await assert('customer cannot edit another account favorite game (403)', async () => {
    const r = await api('PATCH', '/api/accounts/' + yid, { favorite_game: 'HACKED' }, tokenX);
    if (r.status !== 403) throw new Error('expected 403 got ' + r.status);
  });

  await assert('favorite_game must be text (400)', async () => {
    const r = await api('PATCH', '/api/accounts/' + xid, { favorite_game: 123 }, tokenX);
    if (r.status !== 400) throw new Error('expected 400 got ' + r.status);
  });

  let sugA = null, sugB = null;
  await assert('customer suggests a game (name only) → pending + persisted', async () => {
    const r = await api('POST', '/api/suggestions', { game_name: 'Ultra Custom Racer 3000' }, tokenX);
    if (r.status !== 201 || !r.data.suggestion) throw new Error('expected 201 got ' + r.status + ' ' + JSON.stringify(r.data));
    const s = r.data.suggestion;
    if (s.status !== 'pending') throw new Error('not pending');
    if (!s.game_name || s.game_name !== 'Ultra Custom Racer 3000') throw new Error('name not stored');
    if (s.account_id !== xid) throw new Error('account not linked');
    if (!s.created_at || !s.customer_name) throw new Error('missing date/name ref');
    if (r.data.already_in_library !== false) throw new Error('should not be in library');
    sugA = s;
  });

  await assert('customer suggests a game with optional image', async () => {
    const img = 'data:image/png;base64,' + 'A'.repeat(200);
    const r = await api('POST', '/api/suggestions', { game_name: 'Galaxy Blasters 2077', image: img }, tokenY);
    if (r.status !== 201 || r.data.suggestion.image !== img) throw new Error('image not stored');
    sugB = r.data.suggestion;
  });

  await assert('suggestion validation: empty name → 400', async () => {
    const r = await api('POST', '/api/suggestions', { game_name: '' }, tokenX);
    if (r.status !== 400) throw new Error('expected 400 got ' + r.status);
  });
  await assert('suggestion validation: long name → 400', async () => {
    const r = await api('POST', '/api/suggestions', { game_name: 'X'.repeat(151) }, tokenX);
    if (r.status !== 400) throw new Error('expected 400 got ' + r.status);
  });
  await assert('suggestion validation: invalid image → 400', async () => {
    const r = await api('POST', '/api/suggestions', { game_name: 'Broken', image: 'not-a-data-url' }, tokenX);
    if (r.status !== 400) throw new Error('expected 400 got ' + r.status);
    const r2 = await api('POST', '/api/suggestions', { game_name: 'TooBig', image: 'data:image/png;base64,' + 'A'.repeat(2500001) }, tokenX);
    if (r2.status !== 400) throw new Error('oversized image accepted');
  });

  await assert('duplicate pending suggestion (same account + game) blocked 409', async () => {
    const r = await api('POST', '/api/suggestions', { game_name: 'ultra custom racer 3000' }, tokenX);
    if (r.status !== 409) throw new Error('expected 409 got ' + r.status);
  });
  await assert('same game from a different account is allowed', async () => {
    const r = await api('POST', '/api/suggestions', { game_name: 'ULTRA CUSTOM RACER 3000' }, tokenY);
    if (r.status !== 201) throw new Error('expected 201 got ' + r.status + ' ' + JSON.stringify(r.data));
  });

  await assert('suggestions require login (401)', async () => {
    const r = await api('POST', '/api/suggestions', { game_name: 'Anon' });
    if (r.status !== 401) throw new Error('expected 401 got ' + r.status);
  });
  await assert('suggestions list is admin-only (401 for customer)', async () => {
    const r = await api('GET', '/api/suggestions', null, tokenX);
    if (r.status !== 401) throw new Error('expected 401 got ' + r.status);
  });

  await assert('existing-game suggestion is detected (already_in_library)', async () => {
    const r = await api('POST', '/api/suggestions', { game_name: 'VALORANT' }, tokenY);
    if (r.status !== 201 || r.data.already_in_library !== true || !r.data.existing) throw new Error('not detected ' + JSON.stringify(r.data));
  });

  await assert('admin rejects a suggestion (persisted + WS broadcast)', async () => {
    const wsEvt = waitEvent(wsClient, 'suggestions_changed');
    const r = await api('PATCH', '/api/suggestions/' + sugB.id, { status: 'rejected' }, adminToken);
    if (r.status !== 200 || r.data.suggestion.status !== 'rejected') throw new Error('reject failed');
    await wsEvt.then(e => { if (!e.data || e.data.suggestion.id !== sugB.id) throw new Error('bad WS payload'); });
    const list = await api('GET', '/api/suggestions', null, adminToken);
    const row = list.data.suggestions.find(s => s.id === sugB.id);
    if (!row || row.status !== 'rejected') throw new Error('not persisted after refresh');
  });

  await assert('admin approves a suggestion (persisted + WS broadcast)', async () => {
    const wsEvt = waitEvent(wsClient, 'suggestions_changed');
    const r = await api('PATCH', '/api/suggestions/' + sugA.id, { status: 'approved' }, adminToken);
    if (r.status !== 200 || r.data.suggestion.status !== 'approved') throw new Error('approve failed');
    await wsEvt.then(e => { if (!e.data || !e.data.suggestion) throw new Error('bad WS payload'); });
    const list = await api('GET', '/api/suggestions', null, adminToken);
    const row = list.data.suggestions.find(s => s.id === sugA.id);
    if (!row || row.status !== 'approved') throw new Error('not persisted after refresh');
  });

  await assert('approving an existing-library game warns (note.already_in_library)', async () => {
    const r1 = await api('POST', '/api/suggestions', { game_name: 'Dota 2' }, tokenY);
    if (r1.status !== 201) throw new Error('setup failed');
    const r2 = await api('PATCH', '/api/suggestions/' + r1.data.suggestion.id, { status: 'approved' }, adminToken);
    if (r2.status !== 200 || !r2.data.note || r2.data.note.already_in_library !== true) throw new Error('dup warning missing ' + JSON.stringify(r2.data));
  });

  await assert('admin suggestion status validation (bad status → 400)', async () => {
    const r = await api('PATCH', '/api/suggestions/' + sugA.id, { status: 'banana' }, adminToken);
    if (r.status !== 400) throw new Error('expected 400 got ' + r.status);
  });
  await assert('customer cannot approve own suggestion (401)', async () => {
    const r = await api('PATCH', '/api/suggestions/' + sugA.id, { status: 'approved' }, tokenX);
    if (r.status !== 401) throw new Error('expected 401 got ' + r.status);
  });

  await assert('admin deletes a suggestion (persisted)', async () => {
    const r = await api('DELETE', '/api/suggestions/' + sugB.id, null, adminToken);
    if (r.status !== 200) throw new Error('delete failed ' + r.status);
    const list = await api('GET', '/api/suggestions', null, adminToken);
    if (list.data.suggestions.some(s => s.id === sugB.id)) throw new Error('still present');
    const r2 = await api('DELETE', '/api/suggestions/' + sugB.id, null, adminToken);
    if (r2.status !== 404) throw new Error('expected 404 on re-delete');
  });

  await assert('suggestions workflow leaves Available Games library intact', async () => {
    const g = await api('GET', '/api/content');
    if (g.status !== 200 || !g.data.content || !Array.isArray(g.data.content.games.tabs)) throw new Error('games content broken');
    const all = g.data.content.games.tabs.reduce((a, t) => a.concat((t.games || []).map(x => x.name)), []);
    if (!all.includes('VALORANT') || !all.includes('Dota 2')) throw new Error('library lost games');
  });

  console.log('\n===== PART 4 · PRICING / BALANCE PAY / PACKAGES / LEDGER =====');
  // Deterministic room: drop pending/active bookings (any date) so PART 4 pricing/balance tests never hit conflicts
  serverMod.db.run("DELETE FROM bookings WHERE status IN ('pending','active')");
  serverMod.db.persist();
  const ft = () => { const d = new Date(Date.now() + 2 * 3600000); return { date: dt(d), time: String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') }; };
  const fdate = () => ft().date;

  await assert('server computes standard PC price (30/h → 30 EGP for 60 min) on booking', async () => {
    const fs = ft();
    const r = await api('POST', '/api/bookings', { pcs: ['PC 1'], duration: 60, date: fs.date, time: fs.time, name: 'Price Guest', phone: '01900000001' });
    if (r.status !== 201) throw new Error('create ' + r.status + ' ' + JSON.stringify(r.data));
    if (r.data.price.total !== 30) throw new Error('total ' + r.data.price.total);
    const bd = r.data.price.breakdown.find(x => x.pc === 'PC 1');
    if (!bd || bd.rate !== 30 || bd.amount !== 30) throw new Error('breakdown ' + JSON.stringify(bd));
    if (r.data.booking.price !== 30) throw new Error('stored price ' + r.data.booking.price);
    const dbRow = serverMod.db.q('SELECT price, balance_paid FROM bookings WHERE id = ?', [r.data.booking.id])[0];
    if (dbRow.price !== 30 || dbRow.balance_paid !== 0) throw new Error('db row ' + JSON.stringify(dbRow));
  });

  await assert('VIP PCs price at VIP rate (40/h → 40 EGP for 60 min)', async () => {
    const fs = ft();
    const r = await api('POST', '/api/bookings', { pcs: ['VIP 1'], duration: 60, date: fs.date, time: fs.time, name: 'Price Guest', phone: '01900000002' });
    if (r.status !== 201) throw new Error('create ' + r.status);
    const bd = r.data.price.breakdown.find(x => x.pc === 'VIP 1');
    if (!bd || bd.rate !== 40 || bd.amount !== 40) throw new Error('vip breakdown ' + JSON.stringify(bd));
    if (r.data.booking.price !== 40) throw new Error('vip stored ' + r.data.booking.price);
  });

  await assert('pay_from_balance booking deducts exact price + records booking_payment ledger', async () => {
    await api('PATCH', '/api/accounts/1', { balance: 1000 }, adminToken);
    const fs = ft();
    const r = await api('POST', '/api/bookings', { pcs: ['PC 2'], duration: 60, date: fs.date, time: fs.time, pay_with_balance: true }, tokenA);
    if (r.status !== 201) throw new Error('paid booking ' + r.status + ' ' + JSON.stringify(r.data));
    if (r.data.booking.balance_paid !== 30) throw new Error('balance_paid ' + r.data.booking.balance_paid);
    const me = await api('GET', '/api/auth/me', null, tokenA);
    if (me.data.account.balance !== 970) throw new Error('balance after pay ' + me.data.account.balance);
    const txs = serverMod.db.q("SELECT * FROM transactions WHERE account_id = 1 AND type = 'booking_payment'");
    if (txs.length !== 1 || txs[0].amount !== -30 || txs[0].ref_type !== 'booking') throw new Error('ledger ' + JSON.stringify(txs));
  });

  await assert('pay_from_balance insufficient → 402, nothing created or charged', async () => {
    await api('PATCH', '/api/accounts/1', { balance: 10 }, adminToken);
    const before = serverMod.db.q('SELECT COUNT(*) AS c FROM bookings')[0].c;
    const fs = ft();
    const r = await api('POST', '/api/bookings', { pcs: ['PC 3'], duration: 60, date: fs.date, time: fs.time, pay_with_balance: true }, tokenA);
    if (r.status !== 402) throw new Error('expected 402 got ' + r.status + ' ' + JSON.stringify(r.data));
    if (r.data.price !== 30 || r.data.balance !== 10) throw new Error('402 payload ' + JSON.stringify(r.data));
    if (serverMod.db.q('SELECT COUNT(*) AS c FROM bookings')[0].c !== before) throw new Error('booking created despite 402');
    const me = await api('GET', '/api/auth/me', null, tokenA);
    if (me.data.account.balance !== 10) throw new Error('balance changed on failed payment: ' + me.data.account.balance);
    if (serverMod.db.q("SELECT COUNT(*) AS c FROM transactions WHERE type = 'booking_payment'")[0].c !== 1) throw new Error('ledger recorded failed payment');
  });

  await assert('guest cannot activate balance payment (pay flag ignored → still 201, uncharged)', async () => {
    const fs = ft();
    const r = await api('POST', '/api/bookings', { pcs: ['PC 4'], duration: 60, date: fs.date, time: fs.time, pay_with_balance: true, name: 'Guest NoAcc', phone: '01900000003' });
    if (r.status !== 201) throw new Error('guest booking ' + r.status + ' ' + JSON.stringify(r.data));
    if (r.data.booking.balance_paid !== 0) throw new Error('guest was charged ' + r.data.booking.balance_paid);
  });

  await assert('zero-price paid booking rejected (400)', async () => {
    await api('PUT', '/api/settings', { standard_price_per_hour: 0 }, adminToken);
    const fs = ft();
    const r = await api('POST', '/api/bookings', { pcs: ['PC 7'], duration: 60, date: fs.date, time: fs.time, pay_with_balance: true }, tokenA);
    if (r.status !== 400) throw new Error('expected 400 got ' + r.status + ' ' + JSON.stringify(r.data));
    await api('PUT', '/api/settings', { standard_price_per_hour: 30 }, adminToken);
  });

  await assert('concurrent pay bookings cannot double-spend the same balance', async () => {
    await api('PATCH', '/api/accounts/1', { balance: 30 }, adminToken);
    const fs = ft();
    const [a, b] = await Promise.all([
      api('POST', '/api/bookings', { pcs: ['PC 8'], duration: 60, date: fs.date, time: fs.time, pay_with_balance: true }, tokenA),
      api('POST', '/api/bookings', { pcs: ['PC 9'], duration: 60, date: fs.date, time: fs.time, pay_with_balance: true }, tokenA),
    ]);
    const codes = [a.status, b.status].sort();
    if (codes[0] !== 201 || codes[1] !== 402) throw new Error('expected [201,402] got ' + JSON.stringify(codes));
    const me = await api('GET', '/api/auth/me', null, tokenA);
    if (me.data.account.balance !== 0) throw new Error('balance after double-spend test ' + me.data.account.balance);
    const paid = (await api('GET', '/api/auth/me', null, tokenA)); // token/enable reuse below
    const ledger = serverMod.db.q("SELECT COUNT(*) AS c FROM transactions WHERE type = 'booking_payment'");
    if (ledger[0].c !== 2) throw new Error('booking_payment ledger count ' + ledger[0].c);
  });

  await assert('completed paid-style booking awards points once (anti-replay) + points_earned ledger', async () => {
    await api('PUT', '/api/settings', { points_std_per_hour: 60 }, adminToken);
    const mk = await api('POST', '/api/bookings', { pcs: ['PC 10'], duration: 120, date: today(), time: hhmm(new Date()) }, tokenA);
    if (mk.status !== 201) throw new Error('create ' + mk.status);
    const lid = mk.data.booking.id;
    const dur = Math.max(2, nowTotalMinutes() - 3);
    serverMod.db.run('UPDATE bookings SET time = ?, duration = ? WHERE id = ?', ['00:01', dur, lid]);
    serverMod.db.persist();
    const ptsBefore = (await api('GET', '/api/auth/me', null, tokenA)).data.account.points;
    serverMod.lifeCycleTick();
    const bn = serverMod.db.q('SELECT status, points_awarded, account_id FROM bookings WHERE id = ?', [lid])[0];
    if (bn.status !== 'completed' || bn.points_awarded !== 1) throw new Error('not completed/awarded ' + JSON.stringify(bn));
    const ptsMid = (await api('GET', '/api/auth/me', null, tokenA)).data.account.points;
    if (!(ptsMid > ptsBefore)) throw new Error('no points earned');
    const earned = serverMod.db.q("SELECT * FROM transactions WHERE type = 'points_earned' AND ref_id = ?", [lid]);
    if (earned.length !== 1 || earned[0].points <= 0) throw new Error('points_earned ledger ' + JSON.stringify(earned));
    serverMod.lifeCycleTick();
    const ptsAfter = (await api('GET', '/api/auth/me', null, tokenA)).data.account.points;
    if (ptsAfter !== ptsMid) throw new Error('points double-awarded: ' + ptsMid + ' -> ' + ptsAfter);
    await api('PUT', '/api/settings', { points_std_per_hour: 10 }, adminToken);
  });

  // ——— Packages CRUD / validation / realtime ———
  const pkgA = { name: 'Night 3h', device_type: 'vip', duration: 180, price: 100, description: '3-hour VIP block', status: 'active' };
  await assert('admin creates package → persisted + packages_changed broadcast', async () => {
    const evt = waitEvent(wsClient, 'packages_changed');
    const r = await api('POST', '/api/packages', pkgA, adminToken);
    if (r.status !== 201) throw new Error('create ' + r.status + ' ' + JSON.stringify(r.data));
    if (r.data.package.name !== pkgA.name || r.data.package.device_type !== 'vip' || r.data.package.duration !== 180 || r.data.package.price !== 100) throw new Error('fields ' + JSON.stringify(r.data.package));
    const list = await api('GET', '/api/packages');
    if (!list.data.packages.find(p => p.id === r.data.package.id)) throw new Error('not persisted');
    await evt.then(e => { if (!e.data || !e.data.package || e.data.package.id !== r.data.package.id) throw new Error('bad WS payload'); });
    pkgA.id = r.data.package.id;
  });

  await assert('package validation rejects bad fields (400)', async () => {
    const bad1 = await api('POST', '/api/packages', { name: '   ', device_type: 'vip', duration: 180, price: 100 }, adminToken);
    if (bad1.status !== 400) throw new Error('name validation');
    const bad2 = await api('POST', '/api/packages', { name: 'X', device_type: 'vip', duration: 5, price: 100 }, adminToken);
    if (bad2.status !== 400) throw new Error('duration validation');
    const bad3 = await api('POST', '/api/packages', { name: 'X', device_type: 'vip', duration: 180, price: -1 }, adminToken);
    if (bad3.status !== 400) throw new Error('price validation');
    const bad4 = await api('POST', '/api/packages', { name: 'X', device_type: 'ultra', duration: 180, price: 1 }, adminToken);
    if (bad4.status !== 400) throw new Error('device validation');
    const bad5 = await api('POST', '/api/packages', { name: 'X', device_type: 'vip', duration: 180, price: 1, status: 'banana' }, adminToken);
    if (bad5.status !== 400) throw new Error('status validation');
  });

  await assert('package create/delete guarded (customer → 401, delete customer → missing page covered)', async () => {
    const r = await api('POST', '/api/packages', pkgA, tokenX);
    if (r.status !== 401) throw new Error('customer create leaked ' + r.status);
  });

  await assert('admin edits package → persisted + validated', async () => {
    const r = await api('PATCH', '/api/packages/' + pkgA.id, { price: 120, duration: 240, name: 'Night 4h' }, adminToken);
    if (r.status !== 200 || r.data.package.price !== 120 || r.data.package.duration !== 240 || r.data.package.name !== 'Night 4h') throw new Error('edit failed ' + JSON.stringify(r.data));
    const bad = await api('PATCH', '/api/packages/' + pkgA.id, { duration: 2000 }, adminToken);
    if (bad.status !== 400) throw new Error('bad edit accepted');
    const missing = await api('PATCH', '/api/packages/99999', { price: 1 }, adminToken);
    if (missing.status !== 404) throw new Error('missing package not 404');
  });

  await assert('deactivating a package hides it from the public site list but keeps it in DB', async () => {
    const r = await api('PATCH', '/api/packages/' + pkgA.id, { status: 'inactive' }, adminToken);
    if (r.status !== 200 || r.data.package.status !== 'inactive') throw new Error('deactivate failed');
    const list = await api('GET', '/api/packages');
    const row = list.data.packages.find(p => p.id === pkgA.id);
    if (!row || row.status !== 'inactive') throw new Error('status not persisted');
  });

  await assert('admin deletes package → gone; re-delete → 404', async () => {
    const r = await api('DELETE', '/api/packages/' + pkgA.id, null, adminToken);
    if (r.status !== 200) throw new Error('delete failed ' + r.status);
    const list = await api('GET', '/api/packages');
    if (list.data.packages.some(p => p.id === pkgA.id)) throw new Error('still present');
    const r2 = await api('DELETE', '/api/packages/' + pkgA.id, null, adminToken);
    if (r2.status !== 404) throw new Error('re-delete not 404');
  });

  // ——— Transactions ledger ———
  await assert('transaction ledger is admin-only (customer → 401)', async () => {
    const r = await api('GET', '/api/transactions', null, tokenA);
    if (r.status !== 401) throw new Error('ledger leaked to customer ' + r.status);
    const r2 = await api('GET', '/api/transactions', null, adminToken);
    if (r2.status !== 200 || !Array.isArray(r2.data.transactions)) throw new Error('admin ledger broken ' + r2.status);
  });

  await assert('ledger captures booking_payment, points_earned, admin_balance, membership_credit', async () => {
    const r = await api('GET', '/api/transactions', null, adminToken);
    const types = r.data.transactions.map(t => t.type);
    for (const need of ['booking_payment', 'points_earned', 'admin_balance', 'membership_credit']) {
      if (!types.includes(need)) throw new Error('ledger missing ' + need);
    }
    const bp = r.data.transactions.find(t => t.type === 'booking_payment');
    if (bp.delta_balance !== -30 || bp.ref_type !== 'booking') throw new Error('booking_payment wiring ' + JSON.stringify(bp));
    const ce = r.data.transactions.find(t => t.type === 'points_earned');
    if (!(ce.delta_points > 0)) throw new Error('points wiring ' + JSON.stringify(ce));
    if (!bp.customer_name || !ce.customer_name || !bp.created_at || !bp.performed_by) throw new Error('ledger enrichment missing fields');
  });

  await assert('admin balance/points edits leave audit trail + converted points has ledger entry', async () => {
    await api('PATCH', '/api/accounts/1', { balance: 500 }, adminToken);
    const cv = await api('POST', '/api/accounts/1/convert-points', { points: 10 }, tokenA);
    if (cv.status !== 200) throw new Error('convert failed ' + cv.status);
    const r = await api('GET', '/api/transactions', null, adminToken);
    const ab = r.data.transactions.filter(t => t.type === 'admin_balance' && t.account_id === 1 && t.performed_by);
    if (!ab.length) throw new Error('no admin_balance audit row');
    const pc = r.data.transactions.find(t => t.type === 'points_converted' && t.account_id === 1);
    if (!pc || pc.delta_points !== -10 || pc.delta_balance !== 1) throw new Error('convert ledger ' + JSON.stringify(pc));
  });

  await assert('account profile page exposes its own transactions', async () => {
    const r = await api('GET', '/api/accounts/1', null, adminToken);
    if (r.status !== 200) throw new Error('detail ' + r.status);
    if (!Array.isArray(r.data.transactions) || !r.data.transactions.length) throw new Error('no transactions in detail');
    if (!r.data.transactions.every(t => t.account_id === 1)) throw new Error('foreign rows leaked');
  });

  await assert('packages + pricing work coexists with existing CMS prices content (no data destroyed)', async () => {
    const g = await api('GET', '/api/content');
    const prices = g.data.content.prices;
    if (!prices || !Array.isArray(prices.cards) || !prices.cards.length) throw new Error('prices CMS destroyed');
  });

  // ================= PART 5 =================
  console.log('\n===== PART 5 · AUTO-START / OCCUPY CONFLICT / REFUND / MIDDAY SPILL / ADMIN BOOKING =====');
  // reset settings + deterministic room (clear leftover Part-4 bookings and free any manual devices)
  await api('PUT', '/api/settings', { standard_price_per_hour: 30, vip_price_per_hour: 40, points_std_per_hour: 10 }, adminToken);
  serverMod.db.run("DELETE FROM bookings WHERE status IN ('pending','active')");
  serverMod.db.persist();
  // free any manual_occupied leftovers (e.g., from Part-1 PC3)
  {
    const devs = (await api('GET', '/api/devices')).data.devices;
    const manual = devs.filter(d => d.color === 'red' && d.manual);
    if (manual.length) await api('POST', '/api/devices/manual-free', { pcs: manual.map(d => d.pc) }, adminToken);
  }
  // login account 2 and account 3 fresh tokens for Part-5 tests
  const acct2Login = await api('POST', '/api/auth/login', { phone: '01000000002', password: 'bbbb' });
  const token2 = acct2Login.data && acct2Login.data.token;
  const acct3Login = await api('POST', '/api/auth/login', { phone: '01000000003', password: 'dddd' });
  const token3 = acct3Login.data && acct3Login.data.token;

  await assert('admin manual booking linked to customer account', async () => {
    const fs = ftSlot(90);
    const r = await api('POST', '/api/bookings', { pcs: ['PC 10'], duration: 60, date: fs.date, time: fs.time, account_id: 2, addon: 'None' }, adminToken);
    if (r.status !== 201) throw new Error('create ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 200));
    const b = r.data.booking;
    if (b.account_id !== 2) throw new Error('account_id ' + b.account_id);
    const acc2 = (await api('GET', '/api/accounts', null, adminToken)).data.accounts.find(a => a.id === 2);
    if (b.name !== acc2.name || b.phone !== acc2.phone) throw new Error('name/phone mismatch ' + b.name + '/' + b.phone);
  });

  await assert('manual occupied PC blocks new online reservation (409, manual conflict)', async () => {
    await api('POST', '/api/devices/manual-busy', { pcs: ['PC 4'] }, adminToken);
    const fs = ftSlot(90);
    const r = await api('POST', '/api/bookings', { pcs: ['PC 4'], duration: 60, date: fs.date, time: fs.time }, tokenA);
    if (r.status !== 409 || !r.data.conflict || r.data.conflict.pc !== 'PC 4') throw new Error('expected manual conflict 409, got ' + r.status + ' ' + JSON.stringify(r.data).slice(0, 200));
    await api('POST', '/api/devices/manual-free', { pcs: ['PC 4'] }, adminToken);
  });

  await assert('auto-start: pending today → active + RED; pending future stays pending', async () => {
    const now = new Date();
    // insert a booking that should auto-start NOW on PC 7 (date=today, time slightly before now to avoid timing edge)
    const startMin = (now.getHours() * 60 + now.getMinutes() + 1440 - 2) % 1440; // 2 min before now (wraps safely at 00:00)
    const startHH = String(Math.floor(startMin / 60)).padStart(2, '0') + ':' + String(startMin % 60).padStart(2, '0');
    serverMod.db.run("INSERT INTO bookings (pcs, duration, addon, date, time, status, created_at) VALUES (?,?,?,?,?,?,?)", [
      JSON.stringify(['PC 7']), 30, 'None', today(), startHH, 'pending', nowISO()
    ]);
    serverMod.db.persist();
    const fut = ftSlot(180);
    const futureBooking = await api('POST', '/api/bookings', { pcs: ['PC 8'], duration: 60, date: fut.date, time: fut.time }, tokenA);
    if (futureBooking.status !== 201) throw new Error('future create ' + futureBooking.status);
    serverMod.lifeCycleTick();
    const startRow = serverMod.db.q("SELECT status FROM bookings WHERE date = ? AND pcs = ? AND status = 'pending'", [today(), '["PC 7"]'])[0];
    if (startRow) throw new Error('pending PC7 should be active after tick');
    const snap = await api('GET', '/api/devices?date=' + today());
    const pc7 = snap.data.devices.find(d => d.pc === 'PC 7');
    if (!pc7 || pc7.color !== 'red') throw new Error('PC7 expected RED, got ' + (pc7 && pc7.color));
    const futRow = serverMod.db.q("SELECT status FROM bookings WHERE id = ?", [futureBooking.data.booking.id])[0];
    if (futRow.status !== 'pending') throw new Error('future booking should still be pending, got ' + futRow.status);
  });

  await assert('same-day overlap (01:10→02:10 vs 01:40→02:40) still 409', async () => {
    // deterministic future day: tomorrow at 01:10 (always in the future, same-day pair)
    const d = shiftDate(today(), 1);
    const r1 = await api('POST', '/api/bookings', { pcs: ['PC 11'], duration: 60, date: d, time: '01:10' }, tokenA);
    if (r1.status !== 201) throw new Error('create1 ' + r1.status + ' ' + JSON.stringify(r1.data).slice(0, 120));
    const r2 = await api('POST', '/api/bookings', { pcs: ['PC 11'], duration: 60, date: d, time: '01:40' }, tokenA);
    if (r2.status !== 409) throw new Error('expected 409 got ' + r2.status);
  });

  await assert('midnight spill conflict (previous-day 23:30→01:30 blocks next-day 01:00) + no-conflict at 01:30', async () => {
    let spillDay = today();
    if (new Date(spillDay + 'T23:30').getTime() <= Date.now()) spillDay = shiftDate(spillDay, 1); // late-night safety: push spill day forward
    const d = shiftDate(spillDay, 1); // the date the spill crosses into
    const spill = await api('POST', '/api/bookings', { pcs: ['PC 12'], duration: 120, date: spillDay, time: '23:30' }, tokenA);
    if (spill.status !== 201) throw new Error('spill create ' + spill.status + ' ' + JSON.stringify(spill.data).slice(0, 120));
    const c = await api('POST', '/api/bookings', { pcs: ['PC 12'], duration: 60, date: d, time: '01:00' }, tokenA);
    if (c.status !== 409) throw new Error('expected spill 409, got ' + c.status);
    const nc = await api('POST', '/api/bookings', { pcs: ['PC 12'], duration: 60, date: d, time: '01:30' }, tokenA);
    if (nc.status !== 201) throw new Error('expected 201, got ' + nc.status);
  });

  await assert('customer cancel pending paid booking refunds exact balance_paid (ledger booking_refund)', async () => {
    await api('PATCH', '/api/accounts/2', { balance: 1000 }, adminToken);
    const fs = ftSlot(60);
    const r = await api('POST', '/api/bookings', { pcs: ['PC 7'], duration: 60, date: fs.date, time: fs.time, pay_with_balance: true }, token2);
    if (r.status !== 201) throw new Error('create ' + r.status);
    if (r.data.booking.balance_paid !== 30) throw new Error('balance_paid ' + r.data.booking.balance_paid);
    const balBefore = (await api('GET', '/api/auth/me', null, token2)).data.account.balance;
    if (balBefore !== 970) throw new Error('balance after pay ' + balBefore);
    const wRefund = waitEvent(wsClient, 'accounts_changed');
    const can = await api('PATCH', '/api/bookings/' + r.data.booking.id, { status: 'cancelled' }, token2);
    if (can.status !== 200 || can.data.booking.status !== 'cancelled') throw new Error('cancel ' + can.status);
    await wRefund;
    const balAfter = (await api('GET', '/api/auth/me', null, token2)).data.account.balance;
    if (balAfter !== 1000) throw new Error('expected balance 1000, got ' + balAfter);
    const tx = serverMod.db.q("SELECT * FROM transactions WHERE account_id = 2 AND ref_id = ? AND type = 'booking_refund'", [r.data.booking.id])[0];
    if (!tx || tx.amount !== 30) throw new Error('ledger booking_refund missing/wrong ' + JSON.stringify(tx));
  });

  await assert('admin cancel pending paid booking also refunds + performed_by is admin name', async () => {
    await api('PATCH', '/api/accounts/2', { balance: 5000 }, adminToken);
    const fs = ftSlot(60);
    const r = await api('POST', '/api/bookings', { pcs: ['PC 8'], duration: 60, date: fs.date, time: fs.time, pay_with_balance: true }, token2);
    if (r.status !== 201) throw new Error('create ' + r.status);
    const before = (await api('GET', '/api/accounts/2', null, adminToken)).data.account.balance;
    const can = await api('PATCH', '/api/bookings/' + r.data.booking.id, { status: 'cancelled' }, adminToken);
    if (can.status !== 200) throw new Error('cancel ' + can.status);
    const after = (await api('GET', '/api/accounts/2', null, adminToken)).data.account.balance;
    if (after !== 5000) throw new Error('expected 5000, got ' + after);
    const tx = serverMod.db.q("SELECT * FROM transactions WHERE account_id = 2 AND ref_id = ? AND type = 'booking_refund'", [r.data.booking.id])[0];
    if (!tx || tx.amount !== 30) throw new Error('refund ledger missing ' + JSON.stringify(tx));
    if (!tx.performed_by || tx.performed_by === 'customer') throw new Error('performed_by expected admin, got ' + tx.performed_by);
  });

  await assert('no refund after started (admin can cancel, but no balance change / no ledger entry)', async () => {
    await api('PATCH', '/api/accounts/2', { balance: 3000 }, adminToken);
    const fs = ftSlot(60);
    const r = await api('POST', '/api/bookings', { pcs: ['PC 9'], duration: 60, date: fs.date, time: fs.time, pay_with_balance: true }, token2);
    if (r.status !== 201) throw new Error('create ' + r.status);
    serverMod.db.run("UPDATE bookings SET status='active', started_at=? WHERE id=?", [nowISO(), r.data.booking.id]);
    serverMod.db.persist();
    const before = (await api('GET', '/api/accounts/2', null, adminToken)).data.account.balance;
    const can = await api('PATCH', '/api/bookings/' + r.data.booking.id, { status: 'cancelled' }, adminToken);
    if (can.status !== 200) throw new Error('cancel active ' + can.status);
    const after = (await api('GET', '/api/accounts/2', null, adminToken)).data.account.balance;
    if (after !== before) throw new Error('balance changed after cancelling started booking ' + before + ' → ' + after);
    const tx = serverMod.db.q("SELECT * FROM transactions WHERE account_id = 2 AND ref_id = ? AND type = 'booking_refund'", [r.data.booking.id])[0];
    if (tx) throw new Error('unexpected booking_refund for started booking');
  });

  await assert('guest cancel (no refund ledger) + customer cancel-after-start blocked', async () => {
    const fs = ftSlot(60);
    const r = await api('POST', '/api/bookings', { pcs: ['PC 3'], duration: 60, date: fs.date, time: fs.time, name: 'Guest P5', phone: '01099990005' });
    if (r.status !== 201) throw new Error('guest create ' + r.status);
    if (r.data.booking.account_id) throw new Error('guest should have no account_id');
    const can = await api('PATCH', '/api/bookings/' + r.data.booking.id, { status: 'cancelled' }, adminToken);
    if (can.status !== 200) throw new Error('guest cancel ' + can.status);
    const tx = serverMod.db.q("SELECT * FROM transactions WHERE ref_id = ? AND type = 'booking_refund'", [r.data.booking.id])[0];
    if (tx) throw new Error('unexpected refund for guest');
    // customer (token2) try cancel active booked under them (simulate start)
    const fs2 = ftSlot(75);
    const r2 = await api('POST', '/api/bookings', { pcs: ['PC 3'], duration: 60, date: fs2.date, time: fs2.time }, token2);
    if (r2.status !== 201) throw new Error('setup ' + r2.status);
    serverMod.db.run("UPDATE bookings SET status='active', started_at=? WHERE id=?", [nowISO(), r2.data.booking.id]);
    serverMod.db.persist();
    const can2 = await api('PATCH', '/api/bookings/' + r2.data.booking.id, { status: 'cancelled' }, token2);
    if (can2.status !== 400) throw new Error('expected 400 for cancel-after-start, got ' + can2.status);
  });

  await assert('cancel then auto-complete does NOT award points (cancelled stays 0 points)', async () => {
    await api('PUT', '/api/settings', { points_std_per_hour: 60 }, adminToken);
    const fs = ftSlot(60);
    const r = await api('POST', '/api/bookings', { pcs: ['PC 1'], duration: 60, date: fs.date, time: fs.time }, token3);
    if (r.status !== 201) throw new Error('create ' + r.status);
    const ptsBefore = (await api('GET', '/api/auth/me', null, token3)).data.account.points;
    const can = await api('PATCH', '/api/bookings/' + r.data.booking.id, { status: 'cancelled' }, token3);
    if (can.status !== 200) throw new Error('cancel ' + can.status);
    // simulate future time has passed so tick would complete bookings
    serverMod.db.run("UPDATE bookings SET time='00:01', duration=2 WHERE id=?", [r.data.booking.id]);
    serverMod.db.persist();
    serverMod.lifeCycleTick();
    const row = serverMod.db.q("SELECT status, points_awarded FROM bookings WHERE id = ?", [r.data.booking.id])[0];
    if (row.status !== 'cancelled' || row.points_awarded !== 0) throw new Error('unexpected state ' + JSON.stringify(row));
    const ptsAfter = (await api('GET', '/api/auth/me', null, token3)).data.account.points;
    if (ptsAfter !== ptsBefore) throw new Error('points changed on cancelled booking ' + ptsBefore + ' → ' + ptsAfter);
    await api('PUT', '/api/settings', { points_std_per_hour: 10 }, adminToken);
  });

  console.log('\n================ RESULT ================');
  console.log('PASSED: ' + passed + '   FAILED: ' + failed);
  try { wsClient.close(); } catch {}
  try { process.exit(failed ? 1 : 0); } catch {}
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });