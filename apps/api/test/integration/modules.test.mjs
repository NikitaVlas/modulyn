// Интеграционные тесты Phase 6 (6.1–6.5): модули компаний, защита API модуля, меню, данные при отключении.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { prepareTestDatabase } from './setup.mjs';
import { SEED_PASSWORD } from '../../scripts/seed.mjs';
import { Browser } from './browser.mjs';

const apiRoot = fileURLToPath(new URL('../../', import.meta.url));
let env; let app; let port; let tenants; let totp; let platform;

before(async () => {
  env = await prepareTestDatabase();
  ({ tenants } = env.seeded);
  Object.assign(process.env, {
    DATABASE_URL: env.appUrl, APP_BASE_DOMAIN: 'localhost', NODE_ENV: 'test', PUBLIC_PORT: '8080', PUBLIC_SCHEME: 'http', TRUST_PROXY: 'true', SMTP_URL: 'memory:',
  });
  totp = await import('../../dist/auth/totp.js');
  const { createApplication } = await import('../../dist/bootstrap.js');
  app = await createApplication();
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  port = app.getHttpServer().address().port;
  platform = await platformAdmin('modules@platform.example');
});

after(async () => {
  await app?.close();
  await env?.ownerPrisma.$disconnect();
});

const browser = () => new Browser(port);

