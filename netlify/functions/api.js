const crypto = require('node:crypto');
const { Pool } = require('pg');

const ADMIN_SESSION_TTL_SECONDS = 12 * 60 * 60;
const ADMIN_SESSION_TTL_MS = ADMIN_SESSION_TTL_SECONDS * 1000;
const STATUSES = ['queue', 'payment', 'boosting', 'done'];
const ELO_LIMITS = Object.freeze({
  minCurrent: 100,
  maxCurrent: 2000,
  minTarget: 101,
  maxTarget: 2001,
});

const STATUS_LABELS = {
  queue: 'В очереди',
  payment: 'Ожидание оплаты',
  boosting: 'Ведётся буст',
  done: 'Выполнен',
};

let pool;

function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL не задан в Netlify Environment variables');
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 2),
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
    });
  }

  return pool;
}

function query(text, params = []) {
  return getPool().query(text, params);
}

function json(statusCode, data, headers = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    },
    body: JSON.stringify(data),
  };
}

function clean(value, limit = 1200) {
  return String(value || '').replace(/\r\n/g, '\n').trim().slice(0, limit);
}

function cleanName(value) {
  return clean(value, 40) || 'Клиент';
}

function normalizeDate(value) {
  if (!value) return new Date().toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeMessage(message) {
  return message && {
    id: message.id,
    role: message.role,
    author: message.author,
    text: message.text,
    createdAt: normalizeDate(message.createdAt ?? message.created_at),
  };
}

function normalizeOrder(order) {
  return order && {
    id: order.id,
    number: order.number,
    status: STATUSES.includes(order.status) ? order.status : 'queue',
    telegram: order.telegram,
    email: order.email,
    comment: order.comment || '',
    calculation: typeof order.calculation === 'string' ? JSON.parse(order.calculation) : order.calculation,
    isPriority: Boolean(order.isPriority ?? order.is_priority),
    createdAt: normalizeDate(order.createdAt ?? order.created_at),
    updatedAt: normalizeDate(order.updatedAt ?? order.updated_at),
  };
}

function rub(value) {
  return `${Math.round(Number(value || 0)).toLocaleString('ru-RU')} ₽`;
}

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

  if (!telegram) throw new Error('Укажите Telegram');
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Укажите корректную почту');
  if (!calculation.valid) throw new Error('Некорректный расчёт');

  const current = Number(calculation.current);
  const target = Number(calculation.target);
  if (!Number.isFinite(current) || !Number.isFinite(target)) throw new Error('Укажите корректные значения ELO');
  if (current < ELO_LIMITS.minCurrent) throw new Error(`Текущее ELO не может быть ниже ${ELO_LIMITS.minCurrent}`);
  if (current > ELO_LIMITS.maxCurrent) throw new Error(`Текущее ELO не может быть выше ${ELO_LIMITS.maxCurrent}`);
  if (target < ELO_LIMITS.minTarget) throw new Error(`Желаемое ELO не может быть ниже ${ELO_LIMITS.minTarget}`);
  if (target > ELO_LIMITS.maxTarget) throw new Error(`Желаемое ELO не может быть выше ${ELO_LIMITS.maxTarget}`);
  if (target <= current) throw new Error('Желаемое ELO должно быть выше текущего');

  return { telegram, email, comment, calculation };
}

function validateStatus(status) {
  if (!STATUSES.includes(status)) throw new Error('Некорректный статус заказа');
  return status;
}

function clientIp(event) {
  return String(event.headers['x-forwarded-for'] || event.headers['client-ip'] || '').split(',')[0].trim();
}

function parseBody(event) {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    const err = new Error('Некорректный JSON');
    err.status = 400;
    throw err;
  }
}

function parseCookies(event) {
  const header = String(event.headers.cookie || event.headers.Cookie || '');
  const cookies = {};

  for (const part of header.split(';')) {
    const item = part.trim();
    if (!item) continue;
    const index = item.indexOf('=');
    if (index === -1) continue;
    const key = decodeURIComponent(item.slice(0, index));
    const value = decodeURIComponent(item.slice(index + 1));
    cookies[key] = value;
  }

  return cookies;
}

