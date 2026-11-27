// .env для выделенной установки у клиента (Phase 11, E2, E5–E9). Запуск из образа migrate, без исходного кода на сервере:
//   docker run --rm -v "$PWD:/out" <registry>/modulyn-migrate:<version> node apps/api/scripts/server-env.mjs \
//     --out /out/.env --crm crm.example.de --login login.crm.example.de --admin admin.crm.example.de --company nova \
//     --acme-email you@example.de --registry ghcr.io/<owner> --version 0.11.0
// Пароли и ключи — случайные, не печатаются. Существующий файл не перезаписывается. Почта, бренд и копии заполняются вручную (помечены TODO).
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, all) => (cur.startsWith('--') ? [...acc, [cur.slice(2), all[i + 1] ?? '']] : acc), []));
const HOST = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const fail = message => { console.error(`server-env: ${message}`); process.exit(1); };

const out = args.out || fail('--out is required');
if (existsSync(out)) fail(`${out} already exists — not overwritten`);
const crm = (args.crm ?? '').toLowerCase(); const login = (args.login ?? '').toLowerCase(); const admin = (args.admin ?? '').toLowerCase();
for (const [name, value] of [['--crm', crm], ['--login', login], ['--admin', admin]]) if (!HOST.test(value)) fail(`${name} must be a host name like crm.example.de`);
if (new Set([crm, login, admin]).size !== 3) fail('--crm, --login and --admin must be different');
const company = (args.company ?? '').toLowerCase();
if (!SLUG.test(company)) fail('--company must be a company slug like nova');
const acmeEmail = args['acme-email'] ?? '';
const local = [crm, login, admin].every(h => h.endsWith('.localhost'));
if (!local && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(acmeEmail)) fail('--acme-email is required (Let’s Encrypt notices)');
const registry = args.registry || fail('--registry is required, e.g. ghcr.io/<owner>');
const version = args.version || fail('--version is required');

const secret = () => randomBytes(24).toString('hex');
const lines = [
  '# Modulyn — выделенная установка. Создано server-env.mjs. Права файла: 600. Не храните рядом с резервными копиями.',
  `MODULYN_REGISTRY=${registry}`, `MODULYN_VERSION=${version}`, '',
  '# Адреса (E2): CRM, вход, платформа. DNS всех трёх имён — на этот сервер.',
  `APP_BASE_DOMAIN=${crm}`, `TENANT_HOSTS=${crm}=${company}`, `APP_HOST=${login}`, `PLATFORM_HOST=${admin}`,
  `CADDY_HOSTS=${crm}, ${login}, ${admin}`, `CADDY_TLS=${local ? 'internal' : acmeEmail}`, '',
  '# База данных',
  'POSTGRES_USER=modulyn', `POSTGRES_PASSWORD=${secret()}`, 'POSTGRES_DB=modulyn', `DB_OWNER_PASSWORD=${secret()}`, `DB_APP_PASSWORD=${secret()}`, '',
  '# Ключи. PLATFORM_TOTP_KEY — копию в менеджер паролей (без него второй фактор администратора не восстановить).',
  `JWT_SECRET_TENANT=${secret()}`, `JWT_SECRET_APP=${secret()}`, `JWT_SECRET_PLATFORM=${secret()}`, `PLATFORM_TOTP_KEY=${randomBytes(32).toString('hex')}`, '',
  '# Почта (E7) — TODO: ящик на домене клиента, например smtps://crm%40example.de:<пароль>@smtp.strato.de:465',
  'SMTP_URL=', 'MAIL_FROM=', '',
  '# Бренд (E4) — по желанию: название, цвет #RRGGBB, логотип (файл в папке brand/ → /brand/logo.svg)',
  'BRAND_NAME=', 'BRAND_COLOR=', 'BRAND_LOGO_URL=', '',
  '# Резервные копии (E9) — TODO: публичный ключ age и хранилище вне сервера (rclone).',
  'BACKUP_TIME=02:30', 'BACKUP_AGE_RECIPIENT=', 'BACKUP_REMOTE=offsite:modulyn-backups', 'BACKUP_PING_URL=',
  'RCLONE_CONFIG_OFFSITE_TYPE=', 'RCLONE_CONFIG_OFFSITE_URL=', 'RCLONE_CONFIG_OFFSITE_VENDOR=', 'RCLONE_CONFIG_OFFSITE_USER=', 'RCLONE_CONFIG_OFFSITE_PASS=',
  'RCLONE_CONFIG_OFFSITE_PROVIDER=', 'RCLONE_CONFIG_OFFSITE_ENDPOINT=', 'RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=', 'RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=', '',
  '# Вход через Google — по желанию', 'GOOGLE_CLIENT_ID=', 'GOOGLE_CLIENT_SECRET=', '',
];
writeFileSync(out, lines.join('\n'), { mode: 0o600 });
console.log(`server-env: ${out} created (passwords and keys not printed). Fill in the TODO lines: mail and backups.`);
