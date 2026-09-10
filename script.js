/* ===========================
   GAME ZONE GAMING – script.js
   Real-time client (REST + WebSocket + SQLite backend)
   =========================== */

// ===== API + REAL-TIME CONNECTION =====
const API_BASE = (() => {
  if (typeof location !== 'undefined' && location.host) return location.origin;
  return 'http://localhost:3000';
})();
const WS_URL = API_BASE.replace(/^http/, 'ws') + '/ws';
const TOKEN_KEY = 'gzg_token';
const USER_KEY = 'gzg_user';

async function api(path, opts) {
  opts = opts || {};
  const headers = opts.headers || {};
  if (opts.method && opts.method !== 'GET') headers['Content-Type'] = 'application/json';
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) headers['Authorization'] = 'Bearer ' + token;
  const res = await fetch(API_BASE + path, { ...opts, headers });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || ('HTTP ' + res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// cached data shared by UI
let _bookingsCache = [];
let _deviceCache = [];
let _membershipsCache = [];
let _lastPcHash = '';
let _availabilityTimer = null;
let _ws = null;
let _wsReconnectDelay = 2000;

function getCurrentUser() {
  try { return JSON.parse(localStorage.getItem(USER_KEY)); } catch { return null; }
}
function saveUser(u) {
  const clean = { id: u.id, name: u.name, username: u.username || '', phone: u.phone, avatar: u.avatar || '', favorite_game: u.favorite_game || '', balance: u.balance || 0, points: u.points || 0, online: !!u.online, last_login: u.last_login || '' };
  localStorage.setItem(USER_KEY, JSON.stringify(clean));
}
function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

// ===== DATA WRAPPERS =====
async function getBookings() {
  try { const r = await api('/api/bookings'); _bookingsCache = r.bookings; } catch { _bookingsCache = []; }
  return _bookingsCache;
}
async function getAccounts() {
  try { const r = await api('/api/accounts'); return r.accounts; } catch { return []; }
}
async function getMemberships() {
  try { const r = await api('/api/memberships'); _membershipsCache = r.memberships; return _membershipsCache; } catch { return []; }
}
async function getDevices() {
  try { const r = await api('/api/devices'); _deviceCache = r.devices; if (r.settings) _liveSettings = r.settings; return r.devices; } catch { return []; }
}
async function postBooking(d) { const r = await api('/api/bookings', { method: 'POST', body: JSON.stringify(d) }); return r.booking; }
async function patchBooking(id, d) { const r = await api('/api/bookings/' + id, { method: 'PATCH', body: JSON.stringify(d) }); return r.booking; }
async function deleteBookingSupabase(id) { await api('/api/bookings/' + id, { method: 'DELETE' }); }
async function patchAccount(id, d) { const r = await api('/api/accounts/' + id, { method: 'PATCH', body: JSON.stringify(d) }); return r.account; }
async function postMembership(d) { const r = await api('/api/memberships', { method: 'POST', body: JSON.stringify(d) }); return r.membership; }

// ===== LIVE CONFLICT CHECK =====
function timeToMin(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}
function durMin(d) {
  const n = parseInt(d, 10);
  if (!isNaN(n) && n > 0) return n;
  if (d === 'custom') return 0;
  if (String(d).includes('1 Hour')) return 60;
  if (String(d).includes('2')) return 120;
  if (String(d).includes('3')) return 180;
  if (String(d).includes('Unlimited')) return 1440;
  return 60;
}

async function updateConflictDisplay() {
  const el = document.getElementById('conflictInfo');
  if (!el) return;
  const date = document.querySelector('[type="date"]')?.value;
  const time = document.getElementById('bookingTime')?.value;
  const sel = document.getElementById('durationSelect');
  const cust = document.getElementById('durationCustom');
  const duration = sel && sel.value === 'custom' ? cust?.value : sel?.value;
  const selectedPCs = duration === 0 ? [] : [...document.querySelectorAll('#pcGrid input:checked')].map(c => c.value);
  if (!date || !time || durMin(duration) <= 0 || selectedPCs.length === 0) { el.textContent = ''; el.className = 'conflict-info'; return; }
  clearTimeout(_availabilityTimer);
  _availabilityTimer = setTimeout(async () => {
    try {
      const r = await api('/api/availability', { method: 'POST', body: JSON.stringify({ date, time, duration: durMin(duration), pcs: selectedPCs }) });
      const conflicts = r.conflicts || [];
      if (conflicts.length === 0) {
        const suffix = r.nextFree ? ' (متاح من ' + r.nextFree + ')' : '';
        el.textContent = 'متاح ✅' + suffix;
        el.className = 'conflict-info ok';
        return;
      }
      const c = conflicts[0];
      el.textContent = '⛔ ' + c.pc + ' محجوز من ' + c.name + ' (' + c.start + ' - ' + c.end + ')';
      el.className = 'conflict-info error';
    } catch { el.textContent = ''; el.className = 'conflict-info'; }
  }, 250);
}

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
      navbar.style.boxShadow = window.scrollY > 10 ? '0 4px 40px rgba(106,0,255,0.25)' : '';
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
const tabBtns   = document.querySelectorAll('.tab-btn');
const tabPanels = document.querySelectorAll('.tab-content');

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
const bt = document.getElementById('bookingTime');
if (bt) {
  bt.addEventListener('focus', () => { bt.dataset.userChanged = '1'; });
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

// attach live listeners
function bindConflictListeners() {
  document.querySelector('#pcGrid')?.addEventListener('change', () => { updateConflictDisplay(); updatePricePreview(); });
  document.getElementById('bookingTime')?.addEventListener('input', updateConflictDisplay);
  document.querySelector('[type="date"]')?.addEventListener('change', updateConflictDisplay);
  document.getElementById('durationSelect')?.addEventListener('change', () => { updateConflictDisplay(); updatePricePreview(); });
  document.getElementById('durationCustom')?.addEventListener('input', () => { updateConflictDisplay(); updatePricePreview(); });
  document.getElementById('balancePayRow')?.addEventListener('change', () => { updatePricePreview(); });
  setTimeout(updateConflictDisplay, 200);
}
bindConflictListeners();

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
  updatePricePreview();
}

// ===== BOOKING PRICE PREVIEW (display only — server recalculates & enforces) =====
function selectedDurationMin() {
  const sel = document.getElementById('durationSelect');
  if (!sel || !sel.value) return 0;
  if (sel.value === 'custom') {
    const c = parseInt(document.getElementById('durationCustom')?.value, 10);
    return isNaN(c) || c <= 0 ? 0 : c;
  }
  return durMin(sel.value);
}
function updatePricePreview() {
  const est = document.getElementById('estimatedPrice');
  if (!est) return;
  const row = document.getElementById('balancePayRow');
  const cb = document.getElementById('payWithBalanceCheck');
  const balEl = document.getElementById('currentBalanceShown');
  const info = document.getElementById('balancePayInfo');
  const user = getCurrentUser();
  const pcs = [...document.querySelectorAll('#pcGrid input:checked')].map(c => c.value);
  const dur = selectedDurationMin();
  const devs = _deviceCache || [];
  let total = 0;
  for (const pc of pcs) {
    const d = devs.find(x => x.pc === pc) || {};
    const rate = Number(d.type === 'vip' ? (_liveSettings.vip_price_per_hour || 0) : (_liveSettings.standard_price_per_hour || 0));
    total += rate * (dur || 0) / 60;
  }
  total = Math.round(total * 100) / 100;
  est.textContent = total;
  if (!row || !cb) return;
  if (!user) { row.style.display = 'none'; cb.checked = false; return; }
  row.style.display = 'block';
  if (balEl) balEl.textContent = user.balance || 0;
  if (total > 0 && (user.balance || 0) >= total) {
    cb.disabled = false;
  } else {
    cb.disabled = true;
    cb.checked = false;
  }
  if (info) info.textContent = cb.checked ? 'Will be deducted from your balance after confirmation' : (cb.disabled && total > 0 ? 'Not enough balance for this booking' : '');
}

// ===== BOOKABLE PACKAGES (server-managed, shown in Prices section) =====
let _packagesCache = [];
async function loadPackages() {
  try {
    const r = await api('/api/packages');
    _packagesCache = r.packages || [];
  } catch { return; }
  renderPackages();
}
function renderPackages() {
  const wrap = document.getElementById('packagesWrap');
  const host = document.getElementById('packagesList');
  if (!wrap || !host) return;
  const list = (_packagesCache || []).filter(p => p.status === 'active');
  if (!list.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  host.innerHTML = list.map(p =>
    '<div class="package-card" onclick="usePackage(' + p.id + ')">' +
    '<div class="package-top"><span class="package-type ' + (p.device_type === 'vip' ? 'vip' : '') + '">' + (p.device_type === 'vip' ? '💎 VIP' : '🖥️ Standard') + '</span><span class="package-price">' + Number(p.price) + ' <small>EGP</small></span></div>' +
    '<strong class="package-name">' + escapeHtml(p.name) + '</strong>' +
    '<span class="package-meta">' + p.duration + ' min</span>' +
    (p.description ? '<span class="package-desc">' + escapeHtml(p.description) + '</span>' : '') +
    '</div>'
  ).join('');
}
function usePackage(id) {
  const p = (_packagesCache || []).find(x => x.id === id);
  if (!p) return;
  const sel = document.getElementById('durationSelect');
  if (sel) {
    const opts = [...sel.options].map(o => o.value);
    if (opts.includes(String(p.duration))) sel.value = String(p.duration);
    else {
      sel.value = 'custom';
      const c = document.getElementById('durationCustom');
      if (c) c.value = p.duration;
    }
    onDurationChange();
  }
  updatePricePreview();
  const bs = document.getElementById('booking');
  if (bs) bs.scrollIntoView({ behavior: 'smooth', block: 'start' });
  showToast('🎮 Apply package: ' + p.name);
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
    duration = parseInt(cust.value, 10);
    if (!duration || duration <= 0) { showToast('⚠️ Enter valid minutes'); return; }
  } else {
    duration = durMin(sel.value);
  }

  const name  = user ? user.name : document.getElementById('bookingName').value.trim();
  const phone = user ? user.phone : document.getElementById('bookingPhone').value.trim();
  const date  = f.querySelector('[type="date"]').value;
  const time  = document.getElementById('bookingTime').value;

  const btn = f.querySelector('button[type="submit"]');
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ ...'; }

try {
    const payBox = document.getElementById('payWithBalanceCheck');
    const booking = await postBooking({
      pcs: selectedPCs,
      duration,
      addon: f.querySelectorAll('select')[0].value,
      date,
      time,
      pay_with_balance: !!(user && payBox && payBox.checked && !payBox.disabled),
      ...(user ? {} : { name, phone }),
    });
    showToast('تم إرسال الحجز بنجاح ✅');
    const payBox2 = document.getElementById('payWithBalanceCheck');
    if (payBox2) payBox2.checked = false;
    f.reset();
    if (user) { document.getElementById('bookingName').value = user.name; document.getElementById('bookingPhone').value = user.phone; }
    document.querySelectorAll('#pcGrid input:checked').forEach(c => c.checked = false);
    document.getElementById('durationSelect').value = '';
    onDurationChange();
    updateConflictDisplay();
    updatePricePreview();
    await getDevices();
    renderOccupiedPCs();
  } catch (err) {
    if (err.status === 409 && err.data && err.data.conflict) {
      const c = err.data.conflict;
      showToast(c.manual
        ? '⛔ ' + c.pc + ' مشغول يدويًا الآن'
        : '⛔ ' + c.pc + ' محجوز من ' + c.name + ' (' + c.start + ' - ' + c.end + ')');
    } else if (err.status === 402 && err.data && err.data.error) {
      showToast('⚠️ ' + err.data.error);
    } else if (err.data && err.data.error) {
      showToast('⚠️ ' + err.data.error);
    } else {
      showToast('⚠️ حدث خطأ في الإرسال، حاول مرة أخرى');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = orig; }
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

// ===== OCCUPIED PCS STATUS (server-driven) =====
function renderOccupiedPCs() {
  const el = document.getElementById('occupiedPCs');
  if (!el) return;
  const devs = _deviceCache || [];
  if (devs.length === 0) return;
  const hash = devs.map(d => d.pc + '|' + d.color + '|' + d.label + '|' + d.manual).join(',');
  if (hash === _lastPcHash) return;
  _lastPcHash = hash;
  el.innerHTML = devs.map(pc => {
    if (pc.color === 'red') return `<span class="pc-status-chip busy" title="${escAttr(pc.detail)}">🔴 ${pc.pc}</span>`;
    if (pc.color === 'yellow') return `<span class="pc-status-chip upcoming" title="${escAttr(pc.detail)}">🟡 ${pc.pc}</span>`;
    return `<span class="pc-status-chip free" title="Available">🟢 ${pc.pc}</span>`;
  }).join('');
  updateConflictDisplay();
  syncUserDisplay();
}

function escAttr(s) {
  return String(s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

async function syncUserDisplay() {
  const user = getCurrentUser();
  if (!user) return;
  const lastSync = parseInt(localStorage.getItem('gzg_last_sync_' + user.id) || '0', 10);
  const now = Date.now();
  if (now - lastSync < 10000) {
    updateUserMenuDisplay();
    return;
  }
  try {
    const r = await api('/api/auth/me');
    if (!r.account) return;
    saveUser(r.account);
    updateUserMenuDisplay();
    applyMembershipFrame();
    localStorage.setItem('gzg_last_sync_' + user.id, String(now));
  } catch { updateUserMenuDisplay(); }
}

async function refreshDevices() {
  await getDevices();
  renderOccupiedPCs();
}

// ===== REAL-TIME (WebSocket) =====
function handleWSEvent(ev) {
  switch (ev.type) {
    case 'ping':
      break;
    case 'accounts_changed': {
      const user = getCurrentUser();
      if (user && ev.data && ev.data.account) {
        const a = ev.data.account;
if (a.id === user.id) {
          const merged = { ...user, balance: a.balance, points: a.points, avatar: a.avatar, name: a.name, username: a.username, favorite_game: a.favorite_game, online: a.online };
          saveUser(merged);
          updateUserMenuDisplay();
          applyMembershipFrame();
          updatePricePreview();
        }
      }
      if (ev.data && ev.data.deleted === user?.id) {
        clearSession();
        applyAuthUI();
      }
      break;
    }
    case 'presence_changed': {
      const user = getCurrentUser();
      if (user && ev.data && ev.data.account && ev.data.account.id === user.id) {
        user.online = !!ev.data.account.online;
        saveUser(user);
      }
      break;
    }
    case 'devices_changed':
      _deviceCache = ev.data && ev.data.devices ? ev.data.devices : [];
      renderOccupiedPCs();
      renderPcGrid(_deviceCache);
      break;
    case 'content_changed':
      if (ev.data && ev.data.key) {
        contentCache[ev.data.key] = ev.data.value;
        applyContentSection(ev.data.key);
      }
      break;
case 'bookings_changed':
      getBookings().then(() => { updateConflictDisplay(); });
      break;
    case 'packages_changed':
      loadPackages();
      break;
    case 'memberships_changed':
      applyMembershipFrame();
      break;
    case 'settings_changed':
      if (document.getElementById('convertPointsDisplay')) {
        const u = getCurrentUser();
        if (u) document.getElementById('convertPointsDisplay').textContent = u.points || 0;
      }
      break;
  }
}

function connectRealtime() {
  try { _ws = new WebSocket(WS_URL); } catch { scheduleReconnect(); return; }
  _ws.onopen = () => {
    _wsReconnectDelay = 2000;
    // resync latest server state immediately after (re)connect so shared
    // device status + bookings stay consistent even if messages were missed
    refreshDevices();
    getBookings().then(() => updateConflictDisplay());
  };
  _ws.onmessage = e => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    handleWSEvent(m);
  };
  _ws.onclose = () => scheduleReconnect();
  _ws.onerror = () => { try { _ws.close(); } catch {} };
}
function scheduleReconnect() {
  setTimeout(connectRealtime, _wsReconnectDelay);
  _wsReconnectDelay = Math.min(_wsReconnectDelay * 1.5, 15000);
}

// fallback background refresh (keeps UI consistent even if WS is blocked)
setInterval(() => { refreshDevices(); getBookings().then(() => updateConflictDisplay()); }, 20000);
setInterval(() => syncUserDisplay(), 30000);

// ===== ACTIVE NAV LINK ON SCROLL =====
const sections  = document.querySelectorAll('section[id], header[id]');
const navLinks  = document.querySelectorAll('.nav-links a');

const sectionObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      navLinks.forEach(link => {
        link.classList.remove('active-link');
        if (link.getAttribute('href') === '#' + entry.target.id) link.classList.add('active-link');
      });
    }
  });
}, { threshold: 0.4 });

