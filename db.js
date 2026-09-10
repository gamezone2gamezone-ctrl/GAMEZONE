/* =============================
   GAME ZONE – SQLite persistence
   sql.js (WASM) + atomic file writes
   ============================= */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const initSqlJs = require('sql.js');

const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'data', 'cafe.db');

let db = null;

const DEFAULT_PCS = [
  { pc: 'PC 1', type: 'standard' },
  { pc: 'PC 2', type: 'standard' },
  { pc: 'PC 3', type: 'standard' },
  { pc: 'PC 4', type: 'standard' },
  { pc: 'PC 7', type: 'standard' },
  { pc: 'PC 8', type: 'standard' },
  { pc: 'PC 9', type: 'standard' },
  { pc: 'PC 10', type: 'standard' },
  { pc: 'PC 11', type: 'standard' },
  { pc: 'PC 12', type: 'standard' },
  { pc: 'VIP 1', type: 'vip' },
  { pc: 'VIP 2', type: 'vip' },
];

const DEFAULT_SETTINGS = {
  points_std_per_hour: '10',
  points_vip_per_hour: '15',
  points_per_egp: '10',
  standard_price_per_hour: '30',
  vip_price_per_hour: '40',
  deposit: '50',
  admin_user: 'MEDO',
  admin_pass: '123456',
};

