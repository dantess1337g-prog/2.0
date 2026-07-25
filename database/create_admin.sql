-- Создание или смена админа Miracle Boost.
-- ВАЖНО: замените email и пароль перед запуском в Supabase SQL Editor.
-- Пароль в таблицу не попадёт — будет сохранён только bcrypt-хэш.

INSERT INTO public.admin_users (email, password_hash, is_active, failed_attempts, locked_until)
VALUES (
  'miracleboostmanager@gmail.com',
  crypt('ЗАМЕНИ_НА_СЛОЖНЫЙ_ПАРОЛЬ', gen_salt('bf', 12)),
  true,
  0,
  NULL
)
ON CONFLICT (email) DO UPDATE SET
  password_hash = EXCLUDED.password_hash,
  is_active = true,
  failed_attempts = 0,
  locked_until = NULL,
  updated_at = now();