sections.forEach(s => sectionObserver.observe(s));

const navStyle = document.createElement('style');
navStyle.textContent = `.nav-links a.active-link { color:#fff; background:rgba(106,0,255,0.2); box-shadow:0 0 12px rgba(106,0,255,0.4); }`;
document.head.appendChild(navStyle);

// ===== MOBILE — scroll to section =====
(function () {
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

// ===== GLITCH LOGO =====
const logoTitle = document.querySelector('.logo-title');
if (logoTitle) {
  setInterval(() => {
    logoTitle.style.textShadow = '0 0 8px rgba(255,0,60,0.8), 2px 0 rgba(106,0,255,0.6)';
    setTimeout(() => { logoTitle.style.textShadow = ''; }, 80);
  }, 4000);
}

// =========================================
// ===== AUTH =====
// =========================================
let userLoginAttempts = 0;
const MAX_USER_LOGIN_ATTEMPTS = 5;
let userLoginLockout = 0;

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
    const r = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ phone, password }) });
    userLoginAttempts = 0;
    localStorage.setItem(TOKEN_KEY, r.token);
    saveUser(r.account);
    closeAuth();
    applyAuthUI();
    startHeartbeat();
    showToast('👋 Welcome back, ' + r.account.name + '!');
  } catch (e) {
    if (e.status === 401) {
      userLoginAttempts++;
      if (userLoginAttempts >= MAX_USER_LOGIN_ATTEMPTS) {
        userLoginLockout = now + 30000;
        document.getElementById('loginError').textContent = '⏳ Too many attempts. Wait 30s.';
        userLoginAttempts = 0;
      } else {
        document.getElementById('loginError').textContent = 'Wrong phone or password (' + (MAX_USER_LOGIN_ATTEMPTS - userLoginAttempts) + ' left)';
      }
    } else {
      document.getElementById('loginError').textContent = 'Error: ' + (e.data && e.data.error ? e.data.error : e.message);
    }
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const name = document.getElementById('regName').value.trim();
  const username = (document.getElementById('regUsername')?.value || '').trim();
  const phone = document.getElementById('regPhone').value.trim();
  const password = document.getElementById('regPassword').value;
  if (password.length < 4) { document.getElementById('regError').textContent = 'Password must be at least 4 characters'; return; }
  try {
    const r = await api('/api/auth/register', { method: 'POST', body: JSON.stringify({ name, username: username || undefined, phone, password }) });
    localStorage.setItem(TOKEN_KEY, r.token);
    saveUser(r.account);
    closeAuth();
    applyAuthUI();
    startHeartbeat();
    showToast('🎉 Welcome, ' + r.account.name + '!');
  } catch (e) {
    if (e.status === 409) document.getElementById('regError').textContent = e.data && e.data.error ? e.data.error : 'Phone already registered';
    else document.getElementById('regError').textContent = 'Error: ' + e.message;
  }
}

