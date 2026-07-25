import { LIMITS, addFunpayMarkup, calculateBoost, createOrderMessage, formatRubles } from './calculator.js';

const $ = (selector, root = document) => root.querySelector(selector);
const THEME_KEY = 'miracle-boost-theme';
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const elements = {
  current: $('#current-elo'),
  target: $('#target-elo'),
  range: $('#target-range'),
  targetOutput: $('#target-output'),
  addons: $$('[data-option]'),
  validation: $('#validation-message'),
  total: $('#total-price'),
  priceWrap: $('.summary__price'),
  difference: $('#elo-difference'),
  steps: $('#steps-line'),
  base: $('#base-line'),
  markup: $('#markup-line'),
  siteTotal: $('#site-total-line'),
  funpay: $('#funpay-line'),
  funpayToggle: $('#funpay-toggle'),
  funpayOrder: $('#funpay-order'),
  progress: $('[data-progress]'),
  orderOpen: $('#order-open'),
  orderModal: $('[data-order-modal]'),
  orderForm: $('[data-order-form]'),
  orderPreview: $('[data-order-preview]'),
  orderStatus: $('[data-order-status]'),
  toast: $('[data-toast]'),
  menuToggle: $('[data-menu-toggle]'),
  nav: $('[data-nav]'),
  header: $('[data-header]'),
  themeToggle: $('[data-theme-toggle]'),
  themeLabel: $('[data-theme-label]'),
  themeColor: $('[data-theme-color]'),
};

let currentMessage = '';
let currentOrderPayload = null;
let toastTimer;


function preferredTheme() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function savedTheme() {
  return localStorage.getItem(THEME_KEY) || '';
}

function applyTheme(theme) {
  const nextTheme = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = nextTheme;
  document.documentElement.style.colorScheme = nextTheme;

  if (elements.themeColor) {
    elements.themeColor.setAttribute('content', nextTheme === 'dark' ? '#121722' : '#910029');
  }

  if (elements.themeToggle) {
    const isDark = nextTheme === 'dark';
    elements.themeToggle.setAttribute('aria-pressed', String(isDark));
    elements.themeToggle.setAttribute('aria-label', isDark ? 'Включить светлую тему' : 'Включить тёмную тему');
  }

  if (elements.themeLabel) {
    elements.themeLabel.textContent = nextTheme === 'dark' ? 'Тёмная' : 'Светлая';
  }
}


function setupAmbientMotion() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  let frame = 0;
  let nextX = 50;
  let nextY = 18;

  const update = () => {
    frame = 0;
    document.documentElement.style.setProperty('--pointer-x', `${nextX}%`);
    document.documentElement.style.setProperty('--pointer-y', `${nextY}%`);
  };

  window.addEventListener('pointermove', (event) => {
    nextX = Math.round((event.clientX / window.innerWidth) * 100);
    nextY = Math.round((event.clientY / window.innerHeight) * 100);
    if (!frame) frame = requestAnimationFrame(update);
  }, { passive: true });
}

function setupMicroInteractions() {
  document.documentElement.classList.add('is-booted');

  $$('.step, .benefit-card, .addon, .review-panel').forEach((item, index) => {
    item.style.setProperty('--stagger', `${Math.min(index, 8) * 55}ms`);
  });
}


function setupSpotlightCards() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

  const cards = $$('.calculator-layout, .step, .benefit-card, .review-panel, .safe-deal');
  cards.forEach((card) => {
    card.setAttribute('data-spotlight-card', '');
    if (!card.querySelector(':scope > .spotlight-layer')) {
      const layer = document.createElement('span');
      layer.className = 'spotlight-layer';
      layer.setAttribute('aria-hidden', 'true');
      card.prepend(layer);
    }

    card.addEventListener('pointermove', (event) => {
      const rect = card.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;
      card.style.setProperty('--spotlight-x', `${x.toFixed(2)}%`);
      card.style.setProperty('--spotlight-y', `${y.toFixed(2)}%`);
      card.classList.add('is-spotlight-active');
    }, { passive: true });

    card.addEventListener('pointerleave', () => {
      card.classList.remove('is-spotlight-active');
    });
  });
}

