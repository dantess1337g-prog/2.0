const THEME_KEY = 'miracle-boost-theme';
const ADMIN_NOTIFY_PERMISSION_KEY = 'miracle-boost-admin-notify-hint-shown';
const ADMIN_NOTIFY_ENABLED_KEY = 'miracle-boost-admin-notify-enabled';
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
let notificationReady = false;
let previousOrderIds = new Set();
let previousConversationState = new Map();
let adminUnreadCount = 0;
let adminToastTimer;
let adminTitleTimer;
let audioContext;
let adminNotificationsEnabled = localStorage.getItem(ADMIN_NOTIFY_ENABLED_KEY) !== 'false';

const originalTitle = document.title;
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

function playNotifySound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    audioContext ||= new AudioContext();
    if (audioContext.state === 'suspended') audioContext.resume();

    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(660, audioContext.currentTime);
    oscillator.frequency.setValueAtTime(920, audioContext.currentTime + 0.09);
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.06, audioContext.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.28);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.3);
  } catch {
    // Браузер может блокировать звук до пользовательского действия.
  }
}

function browserNotify(title, body, tag = 'miracle-boost-admin') {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag, icon: '/public/favicon.svg' });
  } catch {
    // Уведомление может быть заблокировано настройками браузера.
  }
}

function ensureAdminToast() {
  let toast = $('[data-admin-toast]');
  if (toast) return toast;
  toast = document.createElement('div');
  toast.className = 'admin-toast';
  toast.dataset.adminToast = '';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  document.body.append(toast);
  return toast;
}

function showAdminToast(text, tone = 'message') {
  const toast = ensureAdminToast();
  toast.textContent = text;
  toast.dataset.tone = tone;
  toast.classList.add('is-visible');
  clearTimeout(adminToastTimer);
  adminToastTimer = setTimeout(() => toast.classList.remove('is-visible'), 4600);
}

function updateAdminTitle() {
  clearInterval(adminTitleTimer);
  if (adminUnreadCount <= 0) {
    document.title = originalTitle;
    return;
  }
  document.title = `(${adminUnreadCount}) Miracle Boost — админ-панель`;
  if (document.hidden) {
    let active = false;
    adminTitleTimer = setInterval(() => {
      active = !active;
      document.title = active ? `(${adminUnreadCount}) Новое событие` : originalTitle;
    }, 1200);
  }
}

function addAdminUnread(amount = 1) {
  adminUnreadCount = Math.min(99, adminUnreadCount + amount);
  updateAdminTitle();
}

function clearAdminUnread() {
  adminUnreadCount = 0;
  updateAdminTitle();
}

function updateNotifyButton() {
  let button = $('[data-admin-notify-toggle]');
  if (!button && e.refresh?.parentElement) {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'admin-notify-toggle';
    button.dataset.adminNotifyToggle = '';
    e.refresh.parentElement.insertBefore(button, e.refresh);
  }
  if (!button) return;

  if (!('Notification' in window)) {
    button.hidden = true;
    return;
  }

  const permission = Notification.permission;
  button.dataset.permission = permission;
  button.dataset.state = adminNotificationsEnabled ? 'enabled' : 'disabled';

  if (!adminNotificationsEnabled) {
    button.textContent = '🔕 Уведомления выключены';
    button.title = 'Нажмите, чтобы включить уведомления админки';
    return;
  }

  button.textContent = permission === 'granted' ? '🔔 Уведомления включены' : '🔔 Уведомления сайта включены';
  button.title = permission === 'denied'
    ? 'Уведомления включены на сайте, но браузерные уведомления заблокированы'
    : permission === 'granted'
      ? 'Нажмите, чтобы выключить уведомления админки'
      : 'Нажмите, чтобы разрешить браузерные уведомления';
}

async function requestAdminNotifications() {
  adminNotificationsEnabled = !adminNotificationsEnabled;
  localStorage.setItem(ADMIN_NOTIFY_ENABLED_KEY, adminNotificationsEnabled ? 'true' : 'false');

  if (!adminNotificationsEnabled) {
    showAdminToast('Уведомления админки выключены', 'warning');
    updateNotifyButton();
    return;
  }

  if ('Notification' in window && Notification.permission === 'default') {
    const result = await Notification.requestPermission();
    showAdminToast(result === 'granted' ? 'Уведомления админки включены' : 'Уведомления сайта включены, но браузерные уведомления не разрешены', result === 'granted' ? 'message' : 'warning');
  } else {
    showAdminToast('Уведомления админки включены', 'message');
    playNotifySound();
  }
  updateNotifyButton();
}