// ===== Website content (CMS) defaults =====
// These mirror the original static site exactly, so a fresh DB keeps the design.
const DEFAULT_CONTENT = {
  site: {
    title: 'GAME ZONE GAMING – Best Gaming Cyber Cafe',
    name: 'GAME ZONE',
    sub: 'G A M I N G',
    icon: '⬡',
    navBrand: 'GZG',
    footerName: 'GAME ZONE GAMING',
    logoImage: '',
  },
  hero: {
    tagline: 'Best Gaming Cyber Cafe · Level Up Your Experience',
    bgImage: '',
    btnBook: { label: 'BOOK A PC NOW', href: '#booking', visible: true },
    btnLogin: { label: '👤 LOGIN', visible: true },
    stats: [
      { num: '12+', label: 'Gaming PCs' },
      { num: '50+', label: 'Games' },
      { num: '24/7', label: 'Open' },
    ],
  },
  features: {
    label: 'WHY CHOOSE US',
    titleBefore: 'Built for',
    titleGlow: 'Champions',
    cards: [
      { icon: '🖥️', title: 'Powerful Gaming PCs', desc: 'RTX 4080 · Intel i9 · 32GB RAM · 240Hz monitors for the smoothest gameplay.' },
      { icon: '🎮', title: 'Latest Games', desc: '50+ titles — online, offline story, LAN, and simulation. Always updated.' },
      { icon: '🏆', title: 'Tournaments & Events', desc: 'Weekly competitions with prizes. Join the community and prove your skills.' },
    ],
  },
  booking: {
    label: 'RESERVE YOUR SPOT',
    titleBefore: 'Book a',
    titleGlow: 'PC',
    depositTitle: 'Deposit Required',
    depositText: '{deposit} EGP to confirm your booking',
    submit: '⚡ CONFIRM BOOKING',
  },
  prices: {
    label: 'TRANSPARENT PRICING',
    titleBefore: 'Our',
    titleGlow: 'Rates',
    cards: [
      { variant: 'standard', icon: '🖥️', title: 'Standard PC', rows: [{ label: '30 Minutes', price: 15, suffix: 'EGP', featured: false }, { label: '1 Hour', price: 30, suffix: 'EGP', featured: true }] },
      { variant: 'vip', icon: '💎', title: 'VIP PC', crown: '👑 VIP', rows: [{ label: '30 Minutes', price: 20, suffix: 'EGP', featured: false }, { label: '1 Hour', price: 40, suffix: 'EGP', featured: true }] },
      { variant: 'addons', icon: '🎡', title: 'Add-ons', rows: [{ label: 'Steering Wheel', price: 50, suffix: 'EGP', prefix: '+', featured: false }, { label: 'VIP Steering Wheel', price: 60, suffix: 'EGP', prefix: '+', featured: false }] },
    ],
  },
  offers: {
    label: 'EXCLUSIVE DEALS',
    titleBefore: 'Membership',
    titleGlow: 'Offers',
    cards: [
      { tier: 'BRONZE', badge: 'BRONZE', amount: '250', amountSuffix: 'EGP', desc: 'Load 250 EGP membership', bonusLabel: 'FREE BONUS', bonus: '+30 EGP', total: '280', btn: 'GET THIS DEAL', amountData: 280 },
      { tier: 'SILVER', badge: 'SILVER ⭐', amount: '500', amountSuffix: 'EGP', desc: 'Load 500 EGP membership', bonusLabel: 'FREE BONUS', bonus: '+90 EGP', total: '590', btn: 'GET THIS DEAL', amountData: 590 },
      { tier: 'GOLD', badge: 'GOLD ⭐', amount: '1,000', amountSuffix: 'EGP', desc: 'Load 1,000 EGP membership', bonusLabel: 'FREE BONUS', bonus: '+240 EGP', total: '1,240', btn: 'GET THIS DEAL', amountData: 1240 },
      { tier: 'DIAMOND', badge: 'DIAMOND 💎', amount: '2,000', amountSuffix: 'EGP', desc: 'Load 2,000 EGP membership', bonusLabel: 'FREE BONUS', bonus: '+600 EGP', total: '2,600', btn: 'GET THIS DEAL', amountData: 2600 },
    ],
  },
  games: {
    label: 'OUR LIBRARY',
    titleBefore: 'Available',
    titleGlow: 'Games',
    tabs: [
      { id: 'online', icon: '🌐', label: 'Online', games: [
        { icon: '⚔️', name: 'Marvel Rivals', image: '' }, { icon: '🔫', name: 'PUBG MOBILE', image: '' },
        { icon: '🪖', name: 'Call of Duty', image: '' }, { icon: '🚗', name: 'Rocket League', image: '' },
        { icon: '🎯', name: 'VALORANT', image: '' }, { icon: '🦅', name: 'Apex Legends', image: '' },
        { icon: '🔫', name: 'Rainbow Six Siege', image: '' }, { icon: '🔥', name: 'Free Fire', image: '' },
        { icon: '🦸', name: 'Overwatch 2', image: '' }, { icon: '🫘', name: 'Fall Guys', image: '' },
        { icon: '🏆', name: 'League of Legends', image: '' }, { icon: '💥', name: 'Counter-Strike 2', image: '' },
        { icon: '🤼', name: 'Brawlhalla', image: '' }, { icon: '🌀', name: 'Fortnite', image: '' },
        { icon: '🐉', name: 'Dota 2', image: '' },
      ] },
      { id: 'offline', icon: '📖', label: 'Story', games: [
        { icon: '⚔️', name: 'Ghost of Tsushima', image: '' }, { icon: '⚡', name: 'God of War', image: '' },
        { icon: '🕷️', name: 'Spider-Man 2', image: '' }, { icon: '🕷️', name: 'Spider-Man Remastered', image: '' },
        { icon: '🕷️', name: 'Miles Morales', image: '' }, { icon: '🤖', name: 'Detroit: Become Human', image: '' },
        { icon: '🧟', name: 'The Last of Us Part I', image: '' }, { icon: '🗡️', name: "Assassin's Creed Mirage", image: '' },
        { icon: '🗡️', name: "Assassin's Creed Valhalla", image: '' }, { icon: '🗡️', name: "Assassin's Creed Odyssey", image: '' },
        { icon: '🌴', name: 'Far Cry 3', image: '' }, { icon: '🌴', name: 'Far Cry 4', image: '' },
        { icon: '🌴', name: 'Far Cry 5', image: '' }, { icon: '🌴', name: 'Far Cry 6', image: '' },
        { icon: '🗡️', name: 'Sekiro: Shadows Die Twice', image: '' }, { icon: '👻', name: 'The Mortuary Assistant', image: '' },
        { icon: '🎯', name: 'Hitman 3', image: '' }, { icon: '🔫', name: 'Mafia II', image: '' },
        { icon: '🧟', name: 'Resident Evil 7 / 4 Remake', image: '' }, { icon: '🧟', name: 'Resident Evil Village', image: '' },
        { icon: '🏴‍☠️', name: 'Uncharted 4', image: '' }, { icon: '🌆', name: 'GTA San Andreas', image: '' },
        { icon: '🌆', name: 'GTA Vice City', image: '' }, { icon: '🌆', name: 'GTA V', image: '' },
        { icon: '🔍', name: 'Watch Dogs', image: '' }, { icon: '🔍', name: 'Watch Dogs 2', image: '' },
        { icon: '🏚️', name: 'Outlast', image: '' }, { icon: '🏚️', name: 'Outlast 2', image: '' },
        { icon: '👵', name: 'Granny 1', image: '' }, { icon: '👵', name: 'Granny 2', image: '' },
        { icon: '👵', name: 'Granny 3', image: '' }, { icon: '🤠', name: 'Red Dead Redemption 2', image: '' },
        { icon: '🧸', name: 'Poppy Playtime', image: '' }, { icon: '🤼', name: 'WWE 2K', image: '' },
        { icon: '⚔️', name: 'TABS', image: '' }, { icon: '🐺', name: 'The Witcher 3: Wild Hunt', image: '' },
        { icon: '👻', name: 'Visage', image: '' }, { icon: '💣', name: 'Battlefield V', image: '' },
        { icon: '🧟', name: 'Dying Light', image: '' }, { icon: '🗡️', name: 'Elden Ring', image: '' },
        { icon: '⚔️', name: 'Devil May Cry 5', image: '' }, { icon: '🧙', name: 'Hogwarts Legacy', image: '' },
        { icon: '🦇', name: 'LEGO Batman', image: '' },
      ] },
      { id: 'lan', icon: '🔗', label: 'LAN', games: [
        { icon: '💣', name: 'Counter-Strike 1.6', image: '' }, { icon: '🏎️', name: 'Blur', image: '' },
        { icon: '🪖', name: 'Call of Duty: Black Ops II', image: '' }, { icon: '🚀', name: 'Among Us', image: '' },
        { icon: '⚔️', name: 'Stick Fight: The Game', image: '' }, { icon: '🐔', name: 'Gang Beasts', image: '' },
        { icon: '👻', name: 'Phasmophobia', image: '' }, { icon: '⛏️', name: 'Minecraft', image: '' },
      ] },
      { id: 'sim', icon: '🚗', label: 'Simulation', games: [
        { icon: '🏁', name: 'Assetto Corsa', image: '' }, { icon: '🏎️', name: 'Forza Horizon', image: '' },
        { icon: '🚗', name: 'Need for Speed', image: '' },
      ] },
    ],
  },
  contact: {
    label: 'GET IN TOUCH',
    titleBefore: 'Find',
    titleGlow: 'Us',
    items: [
      { type: 'link', icon: '📞', title: 'Phone / WhatsApp', value: '01055886624', href: 'tel:01055886624' },
      { type: 'link', icon: '📸', title: 'Instagram', value: '@_game__zone___', href: 'https://instagram.com/_game__zone___' },
      { type: 'link', icon: '🎵', title: 'TikTok', value: '@game_zone385', href: 'https://tiktok.com/@game_zone385' },
      { type: 'plain', icon: '🕐', title: 'Working Hours', value: 'Open 24/7 — Every Day' },
    ],
    map: { url: 'https://maps.app.goo.gl/gUco5M9C8Nh6hTPf7?g_st=ac', image: '' },
  },
  footer: {
    text: 'Best Gaming Cyber Cafe · Level Up Your Experience',
    links: [
      { label: 'Home', href: '#home' }, { label: 'Booking', href: '#booking' }, { label: 'Prices', href: '#prices' },
      { label: 'Games', href: '#games' }, { label: 'Contact', href: '#contact' },
    ],
    copy: '© 2025 Game Zone Gaming. All rights reserved.',
  },
  sections: { hidden: [], order: ['features', 'booking', 'prices', 'offers', 'games', 'contact'] },
  new_features: {
    features: [
      { id: 'events', name: 'Events & Tournaments Manager', desc: 'Schedule tournaments, prizes and event registrations.', icon: '🏆', enabled: false },
      { id: 'loyalty', name: 'Loyalty Rewards', desc: 'Customizable loyalty tiers and rewards for regular customers.', icon: '⭐', enabled: false },
      { id: 'notices', name: 'Announcements Bar', desc: 'Show a scrolling announcement bar above the site.', icon: '📢', enabled: false },
    ],
  },
};

