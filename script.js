/* ===========================
   GAME ZONE GAMING – script.js
=========================== */

// ===== SHARED CLOUD STORAGE (JSONBlob) with localStorage cache =====
const CLOUD_URL = 'https://jsonblob.com/api/jsonBlob/019fdd45-7049-7eb2-a93d-dfde16bbd723';
const STORE_KEYS = ['bookings', 'accounts', 'memberships'];

function _lsGet(key) {
  try { return JSON.parse(localStorage.getItem('gzg_' + key)) || []; } catch { return []; }
}
function _lsSet(key, data) {
  localStorage.setItem('gzg_' + key, JSON.stringify(data));
}

let _store = null;
let _deleted = {};
let _dirty = false;
let _saveChain = Promise.resolve();
let _refreshPromise = null;
let _lastRefreshTime = 0;

async function _loadStore() {
  if (_store) return _store;
  _store = {
    bookings: _lsGet('bookings'),
    accounts: _lsGet('accounts'),
    memberships: _lsGet('memberships'),
  };
  _deleted = { bookings: [], accounts: [], memberships: [] };
  _refreshStore();
  return _store;
}

function _mergeById(localArr, serverArr) {
  const map = new Map();
  for (const it of (serverArr || [])) map.set(it.id, it);
  for (const it of (localArr || [])) map.set(it.id, it);
  return Array.from(map.values());
}

function _refreshStore() {
  if (!_store || _dirty) return Promise.resolve();
  if (_refreshPromise) return _refreshPromise;
  const now = Date.now();
  if (now - _lastRefreshTime < 2000) return Promise.resolve();
  _lastRefreshTime = now;
  _refreshPromise = (async () => {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch(CLOUD_URL, { signal: ctl.signal, headers: { 'Accept': 'application/json' } });
      clearTimeout(timer);
      const data = await res.json();
      if (!_dirty && data && typeof data === 'object') {
        _store.bookings = data.bookings || [];
        _store.accounts = data.accounts || [];
        _store.memberships = data.memberships || [];
        _lsSet('bookings', _store.bookings);
        _lsSet('accounts', _store.accounts);
        _lsSet('memberships', _store.memberships);
      }
    } catch {}
  })();
  _refreshPromise.finally(() => { _refreshPromise = null; });
  return _refreshPromise;
}

function _saveStore() {
  if (!_store) return Promise.resolve();
  _dirty = true;
  _lsSet('bookings', _store.bookings);
  _lsSet('accounts', _store.accounts);
  _lsSet('memberships', _store.memberships);
  _saveChain = _saveChain.then(async () => {
    try {
      let server = null;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 4000);
        const res = await fetch(CLOUD_URL, { signal: ctl.signal, headers: { 'Accept': 'application/json' } });
        clearTimeout(timer);
        server = await res.json();
      } catch {}
      if (server && typeof server === 'object') {
        for (const key of STORE_KEYS) {
          const serverArr = (server[key] || []).filter(it => !(_deleted[key] || []).includes(it.id));
          _store[key] = _mergeById(_store[key], serverArr);
        }
      }
      for (const key of STORE_KEYS) {
        _deleted[key] = (_deleted[key] || []).filter(id => !_store[key].some(it => it.id === id));
      }
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 4000);
      await fetch(CLOUD_URL, { method: 'PUT', signal: ctl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(_store) });
      clearTimeout(timer);
      _lsSet('bookings', _store.bookings);
      _lsSet('accounts', _store.accounts);
      _lsSet('memberships', _store.memberships);
    } catch {}
  });
  _saveChain = _saveChain.finally(() => { _dirty = false; });
  return _saveChain;
}

let _lastBookings = [];
async function getBookings() {
  await _loadStore();
  await _refreshStore();
  _lastBookings = _store.bookings;
  return _lastBookings;
}
let _lastAccounts = [];
async function getAccounts() {
  await _loadStore();
  await _refreshStore();
  _lastAccounts = _store.accounts;
  return _lastAccounts;
}
async function getAccountByPhone(phone) {
  await _loadStore();
  await _refreshStore();
  return _store.accounts.find(a => a.phone === phone) || null;
}
async function getMemberships() {
  await _loadStore();
  await _refreshStore();
  return _store.memberships;
}
function jitter() { return Math.random() * 3000; }

async function postBooking(d) {
  await _loadStore();
  _store.bookings.push(d);
  await _saveStore();
  return d;
}
async function patchBooking(id, d) {
  await _loadStore();
  const idx = _store.bookings.findIndex(x => x.id === id);
  if (idx !== -1) { Object.assign(_store.bookings[idx], d); await _saveStore(); return _store.bookings[idx]; }
  return null;
}
async function deleteBookingSupabase(id) {
  await _loadStore();
  _store.bookings = _store.bookings.filter(x => x.id !== id);
  _deleted.bookings.push(id);
  await _saveStore();
}
async function postAccount(d) {
  await _loadStore();
  _store.accounts.push(d);
  await _saveStore();
  return d;
}
async function patchAccount(id, d) {
  await _loadStore();
  const idx = _store.accounts.findIndex(x => x.id === id);
  if (idx !== -1) { Object.assign(_store.accounts[idx], d); await _saveStore(); return _store.accounts[idx]; }
  return null;
}
async function deleteAccountSupabase(id) {
  await _loadStore();
  _store.accounts = _store.accounts.filter(x => x.id !== id);
  _deleted.accounts.push(id);
  await _saveStore();
}