function handleLogout() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) { try { fetch(API_BASE + '/api/auth/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } }); } catch {} }
  stopHeartbeat();
  clearSession();
  applyAuthUI();
  closeUserDropdown();
  showToast('👋 Logged out');
}

function switchAccount() {
  handleLogout();
  openAuth();
}

async function handleDeleteAccount() {
  if (!confirm('Delete your account forever? This cannot be undone.')) return;
  const user = getCurrentUser();
  if (!user) return;
  try {
    await api('/api/accounts/' + user.id, { method: 'DELETE' });
    stopHeartbeat();
    clearSession();
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
  } catch (e) {
    document.getElementById('passwordError').textContent = e.data && e.data.error ? e.data.error : 'Error changing password';
  }
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
  reader.onload = async function () {
    const user = getCurrentUser();
    if (!user) return;
    try {
      const acc = await patchAccount(user.id, { avatar: reader.result });
      saveUser({ ...user, avatar: acc.avatar });
      applyAuthUI();
      closeAvatarModal();
      showToast('🖼️ Photo updated');
    } catch (err) {
      document.getElementById('avatarError').textContent = err.data && err.data.error ? err.data.error : 'Error uploading';
    }
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
    const r = await api('/api/auth/me');
    if (r.account) {
      saveUser(r.account);
      updateUserMenuDisplay();
      applyMembershipFrame();
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
  const dd = document.getElementById('userDropdown');
  if (dd) dd.classList.remove('show');
}

document.addEventListener('click', function (e) {
  const menu = document.getElementById('userMenu');
  const dd = document.getElementById('userDropdown');
  if (menu && dd && !menu.contains(e.target)) dd.classList.remove('show');
});

// ===== MEMBERSHIPS =====
async function requestMembership(el) {
  const user = getCurrentUser();
  if (!user) { showToast('👤 Please login first'); return; }
  const tier = el.dataset.tier;
  const amount = parseInt(el.dataset.amount);
  try {
    await postMembership({ tier, amount });
    showToast('✅ ' + tier + ' request sent to admin!');
  } catch (e) {
    if (e.status === 409) showToast('⚠️ Request already sent for ' + tier);
    else showToast('⚠️ ' + (e.data && e.data.error ? e.data.error : 'Error sending request'));
  }
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
function closeConvertModal() {
  document.getElementById('convertModal').classList.remove('show');
}

async function convertPoints(e) {
  e.preventDefault();
  const user = getCurrentUser();
  if (!user) return;
  const pts = parseInt(document.getElementById('convertAmount').value);
  if (!pts || pts < 10) { document.getElementById('convertError').textContent = 'Minimum 10 points'; return; }
  if (pts > (user.points || 0)) { document.getElementById('convertError').textContent = 'Not enough points'; return; }
  try {
    const r = await api('/api/accounts/' + user.id + '/convert-points', { method: 'POST', body: JSON.stringify({ points: pts }) });
    saveUser(r.account);
    closeConvertModal();
    applyAuthUI();
    showToast('🪙 Converted ' + pts + ' pts → ' + r.egp + ' EGP');
  } catch (e) {
    document.getElementById('convertError').textContent = e.data && e.data.error ? e.data.error : 'Error converting';
  }
}

// ===== FAVORITE GAME =====
function openFavoriteGame() {
  const user = getCurrentUser();
  if (!user) { showToast('👤 Please login first'); return; }
  closeUserDropdown();
  const fav = document.getElementById('favGameSelect');
  fav.value = user.favorite_game || '';
  document.getElementById('favGameError').textContent = '';
  document.getElementById('favGameModal').classList.add('show');
}
function closeFavoriteGame() {
  document.getElementById('favGameModal').classList.remove('show');
}
async function saveFavoriteGame(e) {
  e.preventDefault();
  const user = getCurrentUser();
  if (!user) return;
  const game = document.getElementById('favGameSelect').value;
  try {
    const acc = await patchAccount(user.id, { favorite_game: game });
    saveUser({ ...user, favorite_game: acc.favorite_game });
    closeFavoriteGame();
    showToast('🎮 Favorite game saved');
} catch (err) {
    document.getElementById('favGameError').textContent = 'Error saving';
  }
}

// ===== SUGGEST A GAME =====
function openSuggestGame() {
  const user = getCurrentUser();
  if (!user) { showToast('👤 Please login first'); return; }
  closeUserDropdown();
  document.getElementById('suggestGameName').value = '';
  document.getElementById('suggestGameImage').value = '';
  document.getElementById('suggestError').textContent = '';
  document.getElementById('suggestModal').classList.add('show');
}
function closeSuggestGame() {
  document.getElementById('suggestModal').classList.remove('show');
}
async function submitSuggestion(e) {
  e.preventDefault();
  const user = getCurrentUser();
  if (!user) return;
  const name = document.getElementById('suggestGameName').value.trim();
  const errEl = document.getElementById('suggestError');
  if (!name) { errEl.textContent = 'Game name is required'; return; }
  const file = document.getElementById('suggestGameImage').files[0];
  let image = '';
  if (file) {
    if (file.size > 2000000) { errEl.textContent = 'Image too large (max 2MB)'; return; }
    image = await new Promise(resolve => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => resolve('');
      fr.readAsDataURL(file);
    });
    if (!image.startsWith('data:image/')) { errEl.textContent = 'Invalid image'; return; }
  }
  errEl.textContent = '';
  try {
    const r = await api('/api/suggestions', { method: 'POST', body: JSON.stringify({ game_name: name, image }) });
    closeSuggestGame();
    showToast(r.already_in_library && r.existing
      ? '💡 Thanks — "' + name + '" is already in the library'
      : '💡 Suggestion sent! Our team will review it.');
  } catch (err) {
    if (err.status === 401) { closeSuggestGame(); showToast('👤 Please login first'); }
    else errEl.textContent = err.data && err.data.error ? err.data.error : 'Error submitting';
  }
}

// ===== MY BOOKINGS =====
function openMyBookings() {
  closeUserDropdown();
  const list = document.getElementById('myBookingsList');
  list.innerHTML = '<p style="color:#888;text-align:center;">Loading...</p>';
  document.getElementById('myBookingsModal').classList.add('show');
  getBookings().then(rows => {
    const mine = rows || [];
    if (!mine.length) { list.innerHTML = '<p style="color:#888;text-align:center;">No bookings yet</p>'; return; }
    const LABEL = { pending: '⏳ Pending', active: '🔴 Active', completed: '✓ Completed', cancelled: '❌ Cancelled' };
list.innerHTML = mine.map(b => {
      const pcs = (() => { try { return JSON.parse(b.pcs || '[]').join(', '); } catch { return b.pcs || ''; } })();
      const paid = Number(b.balance_paid) > 0;
      const canc = b.status === 'pending' ? `<button class="cancel-bt" onclick="cancelMyBooking(${b.id}, this)" ${paid ? 'data-paid="1" data-amount="' + Number(b.balance_paid) + '"' : ''}>✕ Cancel</button>` : '';
      return `<div class="my-booking">
        <div><strong>${escHtml(b.name)}</strong> · ${escHtml(pcs)}</div>
        <div class="my-booking-meta">${escHtml(b.date)} ${escHtml(b.time)} · ${b.duration || 'Open'} min${paid ? ' · 💳 ' + Number(b.balance_paid) + ' EGP paid' : ''}</div>
        <span class="my-booking-status">${LABEL[b.status] || b.status}</span>${canc}
      </div>`;
    }).join('');
  }).catch(() => { list.innerHTML = '<p style="color:#888;text-align:center;">Error loading</p>'; });
}
async function cancelMyBooking(id, btn) {
  const paid = btn && btn.dataset.paid === '1';
  if (!confirm('Cancel this reservation?' + (paid ? '\n\nThe ' + Number(btn.dataset.amount) + ' EGP you paid will be refunded to your balance.' : ''))) return;
  try {
    await api('/api/bookings/' + id, { method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }) });
    showToast(paid ? '✕ Cancelled — your balance was refunded' : '✕ Booking cancelled');
    openMyBookings();
    refreshDevices();
    refreshUserData();
  } catch (err) {
    showToast((err.data && err.data.error) || 'Cannot cancel — it may have already started', true);
  }
}
function closeMyBookings() {
  document.getElementById('myBookingsModal').classList.remove('show');
}

// ===== ACTIVE MEMBERSHIP FRAME =====
const TIER_COLORS = { BRONZE: '#cd7f32', SILVER: '#c0c0c0', GOLD: '#ffd700', DIAMOND: '#00ffff' };

async function applyMembershipFrame() {
  const avatar = document.getElementById('userAvatar');
  if (!avatar) return;
  const user = getCurrentUser();
  if (!user) { avatar.style.border = ''; avatar.style.boxShadow = ''; return; }
  try {
    const approved = [];
    try { (await getMemberships()).forEach(m => { if (m.account_id === user.id && m.status === 'approved') approved.push(m); }); } catch {}
    approved.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const tier = approved[0] && approved[0].tier;
    if (tier && TIER_COLORS[tier]) {
      avatar.style.border = '3px solid ' + TIER_COLORS[tier];
      avatar.style.boxShadow = '0 0 12px ' + TIER_COLORS[tier] + '88';
    } else {
      avatar.style.border = '2px solid #6a00ff';
      avatar.style.boxShadow = 'none';
    }
  } catch {}
}

function applyAuthUI() {
  const user = getCurrentUser();
  const menu = document.getElementById('userMenu');
  const avatar = document.getElementById('userAvatar');
  const name = document.getElementById('dropdownName');
  const bal = document.getElementById('dropdownBalance');
  const pts = document.getElementById('dropdownPoints');

  if (user) {
    if (!user.balance) user.balance = 0;
    if (!user.points) user.points = 0;
    saveUser(user);
    const heroBtn = document.getElementById('heroLoginBtn');
    if (heroBtn) heroBtn.style.display = 'none';
    menu.style.display = 'inline-flex';
    avatar.src = user.avatar || 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#6a00ff"/><text x="16" y="21" text-anchor="middle" fill="#fff" font-family="Arial" font-size="16" font-weight="bold">' + (user.name || '?').charAt(0).toUpperCase() + '</text></svg>');
    const camIcon = document.querySelector('.avatar-edit');
    if (camIcon) camIcon.style.display = user.avatar ? 'none' : 'flex';
    name.textContent = user.name;
    if (bal) bal.textContent = user.balance;
    if (pts) pts.textContent = user.points;

    const ib = document.getElementById('inlineBalance');
    const ip = document.getElementById('inlinePoints');
    if (ib) ib.textContent = user.balance;
    if (ip) ip.textContent = user.points;

const bRow = document.getElementById('bookingNameRow');
    if (bRow) bRow.style.display = 'none';
    document.getElementById('bookingName').value = user.name;
    document.getElementById('bookingPhone').value = user.phone;

    applyMembershipFrame();
    updatePricePreview();
  } else {
    const heroBtn = document.getElementById('heroLoginBtn');
    if (heroBtn) heroBtn.style.display = '';
    if (menu) menu.style.display = 'none';
const bRow = document.getElementById('bookingNameRow');
    if (bRow) bRow.style.display = '';
    updatePricePreview();
  }
}

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
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    fetch(API_BASE + '/api/auth/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({}) }).catch(() => {});
  };
  beat();
  heartbeatTimer = setInterval(beat, 30000);
}
function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    try { navigator.sendBeacon(API_BASE + '/api/auth/heartbeat?token=' + encodeURIComponent(token), JSON.stringify({ offline: true })); } catch {}
  }
}
window.addEventListener('beforeunload', () => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    try { navigator.sendBeacon(API_BASE + '/api/auth/heartbeat?token=' + encodeURIComponent(token), JSON.stringify({ offline: true })); } catch {}
  }
});

