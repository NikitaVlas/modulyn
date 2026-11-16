// Создаёт или дополняет локальный .env. Пароли и ключи JWT случайные и не печатаются.
// Существующие значения не меняются, кроме одного случая обновления до Phase 2:
// DATABASE_URL, указывающий на суперпользователя (POSTGRES_USER), переводится на runtime-роль modulyn_app,
// потому что суперпользователь обходит RLS и API с ним откажется работать. Старое значение не теряется:
// то же подключение сохраняется как DATABASE_ADMIN_URL (используется только для pnpm db:roles и тестов).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../.env', import.meta.url));
const secret = () => randomBytes(24).toString('hex');
const existed = existsSync(path);
const lines = existed ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
const values = new Map();
for (const line of lines) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (match) values.set(match[1], match[2]);
}

const defaults = [
  ['POSTGRES_USER', () => 'modulyn'],
  ['POSTGRES_PASSWORD', secret],
  ['POSTGRES_DB', () => 'modulyn'],
  ['POSTGRES_PORT', () => '5433'],
  ['DB_OWNER_PASSWORD', secret],
  ['DB_APP_PASSWORD', secret],
  ['DATABASE_ADMIN_URL', v => `postgresql://${v.get('POSTGRES_USER')}:${v.get('POSTGRES_PASSWORD')}@127.0.0.1:${v.get('POSTGRES_PORT')}/${v.get('POSTGRES_DB')}`],
  ['MIGRATION_DATABASE_URL', v => `postgresql://modulyn_owner:${v.get('DB_OWNER_PASSWORD')}@127.0.0.1:${v.get('POSTGRES_PORT')}/${v.get('POSTGRES_DB')}`],
  ['DATABASE_URL', v => `postgresql://modulyn_app:${v.get('DB_APP_PASSWORD')}@127.0.0.1:${v.get('POSTGRES_PORT')}/${v.get('POSTGRES_DB')}`],
  ['APP_BASE_DOMAIN', () => 'localhost'],
  ['API_PORT', () => '3001'],
  ['NODE_ENV', () => 'development'],
  ['HTTP_PORT', () => '8080'],
  // Phase 3: отдельный ключ подписи JWT для каждого контекста (A3).
  ['JWT_SECRET_TENANT', () => randomBytes(32).toString('hex')],
  ['JWT_SECRET_APP', () => randomBytes(32).toString('hex')],
  ['JWT_SECRET_PLATFORM', () => randomBytes(32).toString('hex')],
  // Phase 4: ключ шифрования секретов второго фактора администраторов платформы (B2). Потеря = заново настроить 2FA.
  ['PLATFORM_TOTP_KEY', () => randomBytes(32).toString('hex')],
  // Публичные адреса для перенаправлений между app.<домен> и поддоменами компаний.
  ['PUBLIC_SCHEME', () => 'http'],
  ['PUBLIC_PORT', v => v.get('HTTP_PORT')],
  // Phase 5: почта для pnpm dev — Mailpit из Compose (pnpm infra:up). Compose-стек использует свой адрес mailpit:1025.
  ['SMTP_URL', () => 'smtp://127.0.0.1:1025'],
  // Вход через Google: значения из Google Cloud Console (README). Пусто — кнопка Google скрыта.
  ['GOOGLE_CLIENT_ID', () => ''],
  ['GOOGLE_CLIENT_SECRET', () => ''],
];

const added = [];
let upgradedDatabaseUrl = false;
const current = values.get('DATABASE_URL');
if (current) {
  try {
    if (decodeURIComponent(new URL(current).username) === values.get('POSTGRES_USER')) {
      if (!values.has('DATABASE_ADMIN_URL')) values.set('DATABASE_ADMIN_URL', current);
      values.delete('DATABASE_URL');
      upgradedDatabaseUrl = true;
    }
  } catch { /* некорректный URL оставляем как есть: API сообщит об ошибке при запуске */ }
}
for (const [key, make] of defaults) {
  if (!values.has(key)) { values.set(key, make(values)); added.push(key); }
}

// Сохраняем порядок и комментарии существующего файла; новые ключи дописываем в конец.
const written = new Set();
const out = lines.filter((line, i) => !(i === lines.length - 1 && line === '')).map(line => {
  const match = /^([A-Z0-9_]+)=/.exec(line);
  if (!match) return line;
  written.add(match[1]);
  return `${match[1]}=${values.get(match[1])}`;
});
for (const [key] of defaults) if (!written.has(key)) out.push(`${key}=${values.get(key)}`);
writeFileSync(path, out.join('\n') + '\n', { mode: 0o600 });

if (!existed) console.log('Created local .env with random passwords (not printed).');
else if (added.length === 0) console.log('.env already complete; kept unchanged.');
else console.log(`Updated .env: added ${added.join(', ')} (passwords not printed).`);
if (upgradedDatabaseUrl) console.log('DATABASE_URL now uses the runtime role modulyn_app; the superuser URL is kept as DATABASE_ADMIN_URL. Run pnpm db:setup next.');