// ===== AUTH HELPERS =====

// ===== CURSOR =====
const cursor = document.getElementById('cursor');
const trail  = document.getElementById('cursorTrail');

if (cursor && trail) {
  let rafId;
  document.addEventListener('mousemove', e => {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      cursor.style.left = e.clientX + 'px';
      cursor.style.top  = e.clientY + 'px';
    });
    setTimeout(() => {
      trail.style.left = e.clientX + 'px';
      trail.style.top  = e.clientY + 'px';
    }, 80);
  });

  document.querySelectorAll('a, button, .game-card, .feature-card, .price-card, .offer-card').forEach(el => {
    el.addEventListener('mouseenter', () => {
      cursor.style.transform = 'translate(-50%,-50%) scale(1.8)';
      trail.style.transform  = 'translate(-50%,-50%) scale(1.4)';
    });
    el.addEventListener('mouseleave', () => {
      cursor.style.transform = 'translate(-50%,-50%) scale(1)';
      trail.style.transform  = 'translate(-50%,-50%) scale(1)';
    });
  });
}

// ===== PARTICLES CANVAS =====
const canvas = document.getElementById('particles');
const ctx    = canvas ? canvas.getContext('2d') : null;

if (canvas && ctx) {
  let W = window.innerWidth, H = window.innerHeight;
  canvas.width = W; canvas.height = H;

  window.addEventListener('resize', () => {
    W = canvas.width  = window.innerWidth;
    H = canvas.height = window.innerHeight;
  });

  const COLORS = ['#6a00ff', '#ff003c', '#c084fc', '#ff4d6d'];
  const particles = Array.from({ length: 40 }, () => ({
    x: Math.random() * W,
    y: Math.random() * H,
    r: Math.random() * 1.5 + 0.3,
    dx: (Math.random() - 0.5) * 0.4,
    dy: -Math.random() * 0.5 - 0.1,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    alpha: Math.random() * 0.6 + 0.2,
  }));

  let particlesRAF;
  function drawParticles() {
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.alpha;
      ctx.fill();
      p.x += p.dx; p.y += p.dy;
      if (p.y < -5) { p.y = H + 5; p.x = Math.random() * W; }
      if (p.x < -5 || p.x > W + 5) p.dx *= -1;
    }
    ctx.globalAlpha = 1;
    particlesRAF = requestAnimationFrame(drawParticles);
  }
  drawParticles();
  // pause particles when page hidden
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(particlesRAF); }
    else { drawParticles(); }
  });
}

// ===== NAVBAR SCROLL EFFECT =====
const navbar = document.getElementById('navbar');
let scrollRAF;
window.addEventListener('scroll', () => {
  cancelAnimationFrame(scrollRAF);
  scrollRAF = requestAnimationFrame(() => {
    if (navbar) {
      navbar.style.boxShadow = window.scrollY > 10
        ? '0 4px 40px rgba(106,0,255,0.25)'
        : '';
    }
  });
}, { passive: true });

// ===== MOBILE NAV =====
const navToggle = document.getElementById('navToggle');
const navMobile = document.getElementById('navMobile');

if (navToggle && navMobile) {
  navToggle.addEventListener('click', () => {
    navMobile.classList.toggle('open');
    navToggle.textContent = navMobile.classList.contains('open') ? '✕' : '☰';
  });

  navMobile.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => {
      navMobile.classList.remove('open');
      navToggle.textContent = '☰';
    });
  });
}

// ===== REVEAL ON SCROLL =====
const reveals = document.querySelectorAll('.reveal');
const revealObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });

reveals.forEach(el => revealObserver.observe(el));

// ===== GAME TABS =====
const tabBtns    = document.querySelectorAll('.tab-btn');
const tabPanels  = document.querySelectorAll('.tab-content');

tabBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    tabBtns.forEach(b => b.classList.remove('active'));
    tabPanels.forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const target = document.getElementById('tab-' + btn.dataset.tab);
    if (target) target.classList.add('active');
  });
});

