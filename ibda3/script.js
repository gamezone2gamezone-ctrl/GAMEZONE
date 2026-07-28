// ===== NAVBAR =====
const navbar = document.getElementById('navbar');
const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');
const navMobile = document.getElementById('navMobile');

window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 30);
});

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

// ===== ACTIVE NAV LINK =====
const sections = document.querySelectorAll('section[id]');
const navAll = document.querySelectorAll('.nav-links a');
const sectionObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      navAll.forEach(l => l.classList.remove('active'));
      const link = document.querySelector(`.nav-links a[href="#${entry.target.id}"]`);
      if (link) link.classList.add('active');
    }
  });
}, { threshold: 0.3 });
sections.forEach(s => sectionObserver.observe(s));

// ===== SMOOTH SCROLL =====
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (target) { e.preventDefault(); target.scrollIntoView({ behavior: 'smooth' }); }
  });
});

// ===== TYPING EFFECT =====
const typingEl = document.getElementById('typingText');
const words = ['ibda3.', 'إبداع.', 'Creativity.'];
let wordIndex = 0;
let charIndex = 0;
let isDeleting = false;
let typeTimeout;

function typeEffect() {
  if (!typingEl) return;
  const current = words[wordIndex];
  if (!isDeleting) {
    typingEl.textContent = current.substring(0, charIndex + 1);
    charIndex++;
    if (charIndex === current.length) {
      isDeleting = true;
      typeTimeout = setTimeout(typeEffect, 2000);
      return;
    }
    typeTimeout = setTimeout(typeEffect, 100);
  } else {
    typingEl.textContent = current.substring(0, charIndex - 1);
    charIndex--;
    if (charIndex === 0) {
      isDeleting = false;
      wordIndex = (wordIndex + 1) % words.length;
      typeTimeout = setTimeout(typeEffect, 500);
      return;
    }
    typeTimeout = setTimeout(typeEffect, 50);
  }
}
typeEffect();

// ===== COUNTER ANIMATION =====
const counters = document.querySelectorAll('.stat-num');
const counterObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      const el = entry.target;
      const target = parseInt(el.dataset.target);
      let current = 0;
      const step = Math.ceil(target / 50);
      const timer = setInterval(() => {
        current += step;
        if (current >= target) { current = target; clearInterval(timer); }
        el.textContent = current + (target > 9 ? '+' : '+');
      }, 25);
      counterObserver.unobserve(el);
    }
  });
}, { threshold: 0.5 });
counters.forEach(c => counterObserver.observe(c));

// ===== REVEAL ON SCROLL =====
const revealEls = document.querySelectorAll('.s-card, .w-card, .uc-card, .why-card');
const revealObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });
revealEls.forEach(el => revealObserver.observe(el));

// ===== TOKEN CARD SELECTOR =====
function selectToken(uc, price, el) {
  const amount = document.getElementById('tokenAmount');
  const egp = document.getElementById('tokenEgp');
  const player = document.getElementById('tokenPlayer');

  amount.textContent = uc.toLocaleString();
  egp.innerHTML = price + ' <small>EGP</small>';
  player.textContent = 'PLAYER';

  document.querySelectorAll('.uc-card').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
}

// Select the popular package (325 UC) by default on load
document.addEventListener('DOMContentLoaded', () => {
  const popular = document.querySelector('.uc-card.popular');
  if (popular) selectToken(325, 65, popular);
});

// ===== CONTACT FORM =====
function submitContact(e) {
  e.preventDefault();
  const name = document.getElementById('cName').value;
  const phone = document.getElementById('cPhone').value;
  const service = document.getElementById('cService').value;
  const msg = document.getElementById('cMsg').value;
  const text = `*طلب جديد من ibda3*\n\n👤 الاسم: ${name}\n📞 الهاتف: ${phone}\n📌 الخدمة: ${service || 'غير محدد'}\n💬 الرسالة: ${msg || '—'}`;
  window.open(`https://wa.me/201006760663?text=${encodeURIComponent(text)}`, '_blank');
}