function setupTheme() {
  applyTheme(savedTheme() || document.documentElement.dataset.theme || preferredTheme());

  elements.themeToggle?.addEventListener('click', () => {
    const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, nextTheme);
    applyTheme(nextTheme);
  });

  if (window.matchMedia) {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener?.('change', (event) => {
      if (!savedTheme()) applyTheme(event.matches ? 'dark' : 'light');
    });
  }
}

function pulsePrice() {
  if (!elements.priceWrap) return;
  elements.priceWrap.classList.remove('is-updating');
  void elements.priceWrap.offsetWidth;
  elements.priceWrap.classList.add('is-updating');
}

function selectedAddons() {
  return elements.addons
    .filter((input) => input.checked && !input.matches('[data-funpay-option]'))
    .map((input) => ({
      label: input.dataset.option,
      rate: Number(input.value),
    }));
}

function updateRangeFill(value) {
  const percent = ((value - LIMITS.minTarget) / (LIMITS.maxTarget - LIMITS.minTarget)) * 100;
  elements.range.style.setProperty('--range-progress', `${percent}%`);
}

function renderCalculator({ persist = true } = {}) {
  const addons = selectedAddons();
  const result = calculateBoost(elements.current.value, elements.target.value, addons);

  elements.current.value = result.current;
  elements.target.value = result.target;
  elements.range.value = result.target;
  elements.targetOutput.value = `${result.target} ELO`;
  updateRangeFill(result.target);

  elements.validation.textContent = result.error;
  elements.difference.textContent = result.difference.toLocaleString('ru-RU');
  elements.steps.textContent = result.stepCount.toLocaleString('ru-RU');
  elements.base.textContent = `${formatRubles(result.basePrice)} ₽`;
  elements.markup.textContent = `${formatRubles(result.markupPrice)} ₽`;

  const funpaySelected = Boolean(elements.funpayToggle?.dataset.active === 'true');
  const funpay = addFunpayMarkup(result.totalPrice);
  const finalPrice = funpaySelected ? funpay.total : result.totalPrice;
  const funpayLineText = funpaySelected ? `${formatRubles(funpay.markup)} ₽` : 'не выбрано';

  elements.siteTotal.textContent = `${formatRubles(result.totalPrice)} ₽`;
  elements.funpay.textContent = funpayLineText;

  if (elements.total.textContent !== formatRubles(finalPrice)) pulsePrice();
  elements.total.textContent = formatRubles(finalPrice);

  elements.funpayToggle?.setAttribute('aria-pressed', String(funpaySelected));
  if (elements.funpayToggle) {
    elements.funpayToggle.textContent = funpaySelected ? 'Убрать FunPay +5%' : 'Добавить FunPay +5%';
  }

  const progress = result.valid ? Math.min(100, (result.target / LIMITS.maxTarget) * 100) : 0;
  elements.progress.style.width = `${progress}%`;

  currentOrderPayload = { ...result, addons, funpayDeal: funpaySelected, funpayMarkup: funpaySelected ? funpay.markup : 0, sitePrice: result.totalPrice, finalPrice };

  if (result.valid) {
    currentMessage = createOrderMessage(result, addons, { funpay: funpaySelected, funpayMarkup: funpaySelected ? funpay.markup : 0, finalPrice });
    elements.orderOpen?.removeAttribute('disabled');
    elements.orderOpen?.classList.remove('is-disabled');
  } else {
    currentMessage = '';
    elements.orderOpen?.setAttribute('disabled', '');
    elements.orderOpen?.classList.add('is-disabled');
  }

  if (persist) {
    const state = {
      current: result.current,
      target: result.target,
      addons: elements.addons.filter((input) => input.checked).map((input) => input.dataset.option),
      funpayDeal: funpaySelected,
    };
    localStorage.setItem('miracle-boost-calculator', JSON.stringify(state));
  }
}