// ===== AUTO-FILL DATE & TIME =====
function autofillDateTime() {
  const dateInput = document.querySelector('[type="date"]');
  const timeInput = document.getElementById('bookingTime');
  if (!timeInput) return;
  const now = new Date();
  if (dateInput && !dateInput.value) dateInput.value = now.toISOString().split('T')[0];
  if (!timeInput.dataset.userChanged) {
    timeInput.value = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  }
}
autofillDateTime();
// live clock — update time every 30s, but only if user hasn't touched it
const bt = document.getElementById('bookingTime');
if (bt) {
  bt.addEventListener('focus', () => { bt.dataset.userChanged = '1'; });
  // live time label
  const lbl = document.getElementById('liveTimeLabel');
  function updateClockLabel() {
    if (!lbl) return;
    const now = new Date();
    lbl.textContent = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  }
  updateClockLabel();
  setInterval(updateClockLabel, 30000);
}
setInterval(autofillDateTime, 30000);

// ===== CONFLICT CHECK (live, uses cached bookings) =====
function timeToMin(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}
function minToTime(m) {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}
function durMin(d) {
  const n = parseInt(d, 10);
  if (!isNaN(n) && n > 0) return n;
  if (d.includes('1 Hour')) return 60;
  if (d.includes('2')) return 120;
  if (d.includes('3')) return 180;
  if (d.includes('Unlimited')) return 1440;
  return 60;
}

function checkConflicts(selectedPCs, time, date, duration) {
  const bookings = _lastBookings || [];
  const start = timeToMin(time);
  const end = start + durMin(duration);
  const results = [];
  for (const b of bookings) {
    if (b.date !== date || b.status !== 'active') continue;
    const bPCs = (typeof b.pcs === 'string' ? (() => { try { return JSON.parse(b.pcs); } catch { return []; } })() : (b.pcs || []));
    if (b.pc_label) bPCs.push(...b.pc_label.split(',').map(s => s.trim()));
    const overlap = selectedPCs.some(pc => bPCs.includes(pc));
    if (!overlap) continue;
    const bStart = timeToMin(b.time);
    const bEnd = bStart + durMin(b.duration);
    // direct overlap
    if (start < bEnd && bStart < end) {
      results.push({ type: 'conflict', pc: selectedPCs.find(pc => bPCs.includes(pc)), name: b.name, start: b.time, end: minToTime(bEnd) });
    } else {
      // nearest upcoming or past
      const gap = start - bEnd;
      if (gap >= 0 && gap <= 180) {
        results.push({ type: 'upcoming', pc: selectedPCs.find(pc => bPCs.includes(pc)), name: b.name, start: b.time, end: minToTime(bEnd), gap });
      }
    }
  }
  // sort: conflicts first, then nearest gaps
  results.sort((a, b) => {
    if (a.type === 'conflict' && b.type !== 'conflict') return -1;
    if (a.type !== 'conflict' && b.type === 'conflict') return 1;
    return (a.gap || 999) - (b.gap || 999);
  });
  return results;
}

function updateConflictDisplay() {
  const el = document.getElementById('conflictInfo');
  if (!el) return;
  const date = document.querySelector('[type="date"]')?.value;
  const time = document.getElementById('bookingTime')?.value;
  const sel = document.getElementById('durationSelect');
  const cust = document.getElementById('durationCustom');
  const duration = sel?.value === 'custom' ? cust?.value : sel?.value;
  const selectedPCs = [...document.querySelectorAll('#pcGrid input:checked')].map(c => c.value);
  if (!date || !time || !duration || selectedPCs.length === 0) { el.textContent = ''; el.className = 'conflict-info'; return; }
  const results = checkConflicts(selectedPCs, time, date, duration);
  if (results.length === 0) {
    el.textContent = 'متاح ✅';
    el.className = 'conflict-info ok';
    return;
  }
  const conflict = results.find(r => r.type === 'conflict');
  if (conflict) {
    el.textContent = `⛔ ${conflict.pc} محجوز من ${conflict.name} (${conflict.start} - ${conflict.end})`;
    el.className = 'conflict-info error';
    return;
  }
  const next = results[0];
  el.textContent = `⚠️ ${next.pc} مشغول من ${next.name} الساعة ${next.start}`;
  el.className = 'conflict-info warn';
}

// attach live listeners
document.querySelector('#pcGrid')?.addEventListener('change', updateConflictDisplay);
document.getElementById('bookingTime')?.addEventListener('input', updateConflictDisplay);
document.querySelector('[type="date"]')?.addEventListener('change', updateConflictDisplay);
document.getElementById('durationSelect')?.addEventListener('change', updateConflictDisplay);
document.getElementById('durationCustom')?.addEventListener('input', updateConflictDisplay);
// initial display after auto-fill
setTimeout(updateConflictDisplay, 100);

// ===== DURATION CUSTOM =====
function onDurationChange() {
  const sel = document.getElementById('durationSelect');
  const cust = document.getElementById('durationCustom');
  if (sel.value === 'custom') {
    cust.style.display = 'block';
    cust.focus();
  } else {
    cust.style.display = 'none';
  }
}