function notifyAdmin(title, body, tone = 'message', tag = 'miracle-boost-admin') {
  addAdminUnread();
  if (!adminNotificationsEnabled) return;
  showAdminToast(`${title}: ${body}`, tone);
  playNotifySound();
  browserNotify(title, body, tag);
}

function snapshotConversations(list) {
  return new Map(list.map((conversation) => [conversation.id, `${conversation.updatedAt || ''}|${conversation.totalMessages || 0}|${conversation.lastRole || ''}`]));
}

function processAdminNotifications(nextOrders, nextConversations) {
  const nextOrderIds = new Set(nextOrders.map((order) => order.id));
  const nextConversationState = snapshotConversations(nextConversations);

  if (!notificationReady) {
    previousOrderIds = nextOrderIds;
    previousConversationState = nextConversationState;
    notificationReady = true;
    return;
  }

  const newOrders = nextOrders.filter((order) => !previousOrderIds.has(order.id));
  const newClientMessages = nextConversations.filter((conversation) => {
    if (conversation.id === activeId && mode === 'chats') return false;
    if (String(conversation.id || '').startsWith('order-')) return false;
    if (conversation.lastRole !== 'client') return false;
    return previousConversationState.get(conversation.id) !== nextConversationState.get(conversation.id);
  });

  newOrders.forEach((order) => {
    notifyAdmin('Новый заказ', `${order.number} · ${order.telegram}`, isPriorityOrder(order) ? 'priority' : 'order', `order-${order.id}`);
  });

  newClientMessages.forEach((conversation) => {
    const preview = String(conversation.lastText || 'Новое сообщение').slice(0, 90);
    notifyAdmin('Новое сообщение', `${conversation.name || 'Клиент'}: ${preview}`, 'message', `chat-${conversation.id}`);
  });

  previousOrderIds = nextOrderIds;
  previousConversationState = nextConversationState;
}

function setupNotifications() {
  ensureAdminToast();
  updateNotifyButton();
  document.addEventListener('click', (event) => {
    if (event.target.closest('[data-admin-notify-toggle]')) requestAdminNotifications();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && adminUnreadCount <= 0) document.title = originalTitle;
  });

  if (!localStorage.getItem(ADMIN_NOTIFY_PERMISSION_KEY) && 'Notification' in window && Notification.permission === 'default') {
    localStorage.setItem(ADMIN_NOTIFY_PERMISSION_KEY, 'true');
    setTimeout(() => showAdminToast('Нажмите «Включить уведомления», чтобы получать браузерные оповещения о новых заказах и сообщениях', 'hint'), 1200);
  }
}

function showPanel() {
  e.loginScreen.hidden = true;
  e.panel.hidden = false;
  clearInterval(timer);
  timer = setInterval(loadAll, 3000);
  updateNotifyButton();
}

function showLogin(message = '') {
  e.loginScreen.hidden = false;
  e.panel.hidden = true;
  e.loginError.textContent = message;
  clearInterval(timer);
  notificationReady = false;
  clearAdminUnread();
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
  clearAdminUnread();
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
    const hasClientMessage = conversation.lastRole === 'client' && !(conversation.id === activeId && mode === 'chats');
    button.className = `conversation${conversation.id === activeId && mode === 'chats' ? ' is-active' : ''}${hasClientMessage ? ' conversation--unread' : ''}`;
    button.type = 'button';
    button.innerHTML = `
      <span class="conversation__avatar">${esc((conversation.name || 'К').slice(0, 1).toUpperCase())}</span>
      <span><strong>${esc(conversation.name || 'Клиент')}</strong><small>${esc(conversation.lastText || 'Новый диалог')}</small></span>
      ${hasClientMessage ? '<b class="conversation__badge">new</b>' : ''}
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
    const nextOrders = ordersData.orders || [];
    const nextConversations = conversationsData.conversations || [];
    processAdminNotifications(nextOrders, nextConversations);
    orders = nextOrders;
    conversations = nextConversations;
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
  clearAdminUnread();
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
  clearAdminUnread();
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
    showAdminToast('Ответ отправлен клиенту', 'message');
  } finally {
    e.send.disabled = false;
  }
}

setupTheme();
setupNotifications();
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
