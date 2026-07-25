const CHAT_API = '/api/chat/messages';
const CHAT_ID_KEY = 'miracle-boost-chat-id';
const CHAT_NAME_KEY = 'miracle-boost-chat-name';
const CHAT_NAME_LOCK_KEY = 'miracle-boost-chat-name-locked';
const POLL_INTERVAL = 2600;

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
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 5.7C4 4.2 5.2 3 6.7 3h10.6C18.8 3 20 4.2 20 5.7v7.5c0 1.5-1.2 2.7-2.7 2.7H10l-4.4 4.1c-.6.6-1.6.1-1.6-.7V5.7Z" />
      </svg>
      <span>Поддержка</span>
    </button>

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
const messagesEl = $('[data-chat-messages]', widget);
const input = $('[data-chat-input]', widget);
const sendButton = $('[data-chat-send]', widget);
const statusEl = $('[data-chat-status]', widget);
const nameWrap = $('[data-chat-name-wrap]', widget);
const nameInput = $('[data-chat-name]', widget);
const nameHint = $('[data-chat-name-hint]', widget);

let clientId = localStorage.getItem(CHAT_ID_KEY);
let clientName = localStorage.getItem(CHAT_NAME_KEY) || '';
let nameLocked = localStorage.getItem(CHAT_NAME_LOCK_KEY) === 'true';
let messages = [...demoMessages];
let pollTimer;
let apiAvailable = true;

if (!clientId) {
  clientId = crypto.randomUUID ? crypto.randomUUID() : `client-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(CHAT_ID_KEY, clientId);
}
if (nameInput) nameInput.value = clientName;

function formatTime(dateString) {
  return new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(new Date(dateString));
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

async function loadMessages() {
  try {
    const data = await request(`${CHAT_API}?clientId=${encodeURIComponent(clientId)}&name=${encodeURIComponent(clientName || '')}`);
    apiAvailable = true;
    renderMessages(data.messages || []);
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
  saveName();
  input.value = '';
  input.style.height = 'auto';

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
    renderMessages(data.messages || []);
    setStatus('Сообщение отправлено менеджеру');
  } catch {
    apiAvailable = false;
    setStatus('Не удалось отправить сообщение. Проверьте Netlify Functions и подключение Supabase.', 'warning');
  }
}

function openChat() {
  widget.classList.add('is-open');
  panel.setAttribute('aria-hidden', 'false');
  input.focus();
  loadMessages();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (apiAvailable) loadMessages();
  }, POLL_INTERVAL);
}

function closeChat() {
  widget.classList.remove('is-open');
  panel.setAttribute('aria-hidden', 'true');
  clearInterval(pollTimer);
}

openButton.addEventListener('click', openChat);
closeButton.addEventListener('click', closeChat);
sendButton.addEventListener('click', sendMessage);
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

syncNameState();
renderMessages();
loadMessages();
