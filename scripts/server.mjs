import http from 'node:http';
import crypto from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const root = resolve(projectRoot, process.argv[2] || '.');
const port = Number(process.argv[3] || process.env.PORT || 3000);
const dataDir = resolve(process.env.DATA_DIR || join(projectRoot, 'data'));
const storePath = join(dataDir, 'chats.json');
const schemaPath = join(projectRoot, 'database', 'schema.sql');
const sessions = new Map();
const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const loginBuckets = new Map();

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function clientIp(request) {
  return String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || '').split(',')[0].trim();
}

function checkLoginRateLimit(request) {
  const key = clientIp(request) || 'unknown';
  const now = Date.now();
  const bucket = loginBuckets.get(key) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };

  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + LOGIN_WINDOW_MS;
  }

  bucket.count += 1;
  loginBuckets.set(key, bucket);

  if (bucket.count > LOGIN_MAX_ATTEMPTS) {
    const seconds = Math.ceil((bucket.resetAt - now) / 1000);
    const err = Error(`Слишком много попыток входа. Попробуйте через ${seconds} сек.`);
    err.status = 429;
    throw err;
  }
}

function resetLoginRateLimit(request) {
  loginBuckets.delete(clientIp(request) || 'unknown');
}

const STATUSES = ['queue', 'payment', 'boosting', 'done'];
const STATUS_LABELS = {
  queue: 'В очереди',
  payment: 'Ожидание оплаты',
  boosting: 'Ведётся буст',
  done: 'Выполнен',
};

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

let storage;

const welcome = () => ({
  id: crypto.randomUUID(),
  role: 'manager',
  author: 'Поддержка Miracle Boost',
  text: 'Здравствуйте! Это поддержка Miracle Boost. Напишите ваш вопрос — поможем с расчётом, оформлением или сделкой через FunPay.',
  createdAt: new Date().toISOString(),
});

function send(response, status, payload, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    ...headers,
  });
  response.end(JSON.stringify(payload));
}

const error = (response, status, message) => send(response, status, { error: message });

function readBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        rejectBody(Error('Слишком большой запрос'));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolveBody(body ? JSON.parse(body) : {});
      } catch {
        rejectBody(Error('Некорректный JSON'));
      }
    });
  });
}

const clean = (value, limit = 1200) => String(value || '').replace(/\r\n/g, '\n').trim().slice(0, limit);
const cleanName = (value) => clean(value, 40) || 'Клиент';
const toIso = (value) => (!value ? new Date().toISOString() : value instanceof Date ? value.toISOString() : new Date(value).toISOString());
const normalizeMessage = (message) => ({
  id: message.id,
  role: message.role,
  author: message.author,
  text: message.text,
  createdAt: toIso(message.createdAt ?? message.created_at),
});
const normalizeOrder = (order) => order && ({
  id: order.id,
  number: order.number,
  status: STATUSES.includes(order.status) ? order.status : 'queue',
  telegram: order.telegram,
  email: order.email,
  comment: order.comment || '',
  calculation: typeof order.calculation === 'string' ? JSON.parse(order.calculation) : order.calculation,
  isPriority: Boolean(order.isPriority ?? order.is_priority),
  createdAt: toIso(order.createdAt ?? order.created_at),
  updatedAt: toIso(order.updatedAt ?? order.updated_at),
});

const rub = (value) => `${Math.round(Number(value || 0)).toLocaleString('ru-RU')} ₽`;

function isPriorityCalculation(calculation = {}) {
  const addons = calculation.addons;
  return Array.isArray(addons) && addons.some((addon) => String(addon.label || addon).toLowerCase().includes('приоритет'));
}

