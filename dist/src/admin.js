const THEME_KEY = 'miracle-boost-theme';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const STATUS_LABELS = {
  queue: 'В очереди',
  payment: 'Ожидание оплаты',
  boosting: 'Ведётся буст',
  done: 'Выполнен',
};
const STATUSES = Object.keys(STATUS_LABELS);

const e = {
  loginScreen: $('[data-login-screen]'),
  panel: $('[data-admin-panel]'),
  email: $('[data-login-email]'),
  password: $('[data-login-password]'),
  loginButton: $('[data-login-button]'),
  loginError: $('[data-login-error]'),
  logout: $('[data-logout]'),
  conversations: $('[data-conversations]'),
  orders: $('[data-orders]'),
  tabs: $$('[data-admin-tab]'),
  messages: $('[data-admin-messages]'),
  input: $('[data-admin-input]'),
  send: $('[data-admin-send]'),
  reply: $('.chat-admin__reply'),
  refresh: $('[data-refresh]'),
  title: $('[data-active-title]'),
  type: $('[data-active-type]'),
  status: $('[data-connection-status]'),
  themeToggle: $('[data-theme-toggle]'),
  themeLabel: $('[data-theme-label]'),
  themeIcon: $('[data-theme-icon]'),
};

let mode = 'orders';
let activeId = '';
let conversations = [];
let orders = [];
let timer;

const formatTime = (date) => new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(date));
const formatDateTime = (date) => new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(date));
const rub = (value) => `${Math.round(Number(value || 0)).toLocaleString('ru-RU')} ₽`;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

function isPriorityOrder(order) {
  if (order.isPriority || order.is_priority) return true;
  const addons = order.calculation?.addons;
  return Array.isArray(addons) && addons.some((addon) => String(addon.label || addon).toLowerCase().includes('приоритет'));
}

async function req(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Ошибка сервера');
  return data;
}

function applyTheme(theme) {
  const next = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  e.themeToggle?.setAttribute('aria-pressed', String(next === 'dark'));
  if (e.themeLabel) e.themeLabel.textContent = next === 'dark' ? 'Тёмная' : 'Светлая';
  if (e.themeIcon) e.themeIcon.textContent = next === 'dark' ? '☾' : '☀';
}

function setupTheme() {
  applyTheme(localStorage.getItem(THEME_KEY) || document.documentElement.dataset.theme || 'light');
  e.themeToggle?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

function showPanel() {
  e.loginScreen.hidden = true;
  e.panel.hidden = false;
  clearInterval(timer);
  timer = setInterval(loadAll, 3000);
}

function showLogin(message = '') {
  e.loginScreen.hidden = false;
  e.panel.hidden = true;
  e.loginError.textContent = message;
  clearInterval(timer);
}


async function verifySession() {
  try {
    await req('/api/admin/me');
    showPanel();
    await loadAll();
  } catch {
    showLogin();
  }
}

async function login() {
  try {
    await req('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ email: e.email.value.trim(), password: e.password.value }),
    });
    e.password.value = '';
    showPanel();
    await loadAll();
  } catch (error) {
    e.loginError.textContent = error.message;
  }
}

async function logout() {
  try {
    await req('/api/admin/logout', { method: 'POST', body: '{}' });
  } catch {
    // Даже если сервер недоступен, скрываем панель на клиенте.
  }
  showLogin();
}

function emptyState(title, text) {
  e.messages.innerHTML = `<div class="empty-state"><strong>${esc(title)}</strong><p>${esc(text)}</p></div>`;
}

function setMode(nextMode) {
  mode = nextMode;
  activeId = '';
  e.tabs.forEach((tab) => tab.classList.toggle('is-active', tab.dataset.adminTab === mode));
  e.orders.hidden = mode !== 'orders';
  e.conversations.hidden = mode !== 'chats';
  e.reply.hidden = mode !== 'chats';
  e.type.textContent = mode === 'orders' ? 'Заказ' : 'Диалог';
  e.title.textContent = mode === 'orders' ? 'Выберите заказ' : 'Выберите клиента';
  emptyState(
    mode === 'orders' ? 'Нет выбранного заказа' : 'Нет выбранного диалога',
    mode === 'orders' ? 'Когда клиент оформит заказ на сайте, он появится слева.' : 'Когда клиент напишет в чат, диалог появится слева.',
  );
  renderLists();
}

