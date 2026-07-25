-- Miracle Boost: Supabase / PostgreSQL schema
-- Вставьте этот код в Supabase SQL Editor и нажмите Run.
-- Пароль админа НЕ хранится открытым текстом: хранится только bcrypt-хэш через pgcrypto crypt().

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SEQUENCE IF NOT EXISTS public.order_number_seq START 1;

CREATE TABLE IF NOT EXISTS public.conversations (
  id TEXT PRIMARY KEY,
  name VARCHAR(80) NOT NULL DEFAULT 'Клиент',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id TEXT NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  role VARCHAR(16) NOT NULL CHECK (role IN ('client', 'manager')),
  author VARCHAR(80) NOT NULL,
  text TEXT NOT NULL CHECK (length(trim(text)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number VARCHAR(24) NOT NULL UNIQUE,
  status VARCHAR(24) NOT NULL DEFAULT 'queue',
  telegram VARCHAR(80) NOT NULL,
  email VARCHAR(120) NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  calculation JSONB NOT NULL,
  is_priority BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT orders_status_check CHECK (status IN ('queue', 'payment', 'boosting', 'done'))
);

CREATE TABLE IF NOT EXISTS public.admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE CHECK (position('@' in email) > 1),
  password_hash TEXT NOT NULL CHECK (length(password_hash) >= 20),
  is_active BOOLEAN NOT NULL DEFAULT true,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.admin_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES public.admin_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- Миграция для старой версии таблицы, если она уже была создана ранее.
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS is_priority BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE public.orders ALTER COLUMN status SET DEFAULT 'queue';
UPDATE public.orders SET status = 'queue' WHERE status = 'new';
UPDATE public.orders
SET is_priority = EXISTS (
  SELECT 1
  FROM jsonb_array_elements(COALESCE(calculation->'addons', '[]'::jsonb)) addon
  WHERE lower(COALESCE(addon->>'label', addon::text)) LIKE '%приоритет%'
)
WHERE is_priority = false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'orders_status_check' AND conrelid = 'public.orders'::regclass
  ) THEN
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_status_check CHECK (status IN ('queue', 'payment', 'boosting', 'done'));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS conversations_touch_updated_at ON public.conversations;
CREATE TRIGGER conversations_touch_updated_at
BEFORE UPDATE ON public.conversations
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS orders_touch_updated_at ON public.orders;
CREATE TRIGGER orders_touch_updated_at
BEFORE UPDATE ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS admin_users_touch_updated_at ON public.admin_users;
CREATE TRIGGER admin_users_touch_updated_at
BEFORE UPDATE ON public.admin_users
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE INDEX IF NOT EXISTS conversations_updated_at_idx ON public.conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS messages_conversation_created_at_idx ON public.messages(conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS orders_created_at_idx ON public.orders(created_at DESC);
CREATE INDEX IF NOT EXISTS orders_status_idx ON public.orders(status);
CREATE INDEX IF NOT EXISTS orders_priority_idx ON public.orders(is_priority) WHERE is_priority = true;
CREATE INDEX IF NOT EXISTS admin_users_lower_email_idx ON public.admin_users(lower(email));
CREATE INDEX IF NOT EXISTS admin_sessions_token_hash_idx ON public.admin_sessions(token_hash);
CREATE INDEX IF NOT EXISTS admin_sessions_expires_at_idx ON public.admin_sessions(expires_at);

-- Node-сервер подключается к Supabase PostgreSQL через DATABASE_URL.
-- Не вставляйте DATABASE_URL, service_role key и пароли в frontend JS/HTML.
-- При работе только через backend RLS можно не включать для этих таблиц.
ALTER TABLE public.conversations DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_sessions DISABLE ROW LEVEL SECURITY;