// ===== BOOKING FORM =====
async function submitBooking(e) {
  e.preventDefault();
  const f = e.target;
  const user = getCurrentUser();
  const selectedPCs = [...f.querySelectorAll('#pcGrid input:checked')].map(c => c.value);
  if (selectedPCs.length === 0) {
    showToast('⚠️ Please select at least one PC');
    return;
  }

  let duration;
  const sel = document.getElementById('durationSelect');
  if (sel.value === 'custom') {
    const cust = document.getElementById('durationCustom');
    duration = cust.value;
    if (!duration || duration <= 0) { showToast('⚠️ Enter valid minutes'); return; }
  } else {
    duration = sel.value;
  }

  const name  = user ? user.name  : document.getElementById('bookingName').value;
  const phone = user ? user.phone : document.getElementById('bookingPhone').value;
  const date = f.querySelector('[type="date"]').value;
  const time = document.getElementById('bookingTime').value;

  // instant conflict check using cached data
  const conflicts = checkConflicts(selectedPCs, time, date, duration);
  const conflict = conflicts.find(r => r.type === 'conflict');
  if (conflict) {
    showToast(`⛔ ${conflict.pc} محجوز من ${conflict.name} (${conflict.start} - ${conflict.end})`);
    return;
  }

  const bookingData = {
    id: Date.now(),
    name:     name,
    phone:    phone,
    pcs:      JSON.stringify(selectedPCs),
    pc_label: selectedPCs.join(', '),
    duration: duration,
    addon:    f.querySelectorAll('select')[0].value,
    date:     date,
    time:     time,
    status:   'pending',
  };

  try {
    await postBooking(bookingData);
    showToast('تم إرسال الحجز، في انتظار موافقة الإدارة ✅');
    f.reset();
    document.querySelectorAll('#pcGrid input:checked').forEach(c => c.checked = false);
    updateConflictDisplay();
    renderOccupiedPCs();
  } catch {
    showToast('⚠️ حدث خطأ في الإرسال، حاول مرة أخرى');
  }
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  if (toast) {
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 4000);
  }
}

// ===== OCCUPIED PCS STATUS =====
function parseDuration(d) {
  const n = parseInt(d, 10);
  if (!isNaN(n) && n > 0) return n;
  if (d.includes('1 Hour')) return 60;
  if (d.includes('2')) return 120;
  if (d.includes('3')) return 180;
  if (d.includes('Unlimited')) return 1440;
  return 60;
}

function isBookingNow(b) {
  const now = new Date();
  const [h, m] = (b.time || '00:00').split(':').map(Number);
  const startMin = h * 60 + m;
  const dur = parseDuration(b.duration);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return nowMin >= startMin && nowMin < startMin + dur;
}

let lastPcHash = '';
async function renderOccupiedPCs() {
  const el = document.getElementById('occupiedPCs');
  if (!el) return;
  const today = new Date().toISOString().split('T')[0];
  let bookings;
  try { bookings = await getBookings(); } catch { bookings = []; }
  const hash = JSON.stringify(bookings.filter(b => b.date === today).map(b => b.id + b.status + (b.pcs || '') + (b.pc_label || '')));
  if (hash === lastPcHash) return;
  lastPcHash = hash;
  const active = bookings.filter(b => b.status === 'active' && b.date === today);
  const busyPCs = [...new Set(active.filter(isBookingNow).flatMap(b => {
    if (typeof b.pcs === 'string') { try { return JSON.parse(b.pcs); } catch {} }
    if (Array.isArray(b.pcs)) return b.pcs;
    if (b.pc_label) return b.pc_label.split(',').map(s => s.trim());
    if (b.pc) return b.pc.split(',').map(s => s.trim());
    return [];
  }))];
  const upcomingPCs = [...new Set(active.filter(b => !isBookingNow(b)).flatMap(b => {
    if (typeof b.pcs === 'string') { try { return JSON.parse(b.pcs); } catch {} }
    if (Array.isArray(b.pcs)) return b.pcs;
    if (b.pc_label) return b.pc_label.split(',').map(s => s.trim());
    if (b.pc) return b.pc.split(',').map(s => s.trim());
    return [];
  }))];
  const allPCs = ['PC 1','PC 2','PC 3','PC 4','PC 7','PC 8','PC 9','PC 10','PC 11','PC 12','VIP 1','VIP 2'];
  el.innerHTML = allPCs.map(pc => {
    if (busyPCs.includes(pc)) return `<span class="pc-status-chip busy">🔴 ${pc}</span>`;
    if (upcomingPCs.includes(pc)) return `<span class="pc-status-chip upcoming">🟡 ${pc}</span>`;
    return `<span class="pc-status-chip free">🟢 ${pc}</span>`;
  }).join('');

  // points tracking for logged-in user
  trackPoints(active);
  // sync balance/points with server for UI update
  syncUserDisplay();
  // refresh live conflict display
  updateConflictDisplay();
}