function renderLists() {
  e.orders.innerHTML = orders.length ? '' : '<div class="empty-state empty-state--sidebar"><p>Пока нет заказов.</p></div>';
  orders.forEach((order) => {
    const button = document.createElement('button');
    const priority = isPriorityOrder(order);
    button.className = `conversation${order.id === activeId && mode === 'orders' ? ' is-active' : ''}${priority ? ' conversation--priority' : ''}`;
    button.type = 'button';
    button.innerHTML = `
      <span class="conversation__avatar">${priority ? '★' : '₽'}</span>
      <span>
        <strong>${esc(order.number)}${priority ? ' · приоритет' : ''}</strong>
        <small>${esc(order.telegram)} · ${rub(order.calculation?.finalPrice)} · ${esc(STATUS_LABELS[order.status] || STATUS_LABELS.queue)}</small>
      </span>
      <time>${formatTime(order.createdAt)}</time>
    `;
    button.addEventListener('click', () => selectOrder(order.id));
    e.orders.append(button);
  });

  e.conversations.innerHTML = conversations.length ? '' : '<div class="empty-state empty-state--sidebar"><p>Пока нет сообщений.</p></div>';
  conversations.forEach((conversation) => {
    const button = document.createElement('button');
    button.className = `conversation${conversation.id === activeId && mode === 'chats' ? ' is-active' : ''}`;
    button.type = 'button';
    button.innerHTML = `
      <span class="conversation__avatar">${esc((conversation.name || 'К').slice(0, 1).toUpperCase())}</span>
      <span><strong>${esc(conversation.name || 'Клиент')}</strong><small>${esc(conversation.lastText || 'Новый диалог')}</small></span>
      <time>${formatTime(conversation.updatedAt)}</time>
    `;
    button.addEventListener('click', () => selectConversation(conversation.id));
    e.conversations.append(button);
  });
}

function renderOrder(order) {
  const calculation = order.calculation || {};
  const priority = isPriorityOrder(order);
  const addons = Array.isArray(calculation.addons) && calculation.addons.length
    ? calculation.addons.map((addon) => `${addon.label} +${Math.round(Number(addon.rate || 0) * 100)}%`).join(', ')
    : 'без доп. условий';
  const statusOptions = STATUSES.map((status) => `<option value="${status}" ${status === (order.status || 'queue') ? 'selected' : ''}>${STATUS_LABELS[status]}</option>`).join('');

  e.messages.innerHTML = `
    <article class="order-detail${priority ? ' order-detail--priority' : ''}">
      <header>
        <div class="order-detail__topline">
          <span class="order-detail__badge">${priority ? 'Приоритетный заказ' : 'Заказ'}</span>
          <label class="order-status-control">
            <span>Статус</span>
            <select data-order-status-select>${statusOptions}</select>
          </label>
        </div>
        <h2>${esc(order.number)}</h2>
        <p>${formatDateTime(order.createdAt)}</p>
      </header>

      <div class="order-detail__grid">
        <div><span>Telegram</span><strong>${esc(order.telegram)}</strong></div>
        <div><span>Почта</span><strong>${esc(order.email)}</strong></div>
        <div><span>ELO</span><strong>${esc(calculation.current)} → ${esc(calculation.target)}</strong></div>
        <div><span>Итого</span><strong>${rub(calculation.finalPrice)}</strong></div>
      </div>

      <dl class="order-detail__list">
        <div><dt>Объём</dt><dd>${esc(calculation.difference || 0)} ELO</dd></div>
        <div><dt>Шагов</dt><dd>${esc(calculation.stepCount || 0)}</dd></div>
        <div><dt>База</dt><dd>${rub(calculation.basePrice)}</dd></div>
        <div><dt>Наценки</dt><dd>${rub(calculation.markupPrice)}</dd></div>
        <div><dt>Условия</dt><dd>${esc(addons)}</dd></div>
        <div><dt>FunPay</dt><dd>${calculation.funpayDeal ? `да, +${rub(calculation.funpayMarkup)}` : 'нет'}</dd></div>
      </dl>

      ${order.comment ? `<div class="order-detail__comment"><span>Комментарий</span><p>${esc(order.comment)}</p></div>` : ''}
    </article>
  `;

  $('[data-order-status-select]', e.messages)?.addEventListener('change', async (event) => {
    await updateOrderStatus(order.id, event.target.value);
  });
}

