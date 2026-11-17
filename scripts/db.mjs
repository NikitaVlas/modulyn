// Команды базы данных для локальной разработки. Загружает .env и запускает нужный шаг.
//   pnpm db:roles   — создать/обновить роли modulyn_owner и modulyn_app (суперпользователь, DATABASE_ADMIN_URL)
//   pnpm db:migrate — применить миграции Prisma (владелец схемы, MIGRATION_DATABASE_URL)
//   pnpm db:setup   — roles + migrate
//   pnpm db:seed    — синтетические компании nova, company-b, suspended-co (не для production)
//   pnpm db:drift   — сравнить живую БД со schema.prisma (Prisma; CHECK/RLS/GRANT Prisma не отслеживает)
//   pnpm db:backup  — резервная копия в backups/ (pg_dump в контейнере db)
//   pnpm db:restore-check <файл> — восстановить копию в отдельную базу и сверить
//   pnpm db:cleanup — удалить устаревшие технические записи (сессии, журналы — по срокам F5)
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const api = fileURLToPath(new URL('../apps/api/', import.meta.url));
if (existsSync(root + '.env')) loadEnvFile(root + '.env');

const prismaCli = api + 'node_modules/prisma/build/index.js';
function run(args, cwd = root) {
  const result = spawnSync(process.execPath, args, { cwd, stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
function build() {
  const pnpmCli = process.env.npm_execpath;
  if (!pnpmCli) throw new Error('Run database commands through pnpm (pnpm db:seed)');
  const isScript = /\.[cm]?js$/.test(pnpmCli);
  const result = spawnSync(isScript ? process.execPath : pnpmCli, [...(isScript ? [pnpmCli] : []), '--filter', '@modulyn/api...', 'build'], { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const steps = {
  roles: () => run(['apps/api/scripts/db-roles.mjs']),
  migrate: () => run([prismaCli, 'migrate', 'deploy'], api),
  setup: () => { steps.roles(); steps.migrate(); },
  seed: () => { build(); run(['apps/api/scripts/seed.mjs']); },
  drift: () => run([prismaCli, 'migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema.prisma', '--exit-code'], api),
  // Резервная копия и проверка восстановления (Phase 9.4): pnpm db:backup, pnpm db:restore-check backups/<файл>.dump
  backup: () => run(['apps/api/scripts/backup.mjs', 'backup']),
  // Очистка устаревших технических записей вручную (Phase 9.5); API делает это само раз в час.
  cleanup: () => run(['apps/api/scripts/cleanup.mjs']),
  'restore-check': () => run(['apps/api/scripts/backup.mjs', 'restore-check', ...process.argv.slice(3)]),
  // Администраторы платформы (Phase 4.1): pnpm platform:admin create --email ... --name ...
  'platform-admin': () => { build(); run(['apps/api/scripts/platform-admin.mjs', ...process.argv.slice(3)]); },
};

const command = process.argv[2];
if (!command || !(command in steps)) {
  console.error(`Usage: node scripts/db.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(1);
}
steps[command]();