async function syncUserDisplay() {
  const user = getCurrentUser();
  if (!user) return;
  const lastSync = parseInt(localStorage.getItem('gzg_last_sync_' + user.id) || '0', 10);
  const now = Date.now();
  if (now - lastSync < 5000) return;
  try {
    const acc = await getAccountByPhone(user.phone);
    if (!acc) return;
    let changed = false;
    if ((acc.balance || 0) !== (user.balance || 0)) { user.balance = acc.balance || 0; changed = true; }
    if ((acc.points || 0) !== (user.points || 0)) { user.points = acc.points || 0; changed = true; }
    if (acc.avatar && acc.avatar !== user.avatar) { user.avatar = acc.avatar; changed = true; }
    if (changed) {
      localStorage.setItem(AUTH_KEY, JSON.stringify(user));
      updateUserMenuDisplay();
    }
    // check membership frame
    const avatar = document.getElementById('userAvatar');
    if (avatar) {
      const tier = await getActiveMembershipTier(user.id);
      if (tier && TIER_COLORS[tier]) {
        avatar.style.border = '3px solid ' + TIER_COLORS[tier];
        avatar.style.boxShadow = '0 0 12px ' + TIER_COLORS[tier] + '88';
      } else {
        avatar.style.border = '2px solid #6a00ff';
        avatar.style.boxShadow = 'none';
      }
    }
    localStorage.setItem('gzg_last_sync_' + user.id, String(now));
  } catch {}
}

async function trackPoints(active) {
  const user = getCurrentUser();
  if (!user) return;
  // check if user has an active booking (match by phone)
  const hasActive = active.some(b => b.phone === user.phone);
  if (!hasActive) return;
  const lastKey = 'gzg_last_point_' + user.id;
  const last = parseInt(localStorage.getItem(lastKey) || '0', 10);
  const now = Date.now();
  if (now - last < 30000) return; // 30s cooldown
  try {
    const acc = await getAccountByPhone(user.phone);
    if (!acc) return;
    const newPoints = (acc.points || 0) + 1;
    await patchAccount(acc.id, { points: newPoints, last_point_update: new Date().toISOString() });
    localStorage.setItem(lastKey, String(now));
    // update local user data
    user.points = newPoints;
    localStorage.setItem('gzg_user', JSON.stringify(user));
    updateUserMenuDisplay();
  } catch {}
}
renderOccupiedPCs();
let statusTimer = setInterval(() => renderOccupiedPCs(), 15000 + jitter());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearInterval(statusTimer);
  else { renderOccupiedPCs(); statusTimer = setInterval(() => renderOccupiedPCs(), 15000 + jitter()); }
});

// ===== ACTIVE NAV LINK ON SCROLL =====
const sections  = document.querySelectorAll('section[id], header[id]');
const navLinks  = document.querySelectorAll('.nav-links a');

const sectionObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      navLinks.forEach(link => {
        link.classList.remove('active-link');
        if (link.getAttribute('href') === '#' + entry.target.id) {
          link.classList.add('active-link');
        }
      });
    }
  });
}, { threshold: 0.4 });

sections.forEach(s => sectionObserver.observe(s));

// Inject active link style
const style = document.createElement('style');
style.textContent = `.nav-links a.active-link { color:#fff; background:rgba(106,0,255,0.2); box-shadow:0 0 12px rgba(106,0,255,0.4); }`;
document.head.appendChild(style);

// ===== MOBILE — scroll to section on button click =====
(function(){
  if (window.innerWidth > 768) return;

  const bookSection = document.getElementById('booking');

  function scrollBooking(e) {
    if (window.innerWidth > 768) return;
    e.preventDefault();
    if (bookSection) bookSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.getElementById('bookPcBtn')?.addEventListener('click', scrollBooking);
  document.querySelectorAll('.membership-btn').forEach(b => b.addEventListener('click', scrollBooking));
})();

// ===== GLITCH EFFECT on logo =====
const logoTitle = document.querySelector('.logo-title');
if (logoTitle) {
  setInterval(() => {
    logoTitle.style.textShadow = `0 0 8px rgba(255,0,60,0.8), 2px 0 rgba(106,0,255,0.6)`;
    setTimeout(() => { logoTitle.style.textShadow = ''; }, 80);
  }, 4000);
}

// =========================================
// ===== ACCOUNTS / AUTH SYSTEM =====
// =========================================
const AUTH_KEY = 'gzg_user';
let userLoginAttempts = 0;
const MAX_USER_LOGIN_ATTEMPTS = 5;
let userLoginLockout = 0;

function getCurrentUser() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY)); } catch { return null; }
}

function openAuth() {
  document.getElementById('authModal').classList.add('show');
  document.getElementById('loginError').textContent = '';
  document.getElementById('regError').textContent = '';
}

function closeAuth() {
  document.getElementById('authModal').classList.remove('show');
}