function orderText(order) {
  const calculation = order.calculation || {};
  const addons = Array.isArray(calculation.addons) && calculation.addons.length
    ? calculation.addons.map((addon) => `${addon.label} +${Math.round(Number(addon.rate || 0) * 100)}%`).join(', ')
    : 'без доп. условий';

  return [
    `Новый заказ ${order.number}`,
    '',
    `Статус: ${STATUS_LABELS[order.status] || STATUS_LABELS.queue}`,
    `Telegram: ${order.telegram}`,
    `Почта: ${order.email}`,
    '',
    `ELO: ${calculation.current} → ${calculation.target}`,
    `Объём: ${calculation.difference} ELO`,
    `Шагов: ${calculation.stepCount}`,
    `База: ${rub(calculation.basePrice)}`,
    `Наценки: ${rub(calculation.markupPrice)}`,
    `Условия: ${addons}`,
    `FunPay: ${calculation.funpayDeal ? `да, +${rub(calculation.funpayMarkup)}` : 'нет'}`,
    `Итого: ${rub(calculation.finalPrice ?? calculation.totalPrice)}`,
    order.comment ? `\nКомментарий: ${order.comment}` : '',
  ].filter(Boolean).join('\n');
}

function validateOrder(body) {
  const telegram = clean(body.telegram, 80).replace(/^https?:\/\/t\.me\//i, '@');
  const email = clean(body.email, 120).toLowerCase();
  const comment = clean(body.comment, 800);
  const calculation = body.calculation || {};

  if (!telegram) throw Error('Укажите Telegram');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw Error('Укажите корректную почту');
  if (!calculation.valid) throw Error('Некорректный расчёт');

  return { telegram, email, comment, calculation };
}

function validateStatus(status) {
  if (!STATUSES.includes(status)) throw Error('Некорректный статус заказа');
  return status;
}

function cookieFrom(request, name) {
  const cookieHeader = String(request.headers.cookie || '');
  return cookieHeader
    .split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith(`${name}=`))
    ?.slice(name.length + 1) || '';
}

const tokenFrom = (request) => (request.headers.authorization || '').startsWith('Bearer ')
  ? request.headers.authorization.slice(7)
  : decodeURIComponent(cookieFrom(request, 'mb_admin') || '');

