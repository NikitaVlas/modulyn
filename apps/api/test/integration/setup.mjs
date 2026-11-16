// Подготовка изолированной тестовой БД для интеграционных тестов (подшаг 2.6).
// Берёт DATABASE_ADMIN_URL, DB_OWNER_PASSWORD, DB_APP_PASSWORD из окружения (pnpm test:integration загружает .env),
// пересоздаёт базу <имя>_test в том же кластере, создаёт роли, применяет миграции и синтетический seed.
// Рабочая база не затрагивается: имя тестовой базы обязано оканчиваться на _test.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../dist/generated/prisma/client.js';
import { seed } from '../../scripts/seed.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

function withDatabase(url, name, user, password) {
  const u = new URL(url);
  u.pathname = '/' + name;
  if (user) { u.username = user; u.password = password; }
  return u.toString();
}

export async function prepareTestDatabase() {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  const ownerPassword = process.env.DB_OWNER_PASSWORD;
  const appPassword = process.env.DB_APP_PASSWORD;
  if (!adminUrl || !ownerPassword || !appPassword) {
    throw new Error('Integration tests need DATABASE_ADMIN_URL, DB_OWNER_PASSWORD, DB_APP_PASSWORD (pnpm env:init, pnpm infra:up)');
  }
  const baseName = decodeURIComponent(new URL(adminUrl).pathname.slice(1));
  const testName = process.env.TEST_DATABASE_NAME ?? `${baseName}_test`;
  if (!/^[a-z0-9_]+_test$/.test(testName)) throw new Error('Test database name must end with _test');

  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(testName)} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(testName)}`);
  await admin.end();

  const testAdminUrl = withDatabase(adminUrl, testName);
  const roles = spawnSync(process.execPath, ['scripts/db-roles.mjs'], {
    cwd: root, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, DATABASE_ADMIN_URL: testAdminUrl },
  });
  if (roles.status !== 0) throw new Error('db-roles failed: ' + roles.stderr);

  const ownerUrl = withDatabase(adminUrl, testName, 'modulyn_owner', ownerPassword);
  const appUrl = withDatabase(adminUrl, testName, 'modulyn_app', appPassword);

  // Те же SQL-файлы, что применяет prisma migrate deploy, в том же порядке.
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  const dir = root + 'prisma/migrations/';
  for (const name of readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()) {
    await owner.query(readFileSync(dir + name + '/migration.sql', 'utf8'));
  }
  await owner.end();

  const ownerPrisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: ownerUrl }) });
  const seeded = await seed(ownerPrisma);
  return { adminUrl: testAdminUrl, ownerUrl, appUrl, ownerPrisma, seeded };
}
