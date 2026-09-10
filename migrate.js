/* =============================
   Optional migration from the old JSONBlob cloud storage.
   Runs once when the DB has no accounts yet.
   ============================= */
const OLD_URLS = {
  bookings: 'https://jsonblob.com/api/jsonBlob/019fdd52-a5bd-788d-b159-260684da9139',
  accounts: 'https://jsonblob.com/api/jsonBlob/019fdd52-a432-7877-8214-8a6611e9300e',
  memberships: 'https://jsonblob.com/api/jsonBlob/019fdd52-a72b-7522-b8a8-3a6461ec70a3',
};

function parseDur(d) {
  const n = parseInt(d, 10);
  if (!isNaN(n) && n > 0) return n;
  if (String(d).includes('1 Hour')) return 60;
  if (String(d).includes('2')) return 120;
  if (String(d).includes('3')) return 180;
  if (String(d).includes('Unlimited')) return 1440;
  if (String(d).toLowerCase().includes('open')) return 0;
  return 60;
}

async function maybeMigrate(dbMod) {
  const db = dbMod;
  const count = db.q('SELECT COUNT(*) AS c FROM accounts')[0].c;
  if (count > 0) return; // already has data
  const results = await Promise.all(Object.keys(OLD_URLS).map(async key => {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 6000);
      const res = await fetch(OLD_URLS[key], { signal: ctl.signal, headers: { Accept: 'application/json' } });
      clearTimeout(t);
      if (!res.ok) return [key, []];
      const data = await res.json();
      return [key, Array.isArray(data) ? data : []];
    } catch { return [key, []]; }
  }));
  const data = {};
  for (const [k, v] of results) data[k] = v;
  if (!data.accounts.length) return;

  db.txn(() => {
    const idMap = {};
    const seenPhones = new Set();
    for (const old of data.accounts) {
      const phone = String(old.phone || '').trim();
      if (!phone || seenPhones.has(phone)) continue;
      seenPhones.add(phone);
      idMap[old.id] = db.run('INSERT INTO accounts (id, name, username, phone, password, avatar, favorite_game, balance, points, last_seen, last_login, created_at, online) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
        old.id,
        String(old.name || ''),
        old.username ? String(old.username) : null,
        phone,
        dbMod.hashPw(old.password || '1234'),
        String(old.avatar || ''),
        String(old.favorite_game || ''),
        parseFloat(old.balance) || 0,
        parseInt(old.points, 10) || 0,
        old.last_seen ? String(old.last_seen) : '',
        old.last_login ? String(old.last_login) : '',
        old.created_at ? String(old.created_at) : new Date().toISOString(),
        old.online ? 1 : 0
      ]);
    }
    const maxA = Object.keys(idMap).reduce((m, k) => Math.max(m, parseInt(k, 10) || 0), 0);
    db.setSeq('accounts', maxA);

    let mId = 0;
    for (const old of data.bookings || []) {
      const pcs = Array.isArray(old.pcs) ? old.pcs : (function () {
        try { const p = JSON.parse(old.pcs); return Array.isArray(p) ? p : []; } catch { return []; }
      })();
      const manual = !parseDur(old.duration);
      const phone = String(old.phone || '');
      const accId = Object.keys(idMap).find(k => data.accounts.find(a => a.id === parseInt(k, 10) && String(a.phone) === phone)) ? idMap[Object.keys(idMap).find(k => data.accounts.find(a => a.id === parseInt(k, 10) && String(a.phone) === phone))] : null;
      mId = db.run('INSERT INTO bookings (id, account_id, name, phone, pcs, duration, addon, date, time, status, manual, created_at, started_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [
        old.id,
        accId,
        String(old.name || ''),
        phone || 'N/A',
        JSON.stringify(pcs),
        parseDur(old.duration),
        String(old.addon || 'None'),
        String(old.date || ''),
        String(old.time || '00:00'),
        ['pending', 'active', 'completed', 'cancelled'].includes(old.status) ? old.status : 'pending',
        manual ? 1 : old.manual ? 1 : 0,
        old.created_at ? String(old.created_at) : new Date().toISOString(),
        manual ? String(old.created_at || new Date().toISOString()) : ''
      ]);
    }
    const mb = data.bookings || [];
    const maxB = mb.length ? Math.max(...mb.map(x => parseInt(x.id, 10) || 0)) : 0;
    db.setSeq('bookings', Math.max(maxB, mId));

    let memId = 0;
    for (const old of data.memberships || []) {
      const oldAcc = data.accounts.find(a => a.id === old.account_id);
      const newId = oldAcc ? idMap[oldAcc.id] : null;
      memId = db.run('INSERT INTO memberships (id, account_id, tier, amount, status, created_at) VALUES (?,?,?,?,?,?)', [
        old.id,
        newId,
        String(old.tier || ''),
        parseFloat(old.amount) || 0,
        ['pending', 'approved', 'rejected'].includes(old.status) ? old.status : 'pending',
        old.created_at ? String(old.created_at) : new Date().toISOString()
      ]);
    }
    const mm = data.memberships || [];
    const maxM = mm.length ? Math.max(...mm.map(x => parseInt(x.id, 10) || 0)) : 0;
    db.setSeq('memberships', Math.max(maxM, memId));
  });

  console.log('Migrated ' + data.accounts.length + ' accounts, ' + (data.bookings || []).length + ' bookings, ' + (data.memberships || []).length + ' memberships from old JSONBlob storage.');
}

module.exports = { maybeMigrate };