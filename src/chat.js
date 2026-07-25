const CHAT_API = '/api/chat/messages';
const CHAT_ID_KEY = 'miracle-boost-chat-id';
const CHAT_NAME_KEY = 'miracle-boost-chat-name';
const CHAT_NAME_LOCK_KEY = 'miracle-boost-chat-name-locked';
const CHAT_LAST_SEEN_MANAGER_KEY = 'miracle-boost-chat-last-seen-manager-id';
const CHAT_LAST_NOTIFIED_MANAGER_KEY = 'miracle-boost-chat-last-notified-manager-id';
const CHAT_POSITION_KEY = 'miracle-boost-chat-position';
const CHAT_NOTIFY_ENABLED_KEY = 'miracle-boost-chat-notify-enabled';
const CHAT_LAST_SENT_AT_KEY = 'miracle-boost-chat-last-sent-at';
const POLL_INTERVAL = 2600;
const MESSAGE_COOLDOWN_MS = 30_000;

const demoMessages = [
  {
    id: 'welcome',
    role: 'manager',
    author: 'Поддержка Miracle Boost',
    text: 'Здравствуйте! Это поддержка Miracle Boost. Напишите ваш вопрос — поможем с расчётом, оформлением или сделкой через FunPay.',
    createdAt: new Date().toISOString(),
  },
];

const template = document.createElement('template');
template.innerHTML = `
  <section class="chat-widget" data-chat-widget aria-label="Чат поддержки Miracle Boost">
    <button class="chat-widget__launcher" type="button" data-chat-open aria-label="Открыть чат поддержки">
      <span class="chat-widget__launcher-dot" aria-hidden="true"></span>
      <span class="chat-widget__unread" data-chat-unread hidden>0</span>
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 5.7C4 4.2 5.2 3 6.7 3h10.6C18.8 3 20 4.2 20 5.7v7.5c0 1.5-1.2 2.7-2.7 2.7H10l-4.4 4.1c-.6.6-1.6.1-1.6-.7V5.7Z" />
      </svg>
      <span>Поддержка</span>
    </button>

    <div class="chat-widget__notice" data-chat-notice role="status" aria-live="polite" hidden></div>

    <div class="chat-panel" data-chat-panel aria-hidden="true">
      <div class="chat-panel__top">
        <button class="chat-panel__close" type="button" data-chat-close aria-label="Закрыть чат">×</button>
        <div class="chat-panel__manager">
          <span class="chat-panel__avatar" aria-hidden="true">M</span>
          <span class="chat-panel__online" aria-hidden="true"></span>
          <div>
            <strong>Поддержка Miracle Boost</strong>
            <small>Support</small>
          </div>
        </div>
      </div>

      <div class="chat-panel__tools">
        <button class="chat-panel__notify" type="button" data-chat-notify aria-label="Включить уведомления о новых ответах">🔔 Включить уведомления</button>
        <small data-chat-notify-hint>Перетащите чат за кнопку или шапку, чтобы поставить его в любое место.</small>
      </div>

      <div class="chat-panel__body" data-chat-messages aria-live="polite"></div>

      <div class="chat-panel__form">
        <label class="sr-only" for="chat-text">Введите сообщение</label>
        <textarea id="chat-text" rows="1" maxlength="1200" placeholder="Введите сообщение" data-chat-input></textarea>
        <button class="chat-panel__send" type="button" data-chat-send aria-label="Отправить сообщение">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12h14M12 6l6 6-6 6" /></svg>
        </button>
      </div>

      <p class="chat-panel__status" data-chat-status></p>
    </div>
  </section>
`;

document.body.append(template.content.cloneNode(true));

const $ = (selector, root = document) => root.querySelector(selector);
const widget = $('[data-chat-widget]');
const openButton = $('[data-chat-open]', widget);
const closeButton = $('[data-chat-close]', widget);
const panel = $('[data-chat-panel]', widget);
const panelTop = $('.chat-panel__top', widget);
const messagesEl = $('[data-chat-messages]', widget);
const input = $('[data-chat-input]', widget);
const sendButton = $('[data-chat-send]', widget);
const statusEl = $('[data-chat-status]', widget);
const unreadEl = $('[data-chat-unread]', widget);
const noticeEl = $('[data-chat-notice]', widget);
const notifyButton = $('[data-chat-notify]', widget);
const notifyHint = $('[data-chat-notify-hint]', widget);
const nameWrap = $('[data-chat-name-wrap]', widget);
const nameInput = $('[data-chat-name]', widget);
const nameHint = $('[data-chat-name-hint]', widget);

