// Команды базы данных для локальной разработки. Загружает .env и запускает нужный шаг.
//   pnpm db:roles   — создать/обновить роли modulyn_owner и modulyn_app (суперпользователь, DATABASE_ADMIN_URL)
//   pnpm db:migrate — применить миграции Prisma (владелец схемы, MIGRATION_DATABASE_URL)
//   pnpm db:setup   — roles + migrate
//   pnpm db:seed    — синтетические компании nova, company-b, suspended-co (не для production)
//   pnpm db:drift   — сравнить живую БД со schema.prisma (Prisma; CHECK/RLS/GRANT Prisma не отслеживает)
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
};

const command = process.argv[2];
if (!command || !(command in steps)) {
  console.error(`Usage: node scripts/db.mjs <${Object.keys(steps).join('|')}>`);
  process.exit(1);
}
steps[command]();