function tokenFrom(event) {
  const authorization = String(event.headers.authorization || event.headers.Authorization || '');
  if (authorization.startsWith('Bearer ')) return authorization.slice(7);
  return parseCookies(event).mb_admin || '';
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function adminCookie(token) {
  const secure = process.env.NODE_ENV === 'production' ? 'Secure' : '';
  return [
    `mb_admin=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    secure.trim(),
    `Max-Age=${ADMIN_SESSION_TTL_SECONDS}`,
  ].filter(Boolean).join('; ');
}

function clearAdminCookie() {
  return 'mb_admin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

async function requireAdmin(event) {
  const token = tokenFrom(event);
  if (!token) return null;

  const result = await query(
    `UPDATE public.admin_sessions s
     SET expires_at = now() + interval '12 hours'
     FROM public.admin_users u
     WHERE s.admin_user_id = u.id
       AND s.token_hash = $1
       AND s.expires_at > now()
       AND u.is_active = true
     RETURNING u.id, u.email`,
    [hashToken(token)],
  );

  return result.rows[0] || null;
}

function getApiPath(event) {
  const rawUrl = event.rawUrl || `https://local${event.path || '/'}`;
  const url = new URL(rawUrl);
  let pathname = url.pathname;

  if (pathname.startsWith('/.netlify/functions/api/')) {
    pathname = `/api/${pathname.slice('/.netlify/functions/api/'.length)}`;
  } else if (pathname === '/.netlify/functions/api') {
    pathname = '/api';
  }

  return { pathname, searchParams: url.searchParams };
}

async function ensureConversation(id, name = '') {
  const conversationId = clean(id, 120) || crypto.randomUUID();
  const existing = await query('SELECT id FROM public.conversations WHERE id = $1', [conversationId]);

  if (!existing.rowCount) {
    const now = new Date();
    await query(
      'INSERT INTO public.conversations(id, name, created_at, updated_at) VALUES($1, $2, $3, $3)',
      [conversationId, cleanName(name), now],
    );
    await query(
      `INSERT INTO public.messages(id, conversation_id, role, author, text, created_at)
       VALUES($1, $2, 'manager', 'Поддержка Miracle Boost', $3, $4)`,
      [crypto.randomUUID(), conversationId, 'Здравствуйте! Это поддержка Miracle Boost. Напишите ваш вопрос — поможем с расчётом, оформлением или сделкой через FunPay.', now],
    );
  } else if (clean(name)) {
    await query('UPDATE public.conversations SET name = $2 WHERE id = $1', [conversationId, cleanName(name)]);
  }

  return conversationId;
}

async function getMessages(conversationId) {
  const result = await query(
    `SELECT id, role, author, text, created_at AS "createdAt"
     FROM public.messages
     WHERE conversation_id = $1
     ORDER BY created_at ASC`,
    [conversationId],
  );

  return result.rows.map(normalizeMessage);
}

async function handleChatMessages(event, searchParams) {
  if (event.httpMethod === 'GET') {
    const conversationId = await ensureConversation(searchParams.get('clientId'), searchParams.get('name'));
    return json(200, { clientId: conversationId, messages: await getMessages(conversationId) });
  }

  if (event.httpMethod === 'POST') {
    const body = parseBody(event);
    const text = clean(body.text);
    if (!text) return json(400, { error: 'Введите сообщение' });

    const conversationId = await ensureConversation(body.clientId, body.name);
    const now = new Date();
    const author = cleanName(body.name);

    await query('UPDATE public.conversations SET name = $2, updated_at = $3 WHERE id = $1', [conversationId, author, now]);
    await query(
      `INSERT INTO public.messages(id, conversation_id, role, author, text, created_at)
       VALUES($1, $2, 'client', $3, $4, $5)`,
      [crypto.randomUUID(), conversationId, author, text, now],
    );

    return json(201, { clientId: conversationId, messages: await getMessages(conversationId) });
  }

  return json(405, { error: 'Method not allowed' });
}

async function handleCreateOrder(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const input = validateOrder(parseBody(event));
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
    `INSERT INTO public.orders(id, number, status, telegram, email, comment, calculation, is_priority, created_at, updated_at)
     VALUES($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $9)`,
    [order.id, order.number, order.status, order.telegram, order.email, order.comment, JSON.stringify(order.calculation), order.isPriority, now],
  );

  await query(
    'INSERT INTO public.conversations(id, name, created_at, updated_at) VALUES($1, $2, $3, $3)',
    [`order-${id}`, `Заказ ${order.number}`, now],
  );
  await query(
    `INSERT INTO public.messages(id, conversation_id, role, author, text, created_at)
     VALUES($1, $2, 'client', 'Заявка с сайта', $3, $4)`,
    [crypto.randomUUID(), `order-${id}`, orderText(order), now],
  );

  return json(201, { order: normalizeOrder(order) });
}

async function handleAdminLogin(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = parseBody(event);
  const email = clean(body.email, 160).toLowerCase();
  const password = String(body.password || '');

  if (!email || !password) return json(400, { error: 'Введите email и пароль' });

  const userResult = await query(
    `SELECT id, email, failed_attempts, locked_until
     FROM public.admin_users
     WHERE lower(email) = lower($1) AND is_active = true
     LIMIT 1`,
    [email],
  );

  const user = userResult.rows[0];
  if (!user) return json(401, { error: 'Неверный логин или пароль' });

  if (user.locked_until && new Date(user.locked_until).getTime() > Date.now()) {
    return json(429, { error: 'Слишком много неверных попыток. Попробуйте позже.' });
  }

  const validResult = await query(
    `SELECT id, email
     FROM public.admin_users
     WHERE id = $1 AND password_hash = crypt($2, password_hash)
     LIMIT 1`,
    [user.id, password],
  );

  if (!validResult.rowCount) {
    await query(
      `UPDATE public.admin_users
       SET failed_attempts = failed_attempts + 1,
           locked_until = CASE
             WHEN failed_attempts + 1 >= 5 THEN now() + interval '15 minutes'
             ELSE locked_until
           END
       WHERE id = $1`,
      [user.id],
    );
    return json(401, { error: 'Неверный логин или пароль' });
  }

  await query(
    `UPDATE public.admin_users
     SET failed_attempts = 0, locked_until = NULL, last_login_at = now()
     WHERE id = $1`,
    [user.id],
  );

  await query('DELETE FROM public.admin_sessions WHERE expires_at < now()');

  const token = crypto.randomBytes(32).toString('hex');
  await query(
    `INSERT INTO public.admin_sessions(admin_user_id, token_hash, expires_at, ip, user_agent)
     VALUES($1, $2, now() + interval '12 hours', $3, $4)`,
    [validResult.rows[0].id, hashToken(token), clientIp(event), clean(event.headers['user-agent'], 300)],
  );

  return json(200, { ok: true }, { 'Set-Cookie': adminCookie(token) });
}

async function handleAdminLogout(event) {
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const token = tokenFrom(event);
  if (token) await query('DELETE FROM public.admin_sessions WHERE token_hash = $1', [hashToken(token)]);
  return json(200, { ok: true }, { 'Set-Cookie': clearAdminCookie() });
}


async function handleAdminMe(event) {
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  const admin = await requireAdmin(event);
  if (!admin) return json(401, { error: 'Нужна авторизация' });
  return json(200, { ok: true, admin: { email: admin.email } });
}

async function handleAdminConversations(event) {
  const admin = await requireAdmin(event);
  if (!admin) return json(401, { error: 'Нужна авторизация' });

  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const result = await query(`
    SELECT
      c.id,
      c.name,
      c.updated_at AS "updatedAt",
      COALESCE(last_message.text, '') AS "lastText",
      COALESCE(last_message.role, '') AS "lastRole",
      COALESCE(stats.total_messages, 0)::int AS "totalMessages"
    FROM public.conversations c
    LEFT JOIN LATERAL (
      SELECT text, role
      FROM public.messages
      WHERE conversation_id = c.id
      ORDER BY created_at DESC
      LIMIT 1
    ) last_message ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS total_messages
      FROM public.messages
      WHERE conversation_id = c.id
    ) stats ON true
    ORDER BY c.updated_at DESC
  `);

  return json(200, { conversations: result.rows.map((row) => ({ ...row, updatedAt: normalizeDate(row.updatedAt) })) });
}

async function handleAdminConversation(event, conversationId) {
  const admin = await requireAdmin(event);
  if (!admin) return json(401, { error: 'Нужна авторизация' });

  if (event.httpMethod === 'GET') {
    const result = await query(
      'SELECT id, name, created_at AS "createdAt", updated_at AS "updatedAt" FROM public.conversations WHERE id = $1',
      [conversationId],
    );
    const conversation = result.rows[0];
    if (!conversation) return json(404, { error: 'Диалог не найден' });
    return json(200, {
      ...conversation,
      createdAt: normalizeDate(conversation.createdAt),
      updatedAt: normalizeDate(conversation.updatedAt),
      messages: await getMessages(conversationId),
    });
  }

  return json(405, { error: 'Method not allowed' });
}

async function handleAdminConversationMessage(event, conversationId) {
  const admin = await requireAdmin(event);
  if (!admin) return json(401, { error: 'Нужна авторизация' });

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = parseBody(event);
  const text = clean(body.text);
  if (!text) return json(400, { error: 'Введите ответ' });

  const existing = await query('SELECT id FROM public.conversations WHERE id = $1', [conversationId]);
  if (!existing.rowCount) return json(404, { error: 'Диалог не найден' });

  const now = new Date();
  await query('UPDATE public.conversations SET updated_at = $2 WHERE id = $1', [conversationId, now]);
  await query(
    `INSERT INTO public.messages(id, conversation_id, role, author, text, created_at)
     VALUES($1, $2, 'manager', 'Поддержка Miracle Boost', $3, $4)`,
    [crypto.randomUUID(), conversationId, text, now],
  );

  const result = await query(
    'SELECT id, name, created_at AS "createdAt", updated_at AS "updatedAt" FROM public.conversations WHERE id = $1',
    [conversationId],
  );
  const conversation = result.rows[0];

  return json(201, {
    ...conversation,
    createdAt: normalizeDate(conversation.createdAt),
    updatedAt: normalizeDate(conversation.updatedAt),
    messages: await getMessages(conversationId),
  });
}

async function handleAdminOrders(event) {
  const admin = await requireAdmin(event);
  if (!admin) return json(401, { error: 'Нужна авторизация' });

  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const result = await query(
    `SELECT id, number, status, telegram, email, comment, calculation, is_priority AS "isPriority", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM public.orders
     ORDER BY is_priority DESC, created_at DESC`,
  );

  return json(200, { orders: result.rows.map(normalizeOrder) });
}

async function handleAdminOrder(event, orderId) {
  const admin = await requireAdmin(event);
  if (!admin) return json(401, { error: 'Нужна авторизация' });

  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const result = await query(
    `SELECT id, number, status, telegram, email, comment, calculation, is_priority AS "isPriority", created_at AS "createdAt", updated_at AS "updatedAt"
     FROM public.orders
     WHERE id = $1`,
    [orderId],
  );

  const order = normalizeOrder(result.rows[0] || null);
  return order ? json(200, order) : json(404, { error: 'Заказ не найден' });
}

async function handleAdminOrderStatus(event, orderId) {
  const admin = await requireAdmin(event);
  if (!admin) return json(401, { error: 'Нужна авторизация' });

  if (event.httpMethod !== 'PATCH') return json(405, { error: 'Method not allowed' });

  const body = parseBody(event);
  const result = await query(
    `UPDATE public.orders
     SET status = $2, updated_at = now()
     WHERE id = $1
     RETURNING id, number, status, telegram, email, comment, calculation, is_priority AS "isPriority", created_at AS "createdAt", updated_at AS "updatedAt"`,
    [orderId, validateStatus(body.status)],
  );

  const order = normalizeOrder(result.rows[0] || null);
  return order ? json(200, { order }) : json(404, { error: 'Заказ не найден' });
}

exports.handler = async (event) => {
  try {
    const { pathname, searchParams } = getApiPath(event);

    if (pathname === '/api/chat/messages') return await handleChatMessages(event, searchParams);
    if (pathname === '/api/orders') return await handleCreateOrder(event);
    if (pathname === '/api/admin/login') return await handleAdminLogin(event);
    if (pathname === '/api/admin/logout') return await handleAdminLogout(event);
    if (pathname === '/api/admin/me') return await handleAdminMe(event);
    if (pathname === '/api/admin/conversations') return await handleAdminConversations(event);
    if (pathname === '/api/admin/orders') return await handleAdminOrders(event);

    let match = pathname.match(/^\/api\/admin\/orders\/([^/]+)$/);
    if (match) return await handleAdminOrder(event, decodeURIComponent(match[1]));

    match = pathname.match(/^\/api\/admin\/orders\/([^/]+)\/status$/);
    if (match) return await handleAdminOrderStatus(event, decodeURIComponent(match[1]));

    match = pathname.match(/^\/api\/admin\/conversations\/([^/]+)$/);
    if (match) return await handleAdminConversation(event, decodeURIComponent(match[1]));

    match = pathname.match(/^\/api\/admin\/conversations\/([^/]+)\/messages$/);
    if (match) return await handleAdminConversationMessage(event, decodeURIComponent(match[1]));

    return json(404, { error: 'API endpoint не найден' });
  } catch (error) {
    console.error(error);
    return json(error.status || 500, { error: error.message || 'Ошибка сервера' });
  }
};
