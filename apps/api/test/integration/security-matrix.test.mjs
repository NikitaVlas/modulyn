// Phase 9 (9.2, F2): матрица всех маршрутов API. Список маршрутов берётся из самого приложения (метаданные Nest),
// поэтому новый маршрут без защиты или новый публичный маршрут сразу уронит этот тест.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { prepareTestDatabase } from './setup.mjs';
import { SEED_PASSWORD } from '../../scripts/seed.mjs';
import { Browser, host, origin } from './browser.mjs';

let env; let app; let port; let tenants; let routes;
let admin; let manager; let appUser;

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];
const UUID = '00000000-0000-4000-8000-000000000000';

/**
 * Публичные маршруты — осознанный список. Добавили публичный маршрут — добавьте его сюда после проверки,
 * что он не отдаёт данные без входа.
 */
const PUBLIC = [
  'GET /api/health', 'GET /api/health/ready', 'GET /api/tenant',
  'GET /api/auth/providers', 'GET /api/auth/tenant-name', 'POST /api/auth/login', 'POST /api/auth/mfa',
  'POST /api/auth/refresh', 'POST /api/auth/logout',
  'GET /api/auth/handoff/start', 'GET /api/auth/handoff/issue', 'POST /api/auth/handoff/complete', 'POST /api/auth/handoff/finish',
  'GET /api/auth/google', 'GET /api/auth/google/callback',
  'POST /api/auth/password-reset/request', 'POST /api/auth/password-reset/confirm',
  'POST /api/invitations/inspect', 'POST /api/invitations/accept', 'POST /api/invitations/google',
  'OPTIONS /api/webhooks/forms/:publicKey', 'POST /api/webhooks/forms/:publicKey',
];

/** Все маршруты приложения с их защитой — из метаданных контроллеров. */
async function listRoutes() {
  const { AppModule } = await import('../../dist/app.module.js');
  const out = [];
  for (const c of Reflect.getMetadata('controllers', AppModule)) {
    const base = Reflect.getMetadata('path', c);
    for (const name of Object.getOwnPropertyNames(c.prototype)) {
      const h = c.prototype[name];
      if (name === 'constructor' || typeof h !== 'function' || Reflect.getMetadata('method', h) === undefined) continue;
      const meta = k => Reflect.getMetadata(k, h) ?? Reflect.getMetadata(k, c);
      const path = `/api/${base}/${Reflect.getMetadata('path', h)}`.replace(/\/+/g, '/').replace(/\/$/, '');
      out.push({
        method: METHODS[Reflect.getMetadata('method', h)], path, contexts: meta('modulyn:contexts') ?? ['tenant', 'app', 'platform'],
        public: meta('modulyn:public') === true, roles: meta('modulyn:roles') ?? null, module: meta('modulyn:module') ?? null,
        url: path.replace(/:[A-Za-z]+/g, p => (p === ':key' ? 'leads' : p === ':publicKey' ? 'x'.repeat(20) : UUID)),
      });
    }
  }
  return out;
}

const LABEL = { tenant: 'nova', app: 'app', platform: 'admin' };
const isMutating = m => !['GET', 'HEAD', 'OPTIONS'].includes(m);

/** Запрос «как из своего интерфейса» (правильный Origin и JSON), чтобы проверялся именно guard, а не CSRF. */
function call(b, r, label, { cookie, origin: o } = {}) {
  return b.send(r.method, label, r.url, {
    ...(isMutating(r.method) ? { origin: o ?? origin(label), json: {} } : {}),
    noCookies: true, headers: cookie ? { Cookie: cookie } : {},
  });
}