function hashPw(pw) {
  const salt = crypto.randomBytes(8).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return salt + ':' + h;
}
function verifyPw(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const hh = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hh));
  } catch { return false; }
}

function q(sql, params) {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params || []);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    return rows;
  } finally { stmt.free(); }
}

function run(sql, params) {
  db.run(sql, params || []);
  const r = db.exec('SELECT last_insert_rowid() AS id');
  return r.length ? r[0].values[0][0] : null;
}

function persist() {
  const data = db.export();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, Buffer.from(data));
  fs.renameSync(tmp, DB_FILE);
}

// run several sync mutations then persist once
function txn(fn) {
  const res = fn();
  persist();
  return res;
}

function getSettings() {
  const rows = q('SELECT key, value FROM settings');
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (s[k] === undefined) s[k] = DEFAULT_SETTINGS[k];
  return s;
}
function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(value)]);
}

function numSetting(key) {
  const n = parseFloat(getSettings()[key]);
  return isNaN(n) ? 0 : n;
}

function getDevices() {
  return q('SELECT * FROM devices ORDER BY rowid');
}

function deviceTypeOf(pc) {
  const row = q('SELECT type FROM devices WHERE pc = ?', [pc])[0];
  return row ? row.type : 'standard';
}

function setSeq(table, maxId) {
  run('DELETE FROM sqlite_sequence WHERE name = ?', [table]);
  if (maxId > 0) run('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)', [table, maxId]);
}