function adminCookie(token, request) {
  const secure = process.env.NODE_ENV === 'production' || String(request.headers['x-forwarded-proto'] || '').includes('https');
  return [
    `mb_admin=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function clearAdminCookie() {
  return 'mb_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

async function requireAdmin(request, response) {
  const token = tokenFrom(request);
  if (!token || !(await storage.isAdminSessionValid(token, request))) {
    error(response, 401, 'Нужна авторизация');
    return false;
  }
  return true;
}

function jsonStore() {
  function ensure() {
    mkdirSync(dataDir, { recursive: true });
    if (!existsSync(storePath)) writeFileSync(storePath, JSON.stringify({ conversations: {}, orders: {} }, null, 2));
  }

  function read() {
    ensure();
    try {
      const state = JSON.parse(readFileSync(storePath, 'utf8'));
      return { conversations: state.conversations || {}, orders: state.orders || {} };
    } catch {
      return { conversations: {}, orders: {} };
    }
  }

  function write(state) {
    ensure();
    writeFileSync(storePath, JSON.stringify(state, null, 2));
  }

  function ensureConversation(state, id, name = '') {
    const nextId = clean(id, 120) || crypto.randomUUID();
    if (!state.conversations[nextId]) {
      const now = new Date().toISOString();
      state.conversations[nextId] = {
        id: nextId,
        name: cleanName(name),
        createdAt: now,
        updatedAt: now,
        messages: [welcome()],
      };
    } else if (clean(name)) {
      state.conversations[nextId].name = cleanName(name);
    }
    return state.conversations[nextId];
  }

  return {
    type: 'json',
    async init() { ensure(); },
    async getClientMessages(id, name) {
      const state = read();
      const conversation = ensureConversation(state, id, name);
      write(state);
      return { clientId: conversation.id, messages: conversation.messages.map(normalizeMessage) };
    },
    async addClientMessage(id, name, text) {
      const state = read();
      const conversation = ensureConversation(state, id, name);
      const now = new Date().toISOString();
      conversation.name = cleanName(name);
      conversation.updatedAt = now;
      conversation.messages.push({ id: crypto.randomUUID(), role: 'client', author: conversation.name, text, createdAt: now });
      write(state);
      return { clientId: conversation.id, messages: conversation.messages.map(normalizeMessage) };
    },
    async listConversations() {
      const state = read();
      return Object.values(state.conversations).map((conversation) => {
        const last = conversation.messages.at(-1);
        return {
          id: conversation.id,
          name: conversation.name,
          updatedAt: toIso(conversation.updatedAt),
          lastText: last?.text || '',
          lastRole: last?.role || '',
          totalMessages: conversation.messages.length,
        };
      }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    },
    async getConversation(id) {
      const conversation = read().conversations[id];
      return conversation ? { ...conversation, messages: conversation.messages.map(normalizeMessage) } : null;
    },
    async addManagerMessage(id, text) {
      const state = read();
      const conversation = state.conversations[id];
      if (!conversation) return null;
      const now = new Date().toISOString();
      conversation.updatedAt = now;
      conversation.messages.push({ id: crypto.randomUUID(), role: 'manager', author: 'Поддержка Miracle Boost', text, createdAt: now });
      write(state);
      return { ...conversation, messages: conversation.messages.map(normalizeMessage) };
    },
    async addOrder(input) {
      const state = read();
      const now = new Date().toISOString();
      const id = crypto.randomUUID();
      const order = {
        id,
        number: `MB-${String(Object.keys(state.orders).length + 1).padStart(4, '0')}`,
        status: 'queue',
        isPriority: isPriorityCalculation(input.calculation),
        ...input,
        createdAt: now,
        updatedAt: now,
      };
      state.orders[id] = order;
      state.conversations[`order-${id}`] = {
        id: `order-${id}`,
        name: `Заказ ${order.number}`,
        createdAt: now,
        updatedAt: now,
        messages: [{ id: crypto.randomUUID(), role: 'client', author: 'Заявка с сайта', text: orderText(order), createdAt: now }],
      };
      write(state);
      return normalizeOrder(order);
    },
    async listOrders() {
      return Object.values(read().orders).map(normalizeOrder).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    },
    async getOrder(id) {
      return normalizeOrder(read().orders[id] || null);
    },
    async updateOrderStatus(id, status) {
      const state = read();
      const order = state.orders[id];
      if (!order) return null;
      order.status = validateStatus(status);
      order.updatedAt = new Date().toISOString();
      write(state);
      return normalizeOrder(order);
    },
    async verifyAdmin(email, password) {
      const adminEmail = process.env.ADMIN_EMAIL;
      const adminPassword = process.env.ADMIN_PASSWORD;
      if (!adminEmail || !adminPassword) return null;
      if (String(email || '').trim().toLowerCase() !== adminEmail.toLowerCase() || String(password || '') !== adminPassword) return null;
      return { id: 'env-admin', email: adminEmail };
    },
    async createAdminSession(admin, token, request) {
      const tokenHash = hashToken(token);
      sessions.set(tokenHash, {
        adminId: admin.id,
        email: admin.email,
        expiresAt: Date.now() + ADMIN_SESSION_TTL_MS,
        ip: clientIp(request),
      });
    },
    async isAdminSessionValid(token) {
      const tokenHash = hashToken(token);
      const session = sessions.get(tokenHash);
      if (!session || session.expiresAt < Date.now()) {
        sessions.delete(tokenHash);
        return false;
      }
      session.expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
      return true;
    },
    async destroyAdminSession(token) {
      sessions.delete(hashToken(token));
    },
  };
}

async function pgStore() {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_SSL === 'false' ? false : process.env.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  });
  const query = (...args) => pool.query(...args);

  async function init() {
    if (existsSync(schemaPath)) await query(readFileSync(schemaPath, 'utf8'));
  }

  async function messages(conversationId) {
    const result = await query(
      'SELECT id, role, author, text, created_at AS "createdAt" FROM messages WHERE conversation_id = $1 ORDER BY created_at',
      [conversationId],
    );
    return result.rows.map(normalizeMessage);
  }

  async function ensureConversation(id, name = '') {
    const conversationId = clean(id, 120) || crypto.randomUUID();
    const existing = await query('SELECT id FROM conversations WHERE id = $1', [conversationId]);
    if (!existing.rowCount) {
      const now = new Date();
      await query('INSERT INTO conversations(id, name, created_at, updated_at) VALUES($1, $2, $3, $3)', [conversationId, cleanName(name), now]);
      const welcomeMessage = welcome();
      await query(
        'INSERT INTO messages(id, conversation_id, role, author, text, created_at) VALUES($1, $2, $3, $4, $5, $6)',
        [welcomeMessage.id, conversationId, welcomeMessage.role, welcomeMessage.author, welcomeMessage.text, welcomeMessage.createdAt],
      );
    } else if (clean(name)) {
      await query('UPDATE conversations SET name = $2 WHERE id = $1', [conversationId, cleanName(name)]);
    }
    return conversationId;
  }

  async function getOrderById(id) {
    const result = await query(
      'SELECT id, number, status, telegram, email, comment, calculation, is_priority AS "isPriority", created_at AS "createdAt", updated_at AS "updatedAt" FROM orders WHERE id = $1',
      [id],
    );
    return normalizeOrder(result.rows[0] || null);
  }

  return {
    type: 'postgres',
    init,
    async getClientMessages(id, name) {
      const conversationId = await ensureConversation(id, name);
      return { clientId: conversationId, messages: await messages(conversationId) };
    },
    async addClientMessage(id, name, text) {
      const conversationId = await ensureConversation(id, name);
      const now = new Date();
      const author = cleanName(name);
      await query('UPDATE conversations SET name = $2, updated_at = $3 WHERE id = $1', [conversationId, author, now]);
      await query(
        'INSERT INTO messages(id, conversation_id, role, author, text, created_at) VALUES($1, $2, $3, $4, $5, $6)',
        [crypto.randomUUID(), conversationId, 'client', author, text, now],
      );
      return { clientId: conversationId, messages: await messages(conversationId) };
    },
    async listConversations() {
      const result = await query(`
        SELECT c.id, c.name, c.updated_at AS "updatedAt", COALESCE(last_message.text, '') AS "lastText", COALESCE(last_message.role, '') AS "lastRole"
        FROM conversations c
        LEFT JOIN LATERAL (
          SELECT text, role FROM messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1
        ) last_message ON true
        ORDER BY c.updated_at DESC
      `);
      return result.rows.map((row) => ({ ...row, updatedAt: toIso(row.updatedAt) }));
    },
    async getConversation(id) {
      const result = await query('SELECT id, name, created_at AS "createdAt", updated_at AS "updatedAt" FROM conversations WHERE id = $1', [id]);
      return result.rows[0] ? { ...result.rows[0], messages: await messages(id) } : null;
    },
    async addManagerMessage(id, text) {
      const existing = await query('SELECT id FROM conversations WHERE id = $1', [id]);
      if (!existing.rowCount) return null;
      const now = new Date();
      await query('UPDATE conversations SET updated_at = $2 WHERE id = $1', [id, now]);
      await query(
        'INSERT INTO messages(id, conversation_id, role, author, text, created_at) VALUES($1, $2, $3, $4, $5, $6)',
        [crypto.randomUUID(), id, 'manager', 'Поддержка Miracle Boost', text, now],
      );
      return this.getConversation(id);
    },
    async addOrder(input) {
      const now = new Date();
      const sequence = await query("SELECT nextval('public.order_number_seq')::int AS number");
      const id = crypto.randomUUID();
      const order = {
        id,
        number: `MB-${String(sequence.rows[0].number).padStart(4, '0')}`,
        status: 'queue',
        isPriority: isPriorityCalculation(input.calculation),
        ...input,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      await query(
        'INSERT INTO orders(id, number, status, telegram, email, comment, calculation, is_priority, created_at, updated_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)',
        [order.id, order.number, order.status, order.telegram, order.email, order.comment, JSON.stringify(order.calculation), order.isPriority, now],
      );
      await query('INSERT INTO conversations(id, name, created_at, updated_at) VALUES($1, $2, $3, $3)', [`order-${id}`, `Заказ ${order.number}`, now]);
      await query(
        'INSERT INTO messages(id, conversation_id, role, author, text, created_at) VALUES($1, $2, $3, $4, $5, $6)',
        [crypto.randomUUID(), `order-${id}`, 'client', 'Заявка с сайта', orderText(order), now],
      );
      return normalizeOrder(order);
    },
    async listOrders() {
      const result = await query('SELECT id, number, status, telegram, email, comment, calculation, is_priority AS "isPriority", created_at AS "createdAt", updated_at AS "updatedAt" FROM orders ORDER BY created_at DESC');
      return result.rows.map(normalizeOrder);
    },
    async getOrder(id) {
      return getOrderById(id);
    },
    async updateOrderStatus(id, status) {
      const result = await query(
        'UPDATE orders SET status = $2, updated_at = now() WHERE id = $1 RETURNING id, number, status, telegram, email, comment, calculation, is_priority AS "isPriority", created_at AS "createdAt", updated_at AS "updatedAt"',
        [id, validateStatus(status)],
      );
      return normalizeOrder(result.rows[0] || null);
    },
    async verifyAdmin(email, password) {
      const login = clean(email, 160).toLowerCase();
      const plainPassword = String(password || '');
      if (!login || !plainPassword) return null;

      const userResult = await query(
        `SELECT id, email, failed_attempts, locked_until
         FROM admin_users
         WHERE lower(email) = lower($1) AND is_active = true
         LIMIT 1`,
        [login],
      );

      const user = userResult.rows[0];
      if (!user) return null;

      if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
        const err = Error('Слишком много неверных попыток. Попробуйте позже.');
        err.status = 429;
        throw err;
      }

      const validResult = await query(
        `SELECT id, email
         FROM admin_users
         WHERE id = $1 AND password_hash = crypt($2, password_hash)
         LIMIT 1`,
        [user.id, plainPassword],
      );

      if (!validResult.rowCount) {
        await query(
          `UPDATE admin_users
           SET failed_attempts = failed_attempts + 1,
               locked_until = CASE
                 WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes'
                 ELSE locked_until
               END
           WHERE id = $1`,
          [user.id],
        );
        return null;
      }

      await query(
        `UPDATE admin_users
         SET failed_attempts = 0, locked_until = NULL, last_login_at = now()
         WHERE id = $1`,
        [user.id],
      );

      return validResult.rows[0];
    },
    async createAdminSession(admin, token, request) {
      await query('DELETE FROM admin_sessions WHERE expires_at < now()');
      await query(
        `INSERT INTO admin_sessions(admin_user_id, token_hash, expires_at, ip, user_agent)
         VALUES($1, $2, now() + interval '12 hours', $3, $4)`,
        [admin.id, hashToken(token), clientIp(request), clean(request.headers['user-agent'], 300)],
      );
    },
    async isAdminSessionValid(token, request) {
      const tokenHash = hashToken(token);
      const result = await query(
        `UPDATE admin_sessions
         SET expires_at = now() + interval '12 hours'
         WHERE token_hash = $1 AND expires_at > now()
         RETURNING id`,
        [tokenHash],
      );
      return result.rowCount > 0;
    },
    async destroyAdminSession(token) {
      await query('DELETE FROM admin_sessions WHERE token_hash = $1', [hashToken(token)]);
    },
  };
}

async function handleApi(request, response, url) {
  if (url.pathname === '/api/chat/messages' && request.method === 'GET') {
    return send(response, 200, await storage.getClientMessages(url.searchParams.get('clientId'), url.searchParams.get('name')));
  }

  if (url.pathname === '/api/chat/messages' && request.method === 'POST') {
    const body = await readBody(request);
    const text = clean(body.text);
    if (!text) return error(response, 400, 'Введите сообщение');
    return send(response, 201, await storage.addClientMessage(body.clientId, body.name, text));
  }

  if (url.pathname === '/api/orders' && request.method === 'POST') {
    try {
      return send(response, 201, { order: await storage.addOrder(validateOrder(await readBody(request))) });
    } catch (err) {
      return error(response, 400, err.message);
    }
  }

  if (url.pathname === '/api/admin/login' && request.method === 'POST') {
    try {
      checkLoginRateLimit(request);
      const body = await readBody(request);
      const admin = await storage.verifyAdmin(body.email, body.password);
      if (!admin) return error(response, 401, 'Неверный login или password');

      resetLoginRateLimit(request);
      const sessionToken = crypto.randomBytes(32).toString('hex');
      await storage.createAdminSession(admin, sessionToken, request);
      return send(response, 200, { ok: true }, { 'Set-Cookie': adminCookie(sessionToken, request) });
    } catch (err) {
      return error(response, err.status || 400, err.message || 'Ошибка авторизации');
    }
  }

  if (url.pathname === '/api/admin/logout' && request.method === 'POST') {
    const token = tokenFrom(request);
    if (token) await storage.destroyAdminSession(token);
    return send(response, 200, { ok: true }, { 'Set-Cookie': clearAdminCookie() });
  }

  if (url.pathname === '/api/admin/conversations' && request.method === 'GET') {
    if (!(await requireAdmin(request, response))) return;
    return send(response, 200, { conversations: await storage.listConversations() });
  }

  if (url.pathname === '/api/admin/orders' && request.method === 'GET') {
    if (!(await requireAdmin(request, response))) return;
    return send(response, 200, { orders: await storage.listOrders() });
  }

  let match = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if (match && request.method === 'GET') {
    if (!(await requireAdmin(request, response))) return;
    const order = await storage.getOrder(decodeURIComponent(match[1]));
    return order ? send(response, 200, order) : error(response, 404, 'Заказ не найден');
  }

  match = url.pathname.match(/^\/api\/admin\/orders\/([^/]+)\/status$/);
  if (match && request.method === 'PATCH') {
    if (!(await requireAdmin(request, response))) return;
    try {
      const body = await readBody(request);
      const order = await storage.updateOrderStatus(decodeURIComponent(match[1]), body.status);
      return order ? send(response, 200, { order }) : error(response, 404, 'Заказ не найден');
    } catch (err) {
      return error(response, 400, err.message);
    }
  }

  match = url.pathname.match(/^\/api\/admin\/conversations\/([^/]+)$/);
  if (match && request.method === 'GET') {
    if (!(await requireAdmin(request, response))) return;
    const conversation = await storage.getConversation(decodeURIComponent(match[1]));
    return conversation ? send(response, 200, conversation) : error(response, 404, 'Диалог не найден');
  }

  match = url.pathname.match(/^\/api\/admin\/conversations\/([^/]+)\/messages$/);
  if (match && request.method === 'POST') {
    if (!(await requireAdmin(request, response))) return;
    const body = await readBody(request);
    const text = clean(body.text);
    if (!text) return error(response, 400, 'Введите ответ');
    const conversation = await storage.addManagerMessage(decodeURIComponent(match[1]), text);
    return conversation ? send(response, 201, conversation) : error(response, 404, 'Диалог не найден');
  }

  return error(response, 404, 'API endpoint не найден');
}

function serveFile(request, response, url) {
  const requestPath = decodeURIComponent(url.pathname);
  let filePath = join(root, normalize(requestPath).replace(/^(\.\.[/\\])+/, ''));
  if (requestPath === '/') filePath = join(root, 'index.html');
  if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');

  if (!filePath.startsWith(root) || !existsSync(filePath)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('404 — файл не найден');
    return;
  }

  response.writeHead(200, {
    'Content-Type': mime[extname(filePath)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(request, response, url);
    else serveFile(request, response, url);
  } catch (err) {
    console.error(err);
    error(response, 500, err.message || 'Ошибка сервера');
  }
});

storage = process.env.DATABASE_URL ? await pgStore() : jsonStore();
await storage.init();
server.listen(port, () => console.log(`Miracle Boost: http://localhost:${port}`));