function switchAuth(tab) {
  document.getElementById('loginTab').classList.toggle('active', tab === 'login');
  document.getElementById('registerTab').classList.toggle('active', tab === 'register');
  document.getElementById('loginForm').style.display = tab === 'login' ? '' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('loginError').textContent = '';
  document.getElementById('regError').textContent = '';
}

async function handleLogin(e) {
  e.preventDefault();
  const now = Date.now();
  if (now < userLoginLockout) {
    document.getElementById('loginError').textContent = '⏳ Try again in ' + Math.ceil((userLoginLockout - now) / 1000) + 's';
    return;
  }
  const phone = document.getElementById('loginPhone').value.trim();
  const password = document.getElementById('loginPassword').value;
  try {
    const acc = await getAccountByPhone(phone);
    if (!acc || acc.password !== password) {
      userLoginAttempts++;
      if (userLoginAttempts >= MAX_USER_LOGIN_ATTEMPTS) {
        userLoginLockout = now + 30000;
        document.getElementById('loginError').textContent = '⏳ Too many attempts. Wait 30s.';
        userLoginAttempts = 0;
      } else {
        document.getElementById('loginError').textContent = 'Wrong phone or password (' + (MAX_USER_LOGIN_ATTEMPTS - userLoginAttempts) + ' left)';
      }
      return;
    }
    userLoginAttempts = 0;
    await patchAccount(acc.id, { last_login: new Date().toISOString() });
    localStorage.setItem(AUTH_KEY, JSON.stringify({ id: acc.id, name: acc.name, phone: acc.phone, avatar: acc.avatar || '', balance: acc.balance || 0, points: acc.points || 0 }));
    closeAuth();
    applyAuthUI();
    showToast('👋 Welcome back, ' + acc.name + '!');
  } catch (e) { document.getElementById('loginError').textContent = 'Error: ' + e.message; }
}

async function handleRegister(e) {
  e.preventDefault();
  const name = document.getElementById('regName').value.trim();
  const phone = document.getElementById('regPhone').value.trim();
  const password = document.getElementById('regPassword').value;
  if (password.length < 4) { document.getElementById('regError').textContent = 'Password must be at least 4 characters'; return; }
  try {
    const existing = await getAccountByPhone(phone);
    if (existing) { document.getElementById('regError').textContent = 'Phone already registered'; return; }
    const acc = await postAccount({ id: Date.now(), name, phone, password, avatar: '', balance: 0, points: 0 });
    await patchAccount(acc.id, { last_login: new Date().toISOString() });
    localStorage.setItem(AUTH_KEY, JSON.stringify({ id: acc.id, name: acc.name, phone: acc.phone, avatar: '', balance: 0, points: 0 }));
    closeAuth();
    applyAuthUI();
    showToast('🎉 Welcome, ' + name + '!');
  } catch (e) { document.getElementById('regError').textContent = 'Error: ' + e.message; }
}

function handleLogout() {
  localStorage.removeItem(AUTH_KEY);
  applyAuthUI();
  closeUserDropdown();
  showToast('👋 Logged out');
}

function switchAccount() {
  localStorage.removeItem(AUTH_KEY);
  applyAuthUI();
  closeUserDropdown();
  openAuth();
  showToast('👋 Logged out');
}

async function handleDeleteAccount() {
  if (!confirm('Delete your account forever? This cannot be undone.')) return;
  const user = getCurrentUser();
  if (!user) return;
  try {
    await deleteAccountSupabase(user.id);
    localStorage.removeItem(AUTH_KEY);
    applyAuthUI();
    closeUserDropdown();
    showToast('🗑️ Account deleted');
  } catch { showToast('⚠️ Error deleting account'); }
}

function openChangePassword() {
  closeUserDropdown();
  document.getElementById('passwordModal').classList.add('show');
  document.getElementById('passwordError').textContent = '';
}

function closePasswordModal() {
  document.getElementById('passwordModal').classList.remove('show');
}

async function changePassword(e) {
  e.preventDefault();
  const np = document.getElementById('newPassword').value;
  const cp = document.getElementById('confirmPassword').value;
  if (np !== cp) { document.getElementById('passwordError').textContent = 'Passwords do not match'; return; }
  if (np.length < 4) { document.getElementById('passwordError').textContent = 'At least 4 characters'; return; }
  const user = getCurrentUser();
  if (!user) return;
  try {
    await patchAccount(user.id, { password: np });
    closePasswordModal();
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmPassword').value = '';
    showToast('🔑 Password changed');
  } catch { document.getElementById('passwordError').textContent = 'Error changing password'; }
}

function openUploadAvatar() {
  closeUserDropdown();
  document.getElementById('avatarModal').classList.add('show');
  document.getElementById('avatarError').textContent = '';
}

function closeAvatarModal() {
  document.getElementById('avatarModal').classList.remove('show');
}