function renderMessages(messages) {
  e.messages.innerHTML = '';
  messages.forEach((message) => {
    const article = document.createElement('article');
    article.className = `admin-message admin-message--${message.role === 'client' ? 'client' : 'manager'}`;
    article.innerHTML = `<p>${esc(message.text)}</p><time>${message.role === 'client' ? 'Клиент' : 'Менеджер'} · ${formatTime(message.createdAt)}</time>`;
    e.messages.append(article);
  });
  e.messages.scrollTop = e.messages.scrollHeight;
}

async function loadAll() {
  try {
    const [ordersData, conversationsData] = await Promise.all([req('/api/admin/orders'), req('/api/admin/conversations')]);
    orders = ordersData.orders || [];
    conversations = conversationsData.conversations || [];
    e.status.textContent = `Заказов: ${orders.length} · Диалогов: ${conversations.length}`;
    renderLists();
    if (activeId && mode === 'orders') await selectOrder(activeId, false);
    if (activeId && mode === 'chats') await loadMessages(activeId, false);
  } catch (error) {
    if (/автор|token|сесс/i.test(error.message)) showLogin('Сессия истекла. Войдите снова.');
    else e.status.textContent = error.message;
  }
}

async function selectOrder(id, refreshList = true) {
  mode = 'orders';
  activeId = id;
  e.reply.hidden = true;
  e.type.textContent = 'Заказ';
  const order = await req(`/api/admin/orders/${encodeURIComponent(id)}`);
  e.title.textContent = order.number;
  renderOrder(order);
  if (refreshList) renderLists();
}

async function updateOrderStatus(id, status) {
  if (!STATUSES.includes(status)) return;
  const data = await req(`/api/admin/orders/${encodeURIComponent(id)}/status`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
  const updated = data.order;
  orders = orders.map((order) => (order.id === updated.id ? updated : order));
  renderLists();
  if (activeId === updated.id) renderOrder(updated);
}

async function loadMessages(id, updateTitle = true) {
  const data = await req(`/api/admin/conversations/${encodeURIComponent(id)}`);
  if (updateTitle) e.title.textContent = data.name || 'Клиент';
  renderMessages(data.messages || []);
}

async function selectConversation(id) {
  mode = 'chats';
  activeId = id;
  e.reply.hidden = false;
  e.type.textContent = 'Диалог';
  await loadMessages(id);
  renderLists();
}

async function sendReply() {
  const text = e.input.value.trim();
  if (mode !== 'chats' || !activeId || !text) return;
  e.send.disabled = true;
  try {
    const data = await req(`/api/admin/conversations/${encodeURIComponent(activeId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    e.input.value = '';
    renderMessages(data.messages || []);
    await loadAll();
  } finally {
    e.send.disabled = false;
  }
}

setupTheme();
e.loginButton.addEventListener('click', login);
e.password.addEventListener('keydown', (event) => { if (event.key === 'Enter') login(); });
e.logout.addEventListener('click', logout);
e.refresh.addEventListener('click', loadAll);
e.send.addEventListener('click', sendReply);
e.tabs.forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.adminTab)));
e.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendReply();
  }
});

setMode('orders');
verifySession();