async function owner(query, params = [], tenantId) {
  const c = new pg.Client({ connectionString: env.ownerUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    if (tenantId) await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await c.query(query, params);
    await c.query('COMMIT');
    return r;
  } finally { await c.end(); }
}

/** Администратор платформы с настроенным вторым фактором (как в тестах Phase 4). */
async function platformAdmin(email) {
  const r = spawnSync(process.execPath, ['scripts/platform-admin.mjs', 'create', '--email', email, '--name', 'Modules Admin'], {
    cwd: apiRoot, encoding: 'utf8', env: { ...process.env, MIGRATION_DATABASE_URL: env.ownerUrl },
  });
  const temp = /Temporary password[^:]*: (\S+)/.exec(r.stdout)[1];
  const b = browser();
  await b.post('admin', '/api/auth/login', { email, password: temp });
  await b.post('admin', '/api/auth/password', { currentPassword: temp, newPassword: 'modules admin passphrase' });
  const secret = totp.base32Decode((await b.post('admin', '/api/auth/mfa/setup')).json.secret);
  await b.post('admin', '/api/auth/mfa/enable', { code: totp.totpCode(secret, totp.currentStep()) });
  return b;
}

async function member(email, slug) {
  const b = browser();
  assert.equal((await b.post('app', '/api/auth/login', { email, password: SEED_PASSWORD })).status, 200);
  assert.equal((await b.enter(slug)).headers.location, '/');
  return b;
}

const setModule = (tenantId, enabled) => platform.patch('admin', `/api/platform/tenants/${tenantId}/modules/leads`, { enabled });

describe('6.1 module registry and catalog', () => {
  test('the database catalog holds the registry modules', async () => {
    const { rows } = await owner('SELECT key, name FROM modules ORDER BY key');
    assert.deepEqual(rows, [{ key: 'leads', name: 'Заявки' }]);
  });

  test('a company sees its enabled modules and its role', async () => {
    const b = await member('manager@shared.example', 'nova');
    assert.deepEqual((await b.get('nova', '/api/tenant/capabilities')).json, { modules: ['leads'], role: 'MANAGER' });
    assert.equal((await browser().get('nova', '/api/tenant/capabilities')).status, 401);
    assert.equal((await browser().get('app', '/api/tenant/capabilities')).status, 404);
  });
});

describe('6.2–6.3 enabling modules and guarding module routes', () => {
  test('the leads summary counts only this company and works for both roles', async () => {
    const manager = await member('manager@shared.example', 'nova');
    const summary = await manager.get('nova', '/api/leads/summary');
    assert.deepEqual(summary.json, { total: 3, byStatus: { NEW: 3, IN_PROGRESS: 0, CONTACTED: 0, CONVERTED: 0, CLOSED: 0 } });
    const bAdmin = await member('admin@company-b.example', 'company-b');
    assert.equal((await bAdmin.get('company-b', '/api/leads/summary')).json.total, 2);
    assert.equal((await browser().get('nova', '/api/leads/summary')).status, 401, 'login first');
    assert.equal((await browser().get('admin', '/api/leads/summary')).status, 404, 'no module routes on the platform');
  });

  test('platform lists modules per company; unknown module and bad payload are refused', async () => {
    const list = await platform.get('admin', `/api/platform/tenants/${tenants.nova.id}/modules`);
    assert.deepEqual(list.json, [{ key: 'leads', name: 'Заявки', description: 'Заявки с сайта и их обработка', enabled: true }]);
    assert.equal((await platform.patch('admin', `/api/platform/tenants/${tenants.nova.id}/modules/tasks`, { enabled: true })).status, 400);
    assert.equal((await platform.patch('admin', `/api/platform/tenants/${tenants.nova.id}/modules/leads`, { enabled: 'yes' })).status, 400);
    assert.equal((await platform.get('admin', '/api/platform/tenants/00000000-0000-7000-8000-000000000000/modules')).status, 404);
    const companyUser = await member('admin@nova.example', 'nova');
    assert.equal((await companyUser.patch('nova', `/api/platform/tenants/${tenants.nova.id}/modules/leads`, { enabled: false })).status, 404, 'company admins cannot toggle modules');
  });
});

describe('6.4–6.5 disabling and re-enabling', () => {
  test('disabling closes the module at once for every role, keeps data, and touches only this company', async () => {
    const manager = await member('manager@shared.example', 'nova');
    const admin = await member('admin@nova.example', 'nova');
    const bAdmin = await member('admin@company-b.example', 'company-b');

    const off = await setModule(tenants.nova.id, false);
    assert.deepEqual(off.json.map(m => [m.key, m.enabled]), [['leads', false]]);
    for (const b of [manager, admin]) {
      const r = await b.get('nova', '/api/leads/summary');
      assert.deepEqual([r.status, r.json.code], [403, 'MODULE_DISABLED']);
    }
    assert.deepEqual((await admin.get('nova', '/api/tenant/capabilities')).json.modules, [], 'menu has no leads');
    assert.equal((await admin.get('nova', '/api/members')).status, 200, 'core routes keep working');
    assert.equal((await admin.get('nova', '/api/auth/me')).status, 200);
    assert.equal((await bAdmin.get('company-b', '/api/leads/summary')).status, 200, 'other company untouched');
    assert.equal((await owner('SELECT count(*)::int AS n FROM leads', [], tenants.nova.id)).rows[0].n, 3, 'data kept');

    await setModule(tenants.nova.id, true);
    assert.equal((await manager.get('nova', '/api/leads/summary')).json.total, 3, 'same data after re-enabling');
    assert.deepEqual((await manager.get('nova', '/api/tenant/capabilities')).json.modules, ['leads']);

    const { rows } = await owner("SELECT action, metadata FROM platform_audit_logs WHERE action LIKE 'module.%' AND target_tenant_id = $1 ORDER BY created_at", [tenants.nova.id]);
    assert.deepEqual(rows.map(r => r.action), ['module.disabled', 'module.enabled']);
    assert.deepEqual(rows[0].metadata, { module: 'leads' });
    const tenantAudit = await owner("SELECT action FROM tenant_audit_logs WHERE action LIKE 'module.%' ORDER BY created_at", [], tenants.nova.id);
    assert.deepEqual(tenantAudit.rows.map(r => r.action), ['module.disabled', 'module.enabled']);
  });

  test('setting the same state again changes nothing and writes no audit', async () => {
    const before = (await owner("SELECT count(*)::int AS n FROM platform_audit_logs WHERE action LIKE 'module.%'")).rows[0].n;
    assert.equal((await setModule(tenants['company-b'].id, true)).status, 200);
    assert.equal((await owner("SELECT count(*)::int AS n FROM platform_audit_logs WHERE action LIKE 'module.%'")).rows[0].n, before);
  });

  test('a new company gets the leads module enabled', async () => {
    const r = await platform.post('admin', '/api/platform/tenants', { slug: 'modco', name: 'Mod Co', displayName: 'Mod CRM', adminEmail: 'boss@modco.example', adminName: 'Boss' });
    assert.equal(r.status, 201);
    assert.deepEqual((await platform.get('admin', `/api/platform/tenants/${r.json.tenant.id}/modules`)).json.map(m => [m.key, m.enabled]), [['leads', true]]);
  });

  test('a company without the module row (never enabled) is treated as disabled', async () => {
    // suspended-co: модуль в seed не включался; включение компании возвращает доступ, но не модуль.
    await platform.patch('admin', `/api/platform/tenants/${tenants['suspended-co'].id}`, { status: 'ACTIVE' });
    const { rows } = await owner('SELECT count(*)::int AS n FROM tenant_modules', [], tenants['suspended-co'].id);
    assert.equal(rows[0].n, 0);
    assert.deepEqual((await platform.get('admin', `/api/platform/tenants/${tenants['suspended-co'].id}/modules`)).json.map(m => m.enabled), [false]);
  });
});