const originalTitle = document.title;
let clientId = localStorage.getItem(CHAT_ID_KEY);
let clientName = localStorage.getItem(CHAT_NAME_KEY) || '';
let nameLocked = localStorage.getItem(CHAT_NAME_LOCK_KEY) === 'true';
let lastSeenManagerId = localStorage.getItem(CHAT_LAST_SEEN_MANAGER_KEY) || '';
let lastNotifiedManagerId = localStorage.getItem(CHAT_LAST_NOTIFIED_MANAGER_KEY) || '';
let chatPosition = loadChatPosition();
let notificationsEnabled = localStorage.getItem(CHAT_NOTIFY_ENABLED_KEY) !== 'false';
let lastSentAt = Number(localStorage.getItem(CHAT_LAST_SENT_AT_KEY) || 0);
let messages = [...demoMessages];
let pollTimer;
let noticeTimer;
let titleTimer;
let apiAvailable = true;
let hasLoadedFromServer = false;
let audioContext;
let dragState = null;
let suppressOpenClick = false;

if (!clientId) {
  clientId = crypto.randomUUID ? crypto.randomUUID() : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(CHAT_ID_KEY, clientId);
}
if (nameInput) nameInput.value = clientName;

function formatTime(dateString) {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(dateString));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function panelSize() {
  const isOpen = widget.classList.contains('is-open');
  const rect = isOpen ? panel.getBoundingClientRect() : openButton.getBoundingClientRect();
  return {
    width: Math.max(58, rect.width || openButton.offsetWidth || 58),
    height: Math.max(56, rect.height || openButton.offsetHeight || 56),
  };
}

function defaultChatPosition() {
  const width = 170;
  const height = 56;
  return {
    x: Math.max(14, window.innerWidth - width - 24),
    y: Math.max(14, window.innerHeight - height - 24),
  };
}

function loadChatPosition() {
  try {
    const saved = JSON.parse(localStorage.getItem(CHAT_POSITION_KEY) || 'null');
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return saved;
  } catch {
    // повреждённое значение игнорируем
  }
  return defaultChatPosition();
}

function applyChatPosition(position = chatPosition, shouldSave = true) {
  const size = panelSize();
  const margin = window.innerWidth <= 620 ? 10 : 16;
  chatPosition = {
    x: clamp(Number(position.x || 0), margin, Math.max(margin, window.innerWidth - size.width - margin)),
    y: clamp(Number(position.y || 0), margin, Math.max(margin, window.innerHeight - size.height - margin)),
  };

  widget.style.left = `${Math.round(chatPosition.x)}px`;
  widget.style.top = `${Math.round(chatPosition.y)}px`;
  widget.style.right = 'auto';
  widget.style.bottom = 'auto';
  widget.classList.add('is-free-position');

  if (shouldSave) localStorage.setItem(CHAT_POSITION_KEY, JSON.stringify(chatPosition));
}

function cooldownLeftMs() {
  return Math.max(0, MESSAGE_COOLDOWN_MS - (Date.now() - lastSentAt));
}

function formatCooldown(ms) {
  return `${Math.ceil(ms / 1000)} сек.`;
}

function updateSendCooldownState() {
  const left = cooldownLeftMs();
  sendButton.disabled = left > 0;
  sendButton.classList.toggle('is-disabled', left > 0);
  if (left > 0) {
    setStatus(`Следующее сообщение можно отправить через ${formatCooldown(left)}`, 'warning');
    return;
  }

  if (statusEl.dataset.tone === 'warning' && /сообщени|Подождите|Следующее/.test(statusEl.textContent || '')) {
    setStatus('');
  }
}

function managerMessages(list = messages) {
  return list.filter((message) => message.role !== 'client' && message.id !== 'welcome');
}

function latestManagerMessage(list = messages) {
  const managerOnly = managerMessages(list);
  return managerOnly[managerOnly.length - 1] || null;
}

function countUnread(list = messages) {
  const managerOnly = managerMessages(list);
  if (!managerOnly.length) return 0;
  if (!lastSeenManagerId) return 0;
  const seenIndex = managerOnly.findIndex((message) => message.id === lastSeenManagerId);
  if (seenIndex === -1) return managerOnly.length;
  return Math.max(0, managerOnly.length - seenIndex - 1);
}