async function owner(query, tenantId) {
  const c = new pg.Client({ connectionString: env.ownerUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await c.query(query);
    await c.query('COMMIT');
  } finally { await c.end(); }
}

before(async () => {
  env = await prepareTestDatabase();
  ({ tenants } = env.seeded);
  Object.assign(process.env, {
    DATABASE_URL: env.appUrl, APP_BASE_DOMAIN: 'localhost', NODE_ENV: 'test', PUBLIC_PORT: '8080', PUBLIC_SCHEME: 'http', TRUST_PROXY: 'true', SMTP_URL: 'memory:',
  });
  const { createApplication } = await import('../../dist/bootstrap.js');
  app = await createApplication();
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  port = app.getHttpServer().address().port;
  routes = await listRoutes();
  const login = async (email, slug) => {
    const b = new Browser(port);
    assert.equal((await b.post('app', '/api/auth/login', { email, password: SEED_PASSWORD })).status, 200);
    if (slug) assert.equal((await b.enter(slug)).headers.location, '/');
    return b;
  };
  admin = await login('admin@nova.example', 'nova');
  manager = await login('manager@shared.example', 'nova');
  appUser = await login('admin@company-b.example', null);
});

after(async () => {
  await app?.close();
  await env?.ownerPrisma.$disconnect();
});

describe('9.2 every API route is protected', () => {
  test('the set of public routes is exactly the reviewed list', () => {
    assert.ok(routes.length >= 50, `routes discovered: ${routes.length}`);
    assert.deepEqual(routes.filter(r => r.public).map(r => `${r.method} ${r.path}`).sort(), [...PUBLIC].sort());
  });

  test('without a session: 401 on its own host, 404 on other hosts — never data', async () => {
    const b = new Browser(port);
    const failures = [];
    for (const r of routes.filter(x => !x.public)) {
      for (const kind of ['tenant', 'app', 'platform']) {
        const res = await call(b, r, LABEL[kind]);
        const expected = r.contexts.includes(kind) ? 401 : 404;
        if (res.status !== expected) failures.push(`${r.method} ${r.path} on ${kind}: ${res.status}, expected ${expected}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test('a Nova session is worthless on another company, on app and on admin', async () => {
    const cookie = admin.cookieHeader(host('nova'));
    assert.ok(cookie.length > 0);
    const failures = [];
    for (const r of routes.filter(x => !x.public)) {
      for (const label of ['company-b', 'app', 'admin']) {
        const res = await call(admin, r, label, { cookie });
        const kind = label === 'company-b' ? 'tenant' : label === 'app' ? 'app' : 'platform';
        const expected = r.contexts.includes(kind) ? 401 : 404;
        if (res.status !== expected) failures.push(`${r.method} ${r.path} on ${label}: ${res.status}, expected ${expected}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test('an app (company chooser) session does not open company or platform routes', async () => {
    const cookie = appUser.cookieHeader(host('app'));
    const failures = [];
    for (const r of routes.filter(x => !x.public && !x.contexts.includes('app'))) {
      for (const label of ['nova', 'admin']) {
        const kind = label === 'nova' ? 'tenant' : 'platform';
        const res = await call(appUser, r, label, { cookie });
        const expected = r.contexts.includes(kind) ? 401 : 404;
        if (res.status !== expected) failures.push(`${r.method} ${r.path} on ${label}: ${res.status}`);
      }
    }
    assert.deepEqual(failures, []);
  });

  test('a manager gets 403 on every admin-only company route', async () => {
    const cookie = manager.cookieHeader(host('nova'));
    const adminOnly = routes.filter(r => r.roles?.includes('TENANT_ADMIN') && !r.roles.includes('MANAGER'));
    assert.ok(adminOnly.length >= 10);
    const failures = [];
    for (const r of adminOnly) {
      const res = await call(manager, r, 'nova', { cookie });
      if (res.status !== 403) failures.push(`${r.method} ${r.path}: ${res.status}`);
    }
    assert.deepEqual(failures, []);
  });

  test('with the module disabled, every module route is 403 MODULE_DISABLED even for the admin', async () => {
    const cookie = admin.cookieHeader(host('nova'));
    const moduleRoutes = routes.filter(r => r.module === 'leads');
    assert.ok(moduleRoutes.length >= 12);
    await owner("UPDATE tenant_modules SET enabled = false WHERE module_id = (SELECT id FROM modules WHERE key = 'leads')", tenants.nova.id);
    const failures = [];
    try {
      for (const r of moduleRoutes) {
        const res = await call(admin, r, 'nova', { cookie });
        if (res.status !== 403 || res.json?.code !== 'MODULE_DISABLED') failures.push(`${r.method} ${r.path}: ${res.status} ${res.json?.code}`);
      }
    } finally {
      await owner("UPDATE tenant_modules SET enabled = true WHERE module_id = (SELECT id FROM modules WHERE key = 'leads')", tenants.nova.id);
    }
    assert.deepEqual(failures, []);
  });

  test('CSRF: every changing route refuses a foreign Origin or a non-JSON body, even with a valid session', async () => {
    const cookie = admin.cookieHeader(host('nova'));
    const mutating = routes.filter(r => isMutating(r.method) && r.contexts.includes('tenant') && !r.path.startsWith('/api/webhooks/') && !r.path.startsWith('/api/auth/handoff/'));
    const failures = [];
    for (const r of mutating) {
      const foreign = await call(admin, r, 'nova', { cookie, origin: 'http://evil.localhost:8080' });
      const sibling = await call(admin, r, 'nova', { cookie, origin: origin('company-b') });
      const form = await admin.send(r.method, 'nova', r.url, { origin: origin('nova'), form: { a: '1' }, noCookies: true, headers: { Cookie: cookie } });
      for (const [what, res] of [['foreign', foreign], ['sibling', sibling], ['form', form]]) {
        if (res.status !== 403) failures.push(`${r.method} ${r.path} ${what}: ${res.status}`);
      }
    }
    assert.ok(mutating.length >= 12, `changing company routes: ${mutating.length}`);
    assert.deepEqual(failures, []);
  });
});

describe('9.2 headers and cookies', () => {
  test('security headers on API responses and pages of every context', async () => {
    const b = new Browser(port);
    for (const label of ['nova', 'app', 'admin']) {
      const r = await b.get(label, '/api/auth/me');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['x-frame-options'], 'SAMEORIGIN');
      assert.match(r.headers['content-security-policy'] ?? '', /frame-ancestors 'self'/);
      assert.equal(r.headers['x-powered-by'], undefined);
    }
  });

  test('session cookies are HttpOnly, SameSite and host-only', async () => {
    const b = new Browser(port);
    const r = await b.post('app', '/api/auth/login', { email: 'manager@shared.example', password: SEED_PASSWORD });
    const cookies = r.headers['set-cookie'] ?? [];
    assert.ok(cookies.length >= 2);
    for (const c of cookies) {
      assert.match(c, /HttpOnly/i, c.split('=')[0]);
      assert.match(c, /SameSite=(Lax|Strict)/i, c.split('=')[0]);
      assert.doesNotMatch(c, /Domain=/i, c.split('=')[0]);
    }
  });

  test('API errors do not leak internals', async () => {
    const b = new Browser(port);
    const r = await b.get('nova', '/api/leads/not-a-uuid');
    assert.equal(r.status, 401);
    assert.doesNotMatch(r.body, /stack|prisma|at \w+ \(/i);
    const bad = await b.send('POST', 'app', '/api/auth/login', { origin: origin('app'), headers: { 'content-type': 'application/json' } });
    assert.ok(bad.status >= 400 && bad.status < 500);
    assert.doesNotMatch(bad.body, /stack|prisma|at \w+ \(/i);
  });
});
