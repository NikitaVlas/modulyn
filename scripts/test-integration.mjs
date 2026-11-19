// Интеграционные тесты на реальном PostgreSQL (подшаг 2.6). Нужен запущенный db: pnpm infra:up.
// Загружает .env (DATABASE_ADMIN_URL, DB_OWNER_PASSWORD, DB_APP_PASSWORD) и пересоздаёт отдельную базу <POSTGRES_DB>_test.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
if (existsSync(root + '.env')) loadEnvFile(root + '.env');
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('Run through pnpm: pnpm test:integration');
const isScript = /\.[cm]?js$/.test(pnpmCli);
for (const args of [['--filter', '@modulyn/contracts', '--filter', '@modulyn/i18n', 'build'], ['--filter', '@modulyn/api', 'test:integration']]) {
  const result = spawnSync(isScript ? process.execPath : pnpmCli, [...(isScript ? [pnpmCli] : []), ...args], { cwd: root, stdio: 'inherit', env: process.env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