function setUnread(count) {
  const safeCount = Math.max(0, Number(count || 0));
  if (!unreadEl) return;
  unreadEl.hidden = safeCount === 0;
  unreadEl.textContent = safeCount > 9 ? '9+' : String(safeCount);
  openButton?.classList.toggle('has-unread', safeCount > 0);

  if (safeCount > 0) {
    document.title = `(${safeCount}) Ответ поддержки — Miracle Boost`;
  } else {
    document.title = originalTitle;
    clearInterval(titleTimer);
  }
}

function markManagerMessagesAsSeen(list = messages) {
  const latest = latestManagerMessage(list);
  if (!latest) return;
  lastSeenManagerId = latest.id;
  localStorage.setItem(CHAT_LAST_SEEN_MANAGER_KEY, lastSeenManagerId);
  setUnread(0);
}

function showNotice(text) {
  if (!noticeEl) return;
  noticeEl.textContent = text;
  noticeEl.hidden = false;
  noticeEl.classList.add('is-visible');
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    noticeEl.classList.remove('is-visible');
    noticeEl.hidden = true;
  }, 4200);
}

function unlockAudio() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    audioContext ||= new AudioContext();
    if (audioContext.state === 'suspended') audioContext.resume();
  } catch {
    // Браузер может разрешить звук только после действия пользователя.
  }
}

function playNotifySound() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    audioContext ||= new AudioContext();
    if (audioContext.state === 'suspended') audioContext.resume();

    const now = audioContext.currentTime;
    const notes = [
      { at: 0.00, freq: 620, duration: 0.24 },
      { at: 0.28, freq: 820, duration: 0.26 },
      { at: 0.58, freq: 1040, duration: 0.28 },
      { at: 0.92, freq: 820, duration: 0.32 },
    ];

    notes.forEach((note) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const startAt = now + note.at;
      const endAt = startAt + note.duration;

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(note.freq, startAt);
      oscillator.frequency.exponentialRampToValueAtTime(note.freq * 1.08, endAt);

      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(0.062, startAt + 0.035);
      gain.gain.exponentialRampToValueAtTime(0.0001, endAt);

      oscillator.connect(gain);
      gain.connect(audioContext.destination);
      oscillator.start(startAt);
      oscillator.stop(endAt + 0.02);
    });
  } catch {
    // Звук может быть заблокирован браузером до действия пользователя.
  }
}

function browserNotify(title, body) {
  if (!notificationsEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, tag: 'miracle-boost-chat-reply', icon: '/public/favicon.svg' });
  } catch {
    // Некоторые браузеры блокируют уведомления без дополнительного действия пользователя.
  }
}

function startTitleBlink(count) {
  clearInterval(titleTimer);
  if (!count || !document.hidden) return;
  let active = false;
  titleTimer = setInterval(() => {
    active = !active;
    document.title = active ? `(${count}) Ответ поддержки` : originalTitle;
  }, 1200);
}

function notifyManagerReply(message, unreadCount) {
  const preview = String(message.text || 'Новое сообщение').slice(0, 90);
  setUnread(unreadCount);
  startTitleBlink(unreadCount);

  if (!notificationsEnabled) return;

  showNotice(`Поддержка ответила: ${preview}`);
  playNotifySound();
  browserNotify('Поддержка Miracle Boost ответила', preview);
}

function updateNotificationButton() {
  if (!notifyButton) return;
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  notifyButton.dataset.state = notificationsEnabled ? 'enabled' : 'disabled';
  notifyButton.setAttribute('aria-pressed', String(notificationsEnabled));

  if (!notificationsEnabled) {
    notifyButton.title = 'Включить уведомления поддержки';
    notifyButton.setAttribute('aria-label', 'Включить уведомления поддержки');
    notifyButton.textContent = '🔕 Уведомления выключены';
    if (notifyHint) notifyHint.textContent = 'Нажмите, чтобы включить уведомления о ответах поддержки.';
    return;
  }

  notifyButton.textContent = '🔔 Уведомления включены';
  notifyButton.title = permission === 'denied'
    ? 'Уведомления включены на сайте, но браузерные уведомления заблокированы'
    : 'Выключить уведомления поддержки';
  notifyButton.setAttribute('aria-label', 'Выключить уведомления поддержки');
  if (notifyHint) notifyHint.textContent = 'Перетащите чат за кнопку или шапку, чтобы поставить его в любое место.';
}