async function uploadAvatar(e) {
  e.preventDefault();
  const file = document.getElementById('avatarInput').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async function() {
    const dataUrl = reader.result;
    const user = getCurrentUser();
    if (!user) return;
    try {
      await patchAccount(user.id, { avatar: dataUrl });
      user.avatar = dataUrl;
      localStorage.setItem(AUTH_KEY, JSON.stringify(user));
      applyAuthUI();
      closeAvatarModal();
      showToast('🖼️ Photo updated');
    } catch { document.getElementById('avatarError').textContent = 'Error uploading'; }
  };
  reader.readAsDataURL(file);
}

function toggleUserDropdown() {
  const dd = document.getElementById('userDropdown');
  dd.classList.toggle('show');
  refreshUserData().then(updateUserMenuDisplay).catch(() => {});
}

async function refreshUserData() {
  const user = getCurrentUser();
  if (!user) return;
  try {
    const acc = await getAccountByPhone(user.phone);
    if (!acc) return;
    user.balance = acc.balance || 0;
    user.points = acc.points || 0;
    user.avatar = acc.avatar || user.avatar;
    localStorage.setItem(AUTH_KEY, JSON.stringify(user));
    const ib = document.getElementById('inlineBalance');
    const ip = document.getElementById('inlinePoints');
    if (ib) ib.textContent = user.balance;
    if (ip) ip.textContent = user.points;
    // refresh membership frame
    const avatar = document.getElementById('userAvatar');
    if (avatar) {
      const tier = await getActiveMembershipTier(user.id);
      if (tier && TIER_COLORS[tier]) {
        avatar.style.border = '3px solid ' + TIER_COLORS[tier];
        avatar.style.boxShadow = '0 0 12px ' + TIER_COLORS[tier] + '88';
      } else {
        avatar.style.border = '2px solid #6a00ff';
        avatar.style.boxShadow = 'none';
      }
    }
  } catch {}
}

function updateUserMenuDisplay() {
  const user = getCurrentUser();
  if (!user) return;
  const bal = document.getElementById('dropdownBalance');
  const pts = document.getElementById('dropdownPoints');
  if (bal) bal.textContent = user.balance || 0;
  if (pts) pts.textContent = user.points || 0;
  const ib = document.getElementById('inlineBalance');
  const ip = document.getElementById('inlinePoints');
  if (ib) ib.textContent = user.balance || 0;
  if (ip) ip.textContent = user.points || 0;
}

function closeUserDropdown() {
  document.getElementById('userDropdown').classList.remove('show');
}

// close dropdown on outside click
document.addEventListener('click', function(e) {
  const menu = document.getElementById('userMenu');
  const dd = document.getElementById('userDropdown');
  if (menu && dd && !menu.contains(e.target)) dd.classList.remove('show');
});

// ===== MEMBERSHIPS =====
async function postMembership(d) { d.id = d.id || Date.now(); d.created_at = d.created_at || new Date().toISOString(); await _loadStore(); _store.memberships.push(d); await _saveStore(); return d; }
async function patchMembership(id, d) { await _loadStore(); const i = _store.memberships.findIndex(x => x.id === id); if (i !== -1) { Object.assign(_store.memberships[i], d); await _saveStore(); return _store.memberships[i]; } return null; }

async function requestMembership(el) {
  const user = getCurrentUser();
  if (!user) { showToast('👤 Please login first'); return; }
  const tier = el.dataset.tier;
  const amount = parseInt(el.dataset.amount);
  try {
    let all = [];
    try { all = await getMemberships(); } catch {}
    const pending = all.filter(m => m.account_id === user.id && m.tier === tier && m.status === 'pending');
    if (pending.length > 0) { showToast('⚠️ Request already sent for ' + tier); return; }
    await postMembership({ account_id: user.id, tier, amount, status: 'pending' });
    showToast('✅ ' + tier + ' request sent to admin!');
  } catch { showToast('⚠️ Error sending request'); }
}

// ===== CONVERT POINTS =====
function openConvertPoints() {
  closeUserDropdown();
  const user = getCurrentUser();
  if (!user) return;
  document.getElementById('convertPointsDisplay').textContent = user.points || 0;
  document.getElementById('convertEgpDisplay').textContent = '0';
  document.getElementById('convertAmount').value = '';
  document.getElementById('convertError').textContent = '';
  document.getElementById('convertModal').classList.add('show');
}
function closeConvertModal() { document.getElementById('convertModal').classList.remove('show'); }

async function convertPoints(e) {
  e.preventDefault();
  const user = getCurrentUser();
  if (!user) return;
  const pts = parseInt(document.getElementById('convertAmount').value);
  if (!pts || pts < 10) { document.getElementById('convertError').textContent = 'Minimum 10 points'; return; }
  if (pts > (user.points || 0)) { document.getElementById('convertError').textContent = 'Not enough points'; return; }
  const egp = Math.floor(pts / 10);
  try {
    await patchAccount(user.id, { points: (user.points || 0) - pts, balance: (user.balance || 0) + egp });
    user.points = (user.points || 0) - pts;
    user.balance = (user.balance || 0) + egp;
    localStorage.setItem(AUTH_KEY, JSON.stringify(user));
    closeConvertModal();
    applyAuthUI();
    showToast('🪙 Converted ' + pts + ' pts → ' + egp + ' EGP');
  } catch { document.getElementById('convertError').textContent = 'Error converting'; }
}

