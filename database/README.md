# Supabase database

1. В Supabase откройте **SQL Editor → New query**.
2. Запустите `schema.sql`.
3. После этого запустите `create_admin.sql`, заменив пароль в строке `crypt('ЗАМЕНИ_НА_СЛОЖНЫЙ_ПАРОЛЬ', gen_salt('bf', 12))`.

Логин админки:

```text
miracleboostmanager@gmail.com
```

Пароль не хранится открытым текстом. В таблице `admin_users` сохраняется только bcrypt-хэш через расширение `pgcrypto`.