function renderMessages(nextMessages = messages) {
  messages = nextMessages.length ? nextMessages : demoMessages;
  messagesEl.innerHTML = '';

  messages.forEach((message) => {
    const item = document.createElement('article');
    item.className = `chat-message chat-message--${message.role === 'client' ? 'client' : 'manager'}`;

    const author = document.createElement('span');
    author.className = 'chat-message__author';
    author.textContent = message.role === 'client' ? (clientName || 'Вы') : (message.author || 'Поддержка Miracle Boost');

    const text = document.createElement('p');
    text.textContent = message.text;

    const time = document.createElement('time');
    time.dateTime = message.createdAt;
    time.textContent = formatTime(message.createdAt);

    item.append(author, text, time);
    messagesEl.append(item);
  });

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setStatus(text, tone = '') {
  statusEl.textContent = text;
  statusEl.dataset.tone = tone;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Ошибка сервера');
  return data;
}

function handleIncomingMessages(nextMessages) {
  const latestManager = latestManagerMessage(nextMessages);
  const isOpen = widget.classList.contains('is-open');

  if (!latestManager) {
    renderMessages(nextMessages);
    setUnread(0);
    hasLoadedFromServer = true;
    return;
  }

  if (!lastSeenManagerId) {
    lastSeenManagerId = latestManager.id;
    localStorage.setItem(CHAT_LAST_SEEN_MANAGER_KEY, lastSeenManagerId);
  }

  if (!lastNotifiedManagerId) {
    lastNotifiedManagerId = latestManager.id;
    localStorage.setItem(CHAT_LAST_NOTIFIED_MANAGER_KEY, lastNotifiedManagerId);
  }

  const unreadBeforeRender = countUnread(nextMessages);
  const hasNewManagerReply = hasLoadedFromServer && latestManager.id !== lastNotifiedManagerId;

  renderMessages(nextMessages);

  if (hasNewManagerReply) {
    lastNotifiedManagerId = latestManager.id;
    localStorage.setItem(CHAT_LAST_NOTIFIED_MANAGER_KEY, lastNotifiedManagerId);
    notifyManagerReply(latestManager, unreadBeforeRender);
  }

  if (isOpen) markManagerMessagesAsSeen(nextMessages);
  else setUnread(unreadBeforeRender);

  hasLoadedFromServer = true;
}

async function loadMessages() {
  try {
    const data = await request(`${CHAT_API}?clientId=${encodeURIComponent(clientId)}&name=${encodeURIComponent(clientName || '')}`);
    apiAvailable = true;
    handleIncomingMessages(data.messages || []);
    setStatus('');
  } catch {
    apiAvailable = false;
    renderMessages(messages);
    setStatus('Чат временно работает в демо-режиме. Проверьте Netlify Functions и подключение Supabase.', 'warning');
  }
}

function saveName() {
  if (nameLocked || !nameInput) return;
  clientName = nameInput.value.trim().slice(0, 40);
  if (clientName) localStorage.setItem(CHAT_NAME_KEY, clientName);
  else localStorage.removeItem(CHAT_NAME_KEY);
}
function syncNameState() {
  const shownName = clientName || 'Клиент';
  if (!nameInput || !nameWrap) return;
  nameInput.disabled = nameLocked;
  nameInput.value = nameLocked ? shownName : clientName;
  nameWrap.classList.toggle('is-locked', nameLocked);
  if (nameHint) {
    nameHint.textContent = nameLocked
      ? `Ник закреплён: ${shownName}.`
      : 'Введите ник один раз — после первого сообщения он будет закреплён.';
  }
}
function lockNameAfterSend() {
  if (!clientName) {
    clientName = 'Клиент';
    localStorage.setItem(CHAT_NAME_KEY, clientName);
  }
  nameLocked = true;
  localStorage.setItem(CHAT_NAME_LOCK_KEY, 'true');
  syncNameState();
}

async function sendMessage() {
  const text = input.value.trim();
  if (!text) return;

  const left = cooldownLeftMs();
  if (left > 0) {
    setStatus(`Подождите ${formatCooldown(left)} перед следующим сообщением`, 'warning');
    updateSendCooldownState();
    return;
  }

  saveName();
  input.value = '';
  input.style.height = 'auto';
  lastSentAt = Date.now();
  localStorage.setItem(CHAT_LAST_SENT_AT_KEY, String(lastSentAt));
  updateSendCooldownState();

  const localMessage = {
    id: `local-${Date.now()}`,
    role: 'client',
    author: clientName || 'Клиент',
    text,
    createdAt: new Date().toISOString(),
  };
  renderMessages([...messages, localMessage]);
  lockNameAfterSend();

  try {
    const data = await request(CHAT_API, {
      method: 'POST',
      body: JSON.stringify({ clientId, name: clientName, text }),
    });
    apiAvailable = true;
    handleIncomingMessages(data.messages || []);
    setStatus('Сообщение отправлено менеджеру');
  } catch (error) {
    apiAvailable = false;
    setStatus(error.message || 'Не удалось отправить сообщение. Проверьте Netlify Functions и подключение Supabase.', 'warning');
  }
}

function openChat() {
  if (suppressOpenClick) return;
  widget.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
  applyChatPosition(chatPosition);
  input.focus();
  loadMessages().then(() => markManagerMessagesAsSeen()).catch(() => {});
}

function closeChat() {
  widget.classList.remove('is-open');
  panel.setAttribute('aria-hidden', 'true');
  applyChatPosition(chatPosition);
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    loadMessages();
  }, POLL_INTERVAL);
}