// ===== ACTIVE MEMBERSHIP (for avatar frame) =====
async function getActiveMembershipTier(userId) {
  try {
    const all = await getMemberships();
    const approved = all.filter(m => m.account_id === userId && m.status === 'approved');
    if (approved.length === 0) return null;
    // return the most recent approved
    approved.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return approved[0].tier;
  } catch { return null; }
}

const TIER_COLORS = { BRONZE: '#cd7f32', SILVER: '#c0c0c0', GOLD: '#ffd700', DIAMOND: '#00ffff' };

async function applyAuthUI() {
  const user = getCurrentUser();
  const menu = document.getElementById('userMenu');
  const avatar = document.getElementById('userAvatar');
  const name = document.getElementById('dropdownName');
  const bal = document.getElementById('dropdownBalance');
  const pts = document.getElementById('dropdownPoints');

  if (user) {
    if (!user.balance) user.balance = 0;
    if (!user.points) user.points = 0;
    localStorage.setItem(AUTH_KEY, JSON.stringify(user));
    const heroBtn = document.getElementById('heroLoginBtn');
    if (heroBtn) heroBtn.style.display = 'none';
    menu.style.display = 'inline-flex';
    avatar.src = user.avatar || 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#6a00ff"/><text x="16" y="21" text-anchor="middle" fill="#fff" font-family="Arial" font-size="16" font-weight="bold">' + user.name.charAt(0).toUpperCase() + '</text></svg>');
    // hide camera icon if custom photo set
    const camIcon = document.querySelector('.avatar-edit');
    if (camIcon) camIcon.style.display = user.avatar ? 'none' : 'flex';
    name.textContent = user.name;
    if (bal) bal.textContent = user.balance;
    if (pts) pts.textContent = user.points;

    // nav badges
    const ib = document.getElementById('inlineBalance');
    const ip = document.getElementById('inlinePoints');
    if (ib) ib.textContent = user.balance;
    if (ip) ip.textContent = user.points;

    // auto-fill & hide booking name/phone
    const bRow = document.getElementById('bookingNameRow');
    if (bRow) bRow.style.display = 'none';
    document.getElementById('bookingName').value = user.name;
    document.getElementById('bookingPhone').value = user.phone;

    // membership frame
    const tier = await getActiveMembershipTier(user.id);
    if (tier && TIER_COLORS[tier]) {
      avatar.style.border = '3px solid ' + TIER_COLORS[tier];
      avatar.style.boxShadow = '0 0 12px ' + TIER_COLORS[tier] + '88';
    } else {
      avatar.style.border = '2px solid #6a00ff';
      avatar.style.boxShadow = 'none';
    }
  } else {
    const heroBtn = document.getElementById('heroLoginBtn');
    if (heroBtn) heroBtn.style.display = '';
    menu.style.display = 'none';
    const bRow = document.getElementById('bookingNameRow');
    if (bRow) bRow.style.display = '';
  }
}

// restore session on page load
applyAuthUI();

function openAvatarLightbox() {
  const avatar = document.getElementById('userAvatar');
  if (!avatar || !avatar.src) return;
  const img = document.getElementById('avatarLightboxImg');
  if (!img) return;
  img.src = avatar.src;
  document.getElementById('avatarLightbox').classList.add('show');
}

function closeAvatarLightbox() {
  document.getElementById('avatarLightbox').classList.remove('show');
}

// ===== ONLINE PRESENCE (heartbeat every 30s) =====
let heartbeatTimer = null;
function startHeartbeat() {
  const user = getCurrentUser();
  if (!user || !user.id) return;
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  const beat = () => {
    patchAccount(user.id, { last_seen: new Date().toISOString() }).catch(() => {});
  };
  beat();
  heartbeatTimer = setInterval(beat, 30000);
}
// start heartbeat on login + after page load if logged in
const origHandleLogin = window.handleLogin;
if (origHandleLogin) {
  window.handleLogin = function(...args) {
    const r = origHandleLogin.apply(this, args);
    startHeartbeat();
    return r;
  };
}
const origHandleRegister = window.handleRegister;
if (origHandleRegister) {
  window.handleRegister = function(...args) {
    const r = origHandleRegister.apply(this, args);
    startHeartbeat();
    return r;
  };
}
startHeartbeat();
// mark offline on tab close
window.addEventListener('beforeunload', () => {
  const user = getCurrentUser();
  if (user && user.id) {
    try { patchAccount(user.id, { last_seen: new Date(0).toISOString() }); } catch {}
  }
});