function restoreCalculator() {
  try {
    const saved = JSON.parse(localStorage.getItem('miracle-boost-calculator'));
    if (!saved) return;

    elements.current.value = saved.current ?? elements.current.value;
    elements.target.value = saved.target ?? elements.target.value;
    elements.addons.forEach((input) => {
      input.checked = Array.isArray(saved.addons) && saved.addons.includes(input.dataset.option);
    });
    if (elements.funpayToggle) {
      elements.funpayToggle.dataset.active = saved.funpayDeal ? 'true' : 'false';
    }
  } catch {
    localStorage.removeItem('miracle-boost-calculator');
  }
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('is-visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('is-visible'), 1800);
}


async function request(url, options = {}) {
  const response = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Ошибка сервера');
  return data;
}

function openOrderModal() {
  if (!currentOrderPayload?.valid) return showToast('Сначала укажите корректное ELO');
  const addonsText = currentOrderPayload.addons.length ? currentOrderPayload.addons.map((a) => `${a.label} +${Math.round(a.rate * 100)}%`).join(', ') : 'без доп. условий';
  elements.orderPreview.innerHTML = `<strong>${currentOrderPayload.current} → ${currentOrderPayload.target} ELO</strong><span>${addonsText}</span><b>${formatRubles(currentOrderPayload.finalPrice)} ₽</b>`;
  elements.orderStatus.textContent = '';
  elements.orderModal.hidden = false;
  document.documentElement.classList.add('has-modal');
  elements.orderModal.querySelector('input')?.focus();
}

function closeOrderModal() {
  elements.orderModal.hidden = true;
  document.documentElement.classList.remove('has-modal');
}

async function submitOrder(event) {
  event.preventDefault();
  const formData = new FormData(elements.orderForm);
  const button = elements.orderForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const data = await request('/api/orders', { method: 'POST', body: JSON.stringify({ telegram: formData.get('telegram'), email: formData.get('email'), comment: formData.get('comment'), calculation: currentOrderPayload }) });
    elements.orderStatus.textContent = `Заказ ${data.order?.number || ''} отправлен.`;
    showToast('Заказ отправлен в админ-панель');
    elements.orderForm.reset();
    setTimeout(closeOrderModal, 1200);
  } catch (error) {
    elements.orderStatus.textContent = error.message;
  } finally { button.disabled = false; }
}

function setupMenu() {
  elements.menuToggle.addEventListener('click', () => {
    const isOpen = elements.nav.classList.toggle('is-open');
    elements.menuToggle.classList.toggle('is-open', isOpen);
    elements.menuToggle.setAttribute('aria-expanded', String(isOpen));
    elements.menuToggle.setAttribute('aria-label', isOpen ? 'Закрыть меню' : 'Открыть меню');
  });

  $$('a', elements.nav).forEach((link) => {
    link.addEventListener('click', () => {
      elements.nav.classList.remove('is-open');
      elements.menuToggle.classList.remove('is-open');
      elements.menuToggle.setAttribute('aria-expanded', 'false');
      elements.menuToggle.setAttribute('aria-label', 'Открыть меню');
    });
  });
}

function setupReveal() {
  const items = $$('.reveal');
  if (!('IntersectionObserver' in window)) {
    items.forEach((item) => item.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.08, rootMargin: '0px 0px -8% 0px' },
  );

  items.forEach((item) => observer.observe(item));
}

function setupHeader() {
  const sync = () => elements.header.classList.toggle('is-scrolled', window.scrollY > 16);
  sync();
  window.addEventListener('scroll', sync, { passive: true });
}

function setupCalculatorEvents() {
  elements.current.addEventListener('input', () => renderCalculator());
  elements.target.addEventListener('input', () => renderCalculator());
  elements.range.addEventListener('input', () => {
    elements.target.value = elements.range.value;
    renderCalculator();
  });
  elements.addons.forEach((input) => input.addEventListener('change', () => renderCalculator()));
  elements.funpayToggle?.addEventListener('click', () => {
    const isActive = elements.funpayToggle.dataset.active === 'true';
    elements.funpayToggle.dataset.active = String(!isActive);
    renderCalculator();
  });
  elements.funpayOrder?.addEventListener('click', () => {
    if (elements.funpayToggle) {
      elements.funpayToggle.dataset.active = 'true';
      renderCalculator();
    }
  });
  elements.orderOpen?.addEventListener('click', openOrderModal);
  elements.orderForm?.addEventListener('submit', submitOrder);
  document.querySelectorAll('[data-order-close]').forEach((el) => el.addEventListener('click', closeOrderModal));
}

setupMicroInteractions();
setupSpotlightCards();
setupAmbientMotion();
setupTheme();
restoreCalculator();
setupMenu();
setupReveal();
setupHeader();
setupCalculatorEvents();
renderCalculator({ persist: false });

const yearElement = $('[data-year]');
if (yearElement) yearElement.textContent = new Date().getFullYear();