async function requestNotifications() {
  notificationsEnabled = !notificationsEnabled;
  localStorage.setItem(CHAT_NOTIFY_ENABLED_KEY, notificationsEnabled ? 'true' : 'false');

  if (notificationsEnabled) {
    unlockAudio();
    if ('Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch {
        // Браузер может не показать запрос разрешения.
      }
    }
    updateNotificationButton();
    showNotice('Уведомления поддержки включены');
    playNotifySound();
  } else {
    updateNotificationButton();
    showNotice('Уведомления поддержки выключены');
  }
}

function startChatDrag(event) {
  if (event.button !== undefined && event.button !== 0) return;
  if (event.currentTarget === panelTop && event.target.closest('button, input, textarea, select, a')) return;

  const rect = widget.classList.contains('is-open') ? panel.getBoundingClientRect() : widget.getBoundingClientRect();
  const currentX = rect.left;
  const currentY = rect.top;

  dragState = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: currentX,
    originY: currentY,
    active: false,
  };

  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function moveChatDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;

  const dx = event.clientX - dragState.startX;
  const dy = event.clientY - dragState.startY;
  const distance = Math.hypot(dx, dy);
  if (distance < 8 && !dragState.active) return;

  dragState.active = true;
  suppressOpenClick = true;
  widget.classList.add('is-dragging');
  applyChatPosition({ x: dragState.originX + dx, y: dragState.originY + dy });
  event.preventDefault();
}

function endChatDrag(event) {
  if (!dragState || event.pointerId !== dragState.pointerId) return;
  const wasDragging = dragState.active;

  dragState = null;
  widget.classList.remove('is-dragging');

  if (wasDragging) {
    setTimeout(() => {
      suppressOpenClick = false;
    }, 140);
  } else {
    suppressOpenClick = false;
  }
}

function setupChatDrag() {
  [openButton, panelTop].filter(Boolean).forEach((handle) => {
    handle.addEventListener('pointerdown', startChatDrag);
    handle.addEventListener('pointermove', moveChatDrag);
    handle.addEventListener('pointerup', endChatDrag);
    handle.addEventListener('pointercancel', endChatDrag);
  });
}

openButton.addEventListener('click', openChat);
closeButton.addEventListener('click', closeChat);
sendButton.addEventListener('click', sendMessage);
notifyButton?.addEventListener('click', requestNotifications);
nameInput?.addEventListener('input', () => { saveName(); syncNameState(); });
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
});
input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && countUnread(messages) === 0) document.title = originalTitle;
});

applyChatPosition(chatPosition, false);
window.addEventListener('resize', () => applyChatPosition(chatPosition));
syncNameState();
updateNotificationButton();
setupChatDrag();
renderMessages();
updateSendCooldownState();
setInterval(updateSendCooldownState, 1000);
loadMessages();
startPolling();