function getContentMap() {
  const rows = q('SELECT key, value, updated_at FROM site_content');
  const out = { _updated_at: {} };
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = DEFAULT_CONTENT[r.key] ? JSON.parse(JSON.stringify(DEFAULT_CONTENT[r.key])) : null; }
    out._updated_at[r.key] = r.updated_at;
  }
  // merge fallback defaults for any missing content keys
  for (const k of Object.keys(DEFAULT_CONTENT)) {
    if (out[k] == null) out[k] = JSON.parse(JSON.stringify(DEFAULT_CONTENT[k]));
  }
  return out;
}

function getContent(key) {
  const map = getContentMap();
  return map[key] != null ? map[key] : (DEFAULT_CONTENT[key] ? JSON.parse(JSON.stringify(DEFAULT_CONTENT[key])) : null);
}

function setContent(key, value) {
  run('INSERT INTO site_content (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [key, JSON.stringify(value), new Date().toISOString()]);
}

function ensureColumn(table, col, ddl) {
  const rows = q('PRAGMA table_info(' + table + ')');
  if (!rows.some(r => r.name === col)) run('ALTER TABLE ' + table + ' ADD COLUMN ' + ddl);
}

function addTransaction(t) {
  const now = new Date().toISOString();
  return run('INSERT INTO transactions (account_id, type, amount, points, ref_type, ref_id, reason, performed_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)', [
    t.account_id || 0,
    t.type || '',
    typeof t.amount === 'number' ? t.amount : 0,
    typeof t.points === 'number' ? t.points : 0,
    String(t.ref_type || ''),
    parseInt(t.ref_id, 10) || 0,
    String(t.reason || ''),
    String(t.performed_by || 'system'),
    now,
  ]);
}

function getTransactions(accountId) {
  const where = accountId ? 'WHERE account_id = ?' : '';
  const params = accountId ? [accountId] : [];
  return q('SELECT * FROM transactions ' + where + ' ORDER BY id DESC', params);
}

async function init() {
  const SQL = await initSqlJs();
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const buf = fs.existsSync(DB_FILE) ? fs.readFileSync(DB_FILE) : null;
  db = (buf && buf.length) ? new SQL.Database(buf) : new SQL.Database();
  db.run('PRAGMA foreign_keys=ON;');

  db.run(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      username TEXT,
      phone TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '',
      favorite_game TEXT NOT NULL DEFAULT '',
      balance REAL NOT NULL DEFAULT 0,
      points INTEGER NOT NULL DEFAULT 0,
      last_seen TEXT NOT NULL DEFAULT '',
      last_login TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      online INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username);
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      account_id INTEGER,
      role TEXT NOT NULL DEFAULT 'customer',
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER,
      name TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      pcs TEXT NOT NULL DEFAULT '[]',
      duration INTEGER NOT NULL DEFAULT 60,
      addon TEXT NOT NULL DEFAULT 'None',
      date TEXT NOT NULL DEFAULT '',
      time TEXT NOT NULL DEFAULT '00:00',
      status TEXT NOT NULL DEFAULT 'pending',
      manual INTEGER NOT NULL DEFAULT 0,
      points_awarded INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      ended_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_bookings_date_pcs ON bookings(date, status);
    CREATE TABLE IF NOT EXISTS memberships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER,
      tier TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS devices (
      pc TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'standard',
      status TEXT NOT NULL DEFAULT 'available',
      manual_name TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS site_content (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS game_suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      customer_name TEXT NOT NULL DEFAULT '',
      customer_phone TEXT NOT NULL DEFAULT '',
      game_name TEXT NOT NULL,
      image TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      device_type TEXT NOT NULL DEFAULT 'standard',
      duration INTEGER NOT NULL DEFAULT 60,
      price REAL NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT '',
      amount REAL NOT NULL DEFAULT 0,
      points INTEGER NOT NULL DEFAULT 0,
      ref_type TEXT NOT NULL DEFAULT '',
      ref_id INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT '',
      performed_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_account ON transactions(account_id);
    CREATE INDEX IF NOT EXISTS idx_transactions_created ON transactions(created_at);
  `);

  // migrate older databases: bookings gain server-side pricing columns
  ensureColumn('bookings', 'price', 'price REAL NOT NULL DEFAULT 0');
  ensureColumn('bookings', 'balance_paid', 'balance_paid REAL NOT NULL DEFAULT 0');

  // seed CMS content only when the table is completely empty (fresh install)
  const contentRows = q('SELECT COUNT(*) AS c FROM site_content')[0].c;
  if (contentRows === 0) {
    for (const k of Object.keys(DEFAULT_CONTENT)) {
      run('INSERT INTO site_content (key, value, updated_at) VALUES (?, ?, ?)', [k, JSON.stringify(DEFAULT_CONTENT[k]), new Date().toISOString()]);
    }
  }

  const freshlyCreated = q('SELECT COUNT(*) AS c FROM devices')[0].c === 0;
  if (freshlyCreated) {
    for (const d of DEFAULT_PCS) {
      run('INSERT OR IGNORE INTO devices (pc, type, status, updated_at) VALUES (?, ?, ?, ?)', [d.pc, d.type, 'available', new Date().toISOString()]);
    }
    for (const k of Object.keys(DEFAULT_SETTINGS)) setSetting(k, DEFAULT_SETTINGS[k]);
    persist();
  } else {
    // ensure every configured settings key exists
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      const exists = q('SELECT value FROM settings WHERE key = ?', [k])[0];
      if (!exists) setSetting(k, DEFAULT_SETTINGS[k]);
    }
    // ensure default devices exist
    for (const d of DEFAULT_PCS) {
      const exists = q('SELECT pc FROM devices WHERE pc = ?', [d.pc])[0];
      if (!exists) run('INSERT INTO devices (pc, type, status, updated_at) VALUES (?, ?, ?, ?)', [d.pc, d.type, 'available', new Date().toISOString()]);
    }
  }
  persist();
  return db;
}

module.exports = { init, q, run, txn, persist, getSettings, setSetting, numSetting, getDevices, deviceTypeOf, hashPw, verifyPw, setSeq, getContentMap, getContent, setContent, addTransaction, getTransactions, ensureColumn, DEFAULT_SETTINGS, DEFAULT_CONTENT, DEFAULT_PCS, DB_FILE };