function escHtml(s) {
  if (s == null) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ===== INIT =====
(async function init() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) {
    try {
      const r = await api('/api/auth/me');
      if (r.account) {
        saveUser(r.account);
        applyAuthUI();
        startHeartbeat();
      } else {
        clearSession();
      }
    } catch (e) {
      if (e.status === 401) clearSession();
    }
  }
  applyAuthUI();
  connectRealtime();
  await getDevices();
  renderOccupiedPCs();
  renderPcGrid(_deviceCache);
  await loadContent();
  applyWebsiteContent();
  if (getCurrentUser()) startHeartbeat();
  loadPackages();
  updatePricePreview();
})();/* =========================================
   WEBSITE CONTENT MANAGER (CMS � PART 2)
   Renders site sections from /api/content,
   updates live when the server broadcasts
   content_changed over WebSocket.
   ========================================= */
let contentCache = {};
const _appliedHashes = {};
let _liveSettings = {};

async function loadContent() {
  try {
    const r = await api('/api/content');
    contentCache = r.content || {};
  } catch {}
}

function _memo(key, renderFn) {
  const h = JSON.stringify(contentCache[key] == null ? null : contentCache[key]);
  if (_appliedHashes[key] === h) return;
  _appliedHashes[key] = h;
  try { renderFn(contentCache[key]); } catch {}
}

function sectionEl(key) {
  return document.getElementById(key);
}
function setSectionHeading(section, label, titleBefore, glow) {
  if (!section) return;
  const lb = section.querySelector('.section-label');
  const tt = section.querySelector('.section-title');
  if (lb && label != null) lb.textContent = label;
  if (tt) {
    if (titleBefore != null && glow != null) tt.innerHTML = escapeHtml(titleBefore) + ' <span class="glow-text">' + escapeHtml(glow) + '</span>';
    else if (titleBefore != null) tt.textContent = titleBefore;
  }
}
function applySite(v) {
  if (!v) return;
  if (v.title) document.title = v.title;
  const navBrand = document.querySelector('.nav-brand');
  if (navBrand) navBrand.textContent = (v.icon || '?') + ' ' + (v.navBrand || 'GZG');
  const lp = document.getElementById('logoTitle');
  if (lp && v.name) lp.textContent = v.name;
  const ls = document.getElementById('logoSub');
  if (ls && v.sub) ls.textContent = v.sub;
  const li = document.getElementById('logoIcon');
  if (li) li.innerHTML = v.logoImage ? '<img src="' + escapeAttr(v.logoImage) + '" alt="logo" style="height:56px;max-width:220px;object-fit:contain;"/>' : escapeHtml(v.icon || '?');
  const fl = document.getElementById('footerLogo');
  if (fl) fl.textContent = (v.icon || '?') + ' ' + (v.footerName || '');
}
function applyHero(v) {
  if (!v) return;
  const tag = document.getElementById('heroTagline');
  if (tag) tag.textContent = v.tagline;
  const bg = document.getElementById('heroBg');
  if (bg) bg.style.backgroundImage = v.bgImage ? 'url("' + escapeAttr(v.bgImage) + '")' : '';
  const book = document.getElementById('bookPcBtn');
  if (book) {
    book.style.display = v.btnBook && v.btnBook.visible === false ? 'none' : '';
    if (v.btnBook && v.btnBook.label) book.textContent = v.btnBook.label;
    if (v.btnBook && v.btnBook.href) book.setAttribute('href', v.btnBook.href);
  }
  const login = document.getElementById('heroLoginBtn');
  if (login) {
    login.style.display = v.btnLogin && v.btnLogin.visible === false ? 'none' : '';
    if (v.btnLogin && v.btnLogin.label) login.textContent = v.btnLogin.label;
  }
  const statsEl = document.getElementById('heroStats');
  if (statsEl && Array.isArray(v.stats)) {
    statsEl.innerHTML = v.stats.map((s, i) =>
      (i ? '<div class="stat-divider"></div>' : '') +
      '<div class="stat"><span class="stat-num">' + escapeHtml(s.num) + '</span><span class="stat-label">' + escapeHtml(s.label) + '</span></div>'
    ).join('');
  }
}
function applyFeatures(v) {
  if (!v) return;
  const sec = document.querySelector('.features-section');
  setSectionHeading(sec, v.label, v.titleBefore, v.titleGlow);
  const grid = document.getElementById('featuresGrid');
  if (grid && Array.isArray(v.cards)) {
    grid.innerHTML = v.cards.map(c => '<div class="feature-card"><div class="feature-icon">' + (c.icon || '') + '</div><h3>' + escapeHtml(c.title) + '</h3><p>' + escapeHtml(c.desc) + '</p></div>').join('');
  }
}
function applyBooking(v) {
  if (!v) return;
  const sec = sectionEl('booking');
  setSectionHeading(sec, v.label, v.titleBefore, v.titleGlow);
  const dt = document.getElementById('depositTitle');
  if (dt && v.depositTitle) dt.textContent = v.depositTitle;
  const dx = document.getElementById('depositText');
  if (dx && v.depositText) dx.textContent = String(v.depositText).replace('{deposit}', _liveSettings.deposit || 50);
  const sb = document.getElementById('bookingSubmit');
  if (sb && v.submit) sb.textContent = v.submit;
}
function applyPrices(v) {
  if (!v) return;
  const sec = sectionEl('prices');
  setSectionHeading(sec, v.label, v.titleBefore, v.titleGlow);
  const grid = document.getElementById('pricesGrid');
  if (!grid || !Array.isArray(v.cards)) return;
  grid.innerHTML = v.cards.map(card => {
    const variant = ['standard', 'vip', 'addons'].includes(card.variant) ? card.variant : '';
    return '<div class="price-card ' + variant + '">' +
      (card.crown ? '<div class="vip-crown">' + escapeHtml(card.crown) + '</div>' : '') +
      '<div class="price-card-header"><span class="price-type-icon">' + (card.icon || '') + '</span><h3>' + escapeHtml(card.title) + '</h3></div>' +
      '<div class="price-items">' + (card.rows || []).map(r =>
        '<div class="price-row' + (r.featured ? ' featured' : '') + '"><span>' + escapeHtml(r.label) + '</span><span class="price-val">' + escapeHtml(r.prefix || '') + (r.price == null ? '' : r.price) + (r.suffix ? ' <small>' + escapeHtml(r.suffix) + '</small>' : '') + '</span></div>'
      ).join('') + '</div></div>';
  }).join('');
}
const _TIER_CLS = { bronze: 'bronze', silver: 'silver', gold: 'gold', diamond: 'diamond' };
function applyOffers(v) {
  if (!v) return;
  const sec = sectionEl('offers');
  setSectionHeading(sec, v.label, v.titleBefore, v.titleGlow);
  const grid = document.getElementById('offersGrid');
  if (!grid || !Array.isArray(v.cards)) return;
  grid.innerHTML = v.cards.map(o => {
    const tc = _TIER_CLS[String(o.tier || '').toLowerCase()] || '';
    return '<div class="offer-card ' + tc + '">' +
      '<div class="offer-badge ' + tc + '-badge">' + escapeHtml(o.badge) + '</div>' +
      '<div class="offer-amount">' + escapeHtml(o.amount) + ' <span>' + escapeHtml(o.amountSuffix) + '</span></div>' +
      '<div class="offer-desc">' + escapeHtml(o.desc) + '</div>' +
      '<div class="offer-bonus"><span class="bonus-label">' + escapeHtml(o.bonusLabel) + '</span><span class="bonus-val">' + escapeHtml(o.bonus) + '</span></div>' +
      '<div class="offer-total">Total Value: <strong>' + escapeHtml(o.total) + '</strong></div>' +
      '<a href="javascript:void(0)" class="btn-offer ' + tc + '-btn membership-btn" data-tier="' + escapeAttr(o.tier) + '" data-amount="' + (o.amountData == null ? '' : o.amountData) + '" onclick="requestMembership(this)">' + escapeHtml(o.btn) + '</a>' +
      '</div>';
  }).join('');
}
function applyGames(v) {
  if (!v) return;
  const sec = sectionEl('games');
  setSectionHeading(sec, v.label, v.titleBefore, v.titleGlow);
  const tabs = Array.isArray(v.tabs) ? v.tabs : [];
  for (const t of tabs) {
    if (!t.id) continue;
    const btn = document.querySelector('#gameTabs .tab-btn[data-tab="' + t.id + '"]');
    if (btn && t.label != null) btn.textContent = (t.icon || '') + ' ' + t.label;
    const panel = document.getElementById('tab-' + t.id);
    const grid = panel ? panel.querySelector('.games-grid') : null;
    if (grid && Array.isArray(t.games)) {
      grid.innerHTML = t.games.map(g => {
        const img = g.image ? '<img src="' + escapeAttr(g.image) + '" alt="' + escapeAttr(g.name) + '" class="game-img"/>' : '<span class="game-icon">' + (g.icon || '??') + '</span>';
        return '<div class="game-card">' + img + '<span>' + escapeHtml(g.name) + '</span></div>';
      }).join('');
    }
  }
  // populate favorite-game dropdown from the library when it exists
  const fav = document.getElementById('favGameSelect');
  if (fav && tabs.length) {
    const names = [];
    tabs.forEach(t => (t.games || []).forEach(g => { if (g.name && !names.includes(g.name)) names.push(g.name); }));
    if (names.length) {
      const favH = JSON.stringify(names);
      if (fav.dataset.list !== favH) {
        fav.dataset.list = favH;
        const cur = fav.value;
        fav.innerHTML = '<option value="">� Select a game �</option>' + names.map(n => '<option>' + escapeHtml(n) + '</option>').join('') + '<option>Other</option>';
        if (cur) fav.value = cur;
      }
    }
  }
}
function applyContact(v) {
  if (!v) return;
  const sec = sectionEl('contact');
  setSectionHeading(sec, v.label, v.titleBefore, v.titleGlow);
  const card = document.getElementById('contactCard');
  if (card && Array.isArray(v.items)) {
    card.innerHTML = v.items.map(it => {
      const icon = '<span class="contact-icon">' + (it.icon || '') + '</span>';
      const body = '<div><strong>' + escapeHtml(it.title) + '</strong><span>' + escapeHtml(it.value) + '</span></div>';
      if (it.type === 'link') {
        const target = String(it.href || '').indexOf('tel:') === 0 ? '' : ' target="_blank"';
        return '<a href="' + escapeAttr(it.href || '#') + '"' + target + ' class="contact-item">' + icon + body + '</a>';
      }
      return '<div class="contact-item no-link">' + icon + body + '</div>';
    }).join('');
  }
  const mapEl = document.getElementById('mapLink');
  if (mapEl && v.map && v.map.url) mapEl.setAttribute('href', v.map.url);
  const mapImg = document.getElementById('mapImg');
  if (mapImg && v.map && v.map.image) mapImg.src = v.map.image;
}
function applyFooter(v) {
  if (!v) return;
  const ft = document.getElementById('footerText');
  if (ft) ft.textContent = v.text;
  const links = document.getElementById('footerLinks');
  if (links && Array.isArray(v.links)) {
    links.innerHTML = v.links.map(l => '<a href="' + escapeAttr(l.href) + '">' + escapeHtml(l.label) + '</a>').join('');
  }
  const cp = document.getElementById('footerCopy');
  if (cp) cp.textContent = v.copy;
}
function applySections(v) {
  if (!v) return;
  const hidden = Array.isArray(v.hidden) ? v.hidden : [];
  const order = Array.isArray(v.order) && v.order.length ? v.order : ['features', 'booking', 'prices', 'offers', 'games', 'contact'];
  const map = {
    features: () => document.querySelector('.features-section'),
    booking: () => sectionEl('booking'),
    prices: () => sectionEl('prices'),
    offers: () => sectionEl('offers'),
    games: () => sectionEl('games'),
    contact: () => sectionEl('contact'),
  };
  for (const id of Object.keys(map)) {
    const el = map[id]();
    if (!el) continue;
    el.style.display = hidden.includes(id) ? 'none' : '';
    document.querySelectorAll('#navbar a[href="#' + id + '"], #navMobile a[href="#' + id + '"]').forEach(a => { a.style.display = hidden.includes(id) ? 'none' : ''; });
  }
  // apply ordering (only when explicitly provided)
  const els = order.map(id => map[id]()).filter(Boolean);
  if (els.length > 1 && hidden.length === 0) {
    const footer = document.querySelector('footer');
    const frag = document.createDocumentFragment();
    // sender is moved in order; keep the header wrapper at top
    const wrapper = document.querySelector('div[data-section="home"]');
    for (const el of els) frag.appendChild(el);
    if (wrapper && wrapper.parentNode) wrapper.parentNode.insertBefore(frag, footer);
    else document.body.insertBefore(frag, footer);
  }
}
function applyContentSection(key) {
  switch (key) {
    case 'site': _memo('site', applySite); break;
    case 'hero': _memo('hero', applyHero); break;
    case 'features': _memo('features', applyFeatures); break;
    case 'booking': _memo('booking', applyBooking); break;
    case 'prices': _memo('prices', applyPrices); break;
    case 'offers': _memo('offers', applyOffers); break;
    case 'games': _memo('games', applyGames); break;
    case 'contact': _memo('contact', applyContact); break;
    case 'footer': _memo('footer', applyFooter); break;
    case 'sections': _memo('sections', applySections); break;
  }
}
function applyWebsiteContent() {
  for (const k of ['site', 'hero', 'features', 'booking', 'prices', 'offers', 'games', 'contact', 'footer', 'sections']) applyContentSection(k);
}
function escapeAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ===== DYNAMIC PC GRID (devices added by admin appear here) =====
async function renderPcGrid(devices) {
  const grid = document.getElementById('pcGrid');
  if (!grid) return;
  const devs = devices || _deviceCache || [];
  if (!devs.length) return;
  const std = devs.filter(d => d.type === 'standard').map(d => d.pc);
  const vip = devs.filter(d => d.type === 'vip').map(d => d.pc);
  const hash = JSON.stringify({ std, vip });
  if (grid.dataset.hash === hash) return;
  grid.dataset.hash = hash;
  const chip = (pc, cls) => '<label class="pc-chip' + cls + '"><input type="checkbox" value="' + escapeAttr(pc) + '"/> ' + escapeHtml(pc) + '</label>';
  grid.innerHTML =
    '<div class="pc-group-label">Standard</div>' + std.map(p => chip(p, '')).join('') +
    (vip.length ? '<div class="pc-group-label vip">VIP ??</div>' + vip.map(p => chip(p, ' vip')).join('') : '');
  updateConflictDisplay();
}
