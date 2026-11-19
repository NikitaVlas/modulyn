// Интеграционные тесты Phase 3 (3.2–3.10): реальный PostgreSQL, роль modulyn_app, HTTP через Nest.
// Браузер моделируется «банками cookies» по хостам. Google — локальный поддельный OIDC-провайдер.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import pg from 'pg';
import { startFakeGoogle } from './fake-google.mjs';
import { prepareTestDatabase } from './setup.mjs';
import { SEED_PASSWORD } from '../../scripts/seed.mjs';

const PORT_LABEL = ':8080';
const host = label => label + '.localhost' + PORT_LABEL;
const origin = label => 'http://' + host(label);

let env; let app; let port; let users; let tenants; let provider;

// ───────────── Поддельный Google (OIDC) ─────────────


before(async () => {
  provider = await startFakeGoogle();
  env = await prepareTestDatabase();
  ({ users, tenants } = env.seeded);
  Object.assign(process.env, {
    DATABASE_URL: env.appUrl, APP_BASE_DOMAIN: 'localhost', NODE_ENV: 'test', PUBLIC_PORT: '8080', PUBLIC_SCHEME: 'http',
    TRUST_PROXY: 'true', GOOGLE_CLIENT_ID: 'fake-client', GOOGLE_CLIENT_SECRET: 'fake-secret', GOOGLE_ISSUER: provider.issuer,
  });
  const { createApplication } = await import('../../dist/bootstrap.js');
  app = await createApplication();
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  port = app.getHttpServer().address().port;
});

after(async () => {
  await app?.close();
  await env?.ownerPrisma.$disconnect();
  provider?.server.close();
});

// ───────────── «Браузер» ─────────────

const randomIp = () => `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;

/** Набор cookies одного браузера, раздельно по хостам (cookies без Domain). */
class Browser {
  constructor() { this.jars = new Map(); this.ip = randomIp(); }
  jar(h) { if (!this.jars.has(h)) this.jars.set(h, new Map()); return this.jars.get(h); }
  cookieHeader(h) { return [...this.jar(h)].map(([k, v]) => `${k}=${v}`).join('; '); }
  store(h, setCookies = []) {
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(';').map(s => s.trim());
      const [name, ...rest] = pair.split('=');
      const value = rest.join('=');
      const expired = attrs.some(a => /^max-age=0$/i.test(a)) || attrs.some(a => /^expires=/i.test(a) && new Date(a.slice(8)) < new Date());
      if (expired || value === '') this.jar(h).delete(name); else this.jar(h).set(name, value);
    }
  }
  get(label, path, opts = {}) { return this.send('GET', label, path, opts); }
  post(label, path, body = {}, opts = {}) {
    return this.send('POST', label, path, { origin: origin(label), json: body, ...opts });
  }
  send(method, label, path, { json, form, origin: o, headers = {}, raw = false, noCookies = false } = {}) {
    const h = host(label);
    let payload;
    const hdrs = { Host: h, 'X-Forwarded-For': this.ip, ...headers };
    if (json !== undefined) { payload = JSON.stringify(json); hdrs['content-type'] = 'application/json'; }
    if (form !== undefined) { payload = new URLSearchParams(form).toString(); hdrs['content-type'] = 'application/x-www-form-urlencoded'; }
    if (o) hdrs.Origin = o;
    const cookie = noCookies ? '' : this.cookieHeader(h);
    if (cookie) hdrs.Cookie = cookie;
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers: hdrs }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', c => { body += c; });
        res.on('end', () => {
          if (!raw) this.store(h, res.headers['set-cookie']);
          let parsed; try { parsed = JSON.parse(body); } catch { parsed = undefined; }
          resolve({ status: res.statusCode, headers: res.headers, body, json: parsed });
        });
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
  login(email, password = SEED_PASSWORD, label = 'app') {
    return this.post(label, '/api/auth/login', { email, password });
  }

  /** Полный переход app → компания (A6). Возвращает ответ последнего шага. */
  async enter(slug) {
    const start = await this.get(slug, '/api/auth/handoff/start');
    assert.equal(start.status, 303);
    const issueUrl = new URL(start.headers.location);
    assert.equal(issueUrl.host, host('app'));
    const issue = await this.get('app', issueUrl.pathname + issueUrl.search);
    if (issue.status !== 200) return issue;
    const code = /name="code" value="([^"]+)"/.exec(issue.body)?.[1];
    const state = /name="state" value="([^"]+)"/.exec(issue.body)?.[1];
    this.lastHandoff = { code, state };
    return this.submitHandoff(slug, code, state);
  }

  /**
   * Отправка формы перехода так, как это делает браузер:
   * шаг 3 — межсайтовый POST с app.<домен> (cookies SameSite=Lax не прикладываются),
   * шаг 4 — автоотправка той же формы со своего origin (cookie state прикладывается).
   */
  async submitHandoff(slug, code, state) {
    const relay = await this.send('POST', slug, '/api/auth/handoff/complete', { origin: origin('app'), form: { code, state }, noCookies: true });
    if (relay.status !== 200) return relay;
    assert.match(relay.body, /action="\/api\/auth\/handoff\/finish"/);
    const field = name => new RegExp(`name="${name}" value="([^"]+)"`).exec(relay.body)[1];
    return this.send('POST', slug, '/api/auth/handoff/finish', { origin: origin(slug), form: { code: field('code'), state: field('state') } });
  }
}

async function loggedIn(email, slug) {
  const b = new Browser();
  assert.equal((await b.login(email)).status, 200);
  if (slug) assert.equal((await b.enter(slug)).headers.location, '/');
  return b;
}

/** Прямой SQL владельцем схемы. Таблицы компаний под FORCE RLS, поэтому для них нужен tenantId (контекст компании). */
async function owner(query, params, tenantId) {
  const c = new pg.Client({ connectionString: env.ownerUrl });
  await c.connect();
  try {
    if (!tenantId) return await c.query(query, params);
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await c.query(query, params);
    await c.query('COMMIT');
    return result;
  } finally { await c.end(); }
}

const MANAGER = 'manager@shared.example';
const NOVA_ADMIN = 'admin@nova.example';

// ───────────── 3.2–3.3 вход по паролю ─────────────

describe('3.2–3.3 password login on app.<domain>', () => {
  test('wrong password, unknown email and a blocked account get the same answer', async () => {
    const b = new Browser();
    const wrong = await b.login(MANAGER, 'wrong-password-123');
    const unknown = await b.login('nobody@nowhere.example', 'wrong-password-123');
    await owner('UPDATE users SET is_active = false WHERE email = $1', ['admin@company-b.example']);
    try {
      const blocked = await b.login('admin@company-b.example');
      for (const r of [wrong, unknown, blocked]) {
        assert.equal(r.status, 401);
        assert.deepEqual(r.json, wrong.json);
        assert.equal(r.headers['set-cookie'], undefined);
      }
      assert.equal(wrong.json.message, 'E-Mail oder Passwort ist falsch');
    } finally { await owner('UPDATE users SET is_active = true WHERE email = $1', ['admin@company-b.example']); }
  });

  test('successful login sets HttpOnly host-only cookies; only the hash of the refresh token is stored', async () => {
    const b = new Browser();
    const r = await b.login('  Manager@Shared.example ');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ok: true }, 'tokens are never in the JSON body');
    const cookies = r.headers['set-cookie'];
    const access = cookies.find(c => c.startsWith('mdl_at='));
    const refresh = cookies.find(c => c.startsWith('mdl_rt='));
    for (const c of [access, refresh]) {
      assert.match(c, /HttpOnly/i);
      assert.match(c, /Path=\//);
      assert.doesNotMatch(c, /Domain=/i);
    }
    assert.match(access, /SameSite=Lax/i);
    assert.match(refresh, /SameSite=Strict/i);
    const token = b.jar(host('app')).get('mdl_rt');
    const { rows } = await owner('SELECT token_hash FROM user_sessions WHERE token_hash = $1 OR token_hash = $2', [token, createHash('sha256').update(token).digest('hex')]);
    assert.deepEqual(rows.map(r => r.token_hash), [createHash('sha256').update(token).digest('hex')]);
  });

  test('the company list contains only active memberships in active companies', async () => {
    const manager = await loggedIn(MANAGER);
    const me = await manager.get('app', '/api/auth/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.json.user, { name: 'Shared Manager', email: MANAGER });
    assert.deepEqual(me.json.companies.map(c => [c.slug, c.role]), [['company-b', 'MANAGER'], ['nova', 'MANAGER']]);
    const suspendedOnly = await loggedIn('admin@suspended.example');
    assert.deepEqual((await suspendedOnly.get('app', '/api/auth/me')).json.companies, []);
    assert.equal((await new Browser().get('app', '/api/auth/me')).status, 401);
  });

  test('login page helpers: providers and company name; unknown and suspended look the same', async () => {
    const b = new Browser();
    assert.deepEqual((await b.get('app', '/api/auth/providers')).json, { password: true, google: true });
    assert.deepEqual((await b.get('app', '/api/auth/tenant-name?slug=nova')).json, { slug: 'nova', displayName: 'Nova CRM' });
    const unknown = await b.get('app', '/api/auth/tenant-name?slug=unknown-co');
    const suspended = await b.get('app', '/api/auth/tenant-name?slug=suspended-co');
    assert.deepEqual([suspended.status, suspended.body], [unknown.status, unknown.body]);
    assert.equal((await b.get('nova', '/api/auth/providers')).status, 404, 'app-only route on a company host');
  });
});

// ───────────── 3.10 переход в компанию ─────────────

describe('3.10 handoff from app.<domain> to a company subdomain', () => {
  test('a manager of two companies enters each one and sees the right company and role', async () => {
    const b = await loggedIn(MANAGER, 'nova');
    const nova = await b.get('nova', '/api/auth/me');
    assert.equal(nova.status, 200);
    assert.deepEqual(nova.json, { user: { name: 'Shared Manager', email: MANAGER }, role: 'MANAGER', tenant: { slug: 'nova', displayName: 'Nova CRM' }, passwordChangeRequired: false, locale: 'de' });
    assert.equal((await b.enter('company-b')).headers.location, '/');
    assert.equal((await b.get('company-b', '/api/auth/me')).json.tenant.slug, 'company-b');
    const admin = await loggedIn(NOVA_ADMIN, 'nova');
    assert.equal((await admin.get('nova', '/api/auth/me')).json.role, 'TENANT_ADMIN');
  });

  test('the code is in a POST form, not in the URL, and the issue page is locked down', async () => {
    const b = await loggedIn(MANAGER);
    const start = await b.get('nova', '/api/auth/handoff/start');
    const issue = await b.get('app', new URL(start.headers.location).pathname + new URL(start.headers.location).search);
    assert.doesNotMatch(start.headers.location, /code=/);
    assert.match(issue.body, /method="post" action="http:\/\/nova\.localhost:8080\/api\/auth\/handoff\/complete"/);
    assert.match(issue.headers['content-security-policy'], /form-action http:\/\/nova\.localhost:8080/);
    assert.equal(issue.headers['cache-control'], 'no-store');
    // Найдено ручной проверкой в браузере: с no-referrer Chrome шлёт форму с Origin: null и переход отклоняется.
    assert.equal(issue.headers['referrer-policy'], 'strict-origin');
  });

  test('a code works once, only with its browser state, only for its company and only for 60 seconds', async () => {
    const b = await loggedIn(MANAGER);
    assert.equal((await b.enter('nova')).headers.location, '/');
    const { code, state } = b.lastHandoff;
    // Повторное использование (cookie state у браузера ещё раз выставим вручную).
    b.jar(host('nova')).set('mdl_hs', state);
    const replay = await b.submitHandoff('nova', code, state);
    assert.equal(replay.headers.location, '/?error=handoff');

    // Чужой state: злоумышленник подсовывает свой код в браузер жертвы (login CSRF).
    const attacker = await loggedIn(NOVA_ADMIN);
    const victim = new Browser();
    await victim.get('nova', '/api/auth/handoff/start'); // у жертвы свой state
    const aStart = await attacker.get('nova', '/api/auth/handoff/start');
    const aIssue = await attacker.get('app', new URL(aStart.headers.location).pathname + new URL(aStart.headers.location).search);
    const aCode = /name="code" value="([^"]+)"/.exec(aIssue.body)[1];
    const aState = /name="state" value="([^"]+)"/.exec(aIssue.body)[1];
    const forced = await victim.submitHandoff('nova', aCode, aState);
    assert.equal(forced.headers.location, '/?error=handoff');
    assert.equal((await victim.get('nova', '/api/auth/me')).status, 401);

    // Код, выданный для nova, на company-b.
    const c = await loggedIn(MANAGER);
    const cStart = await c.get('nova', '/api/auth/handoff/start');
    const cIssue = await c.get('app', new URL(cStart.headers.location).pathname + new URL(cStart.headers.location).search);
    const cCode = /name="code" value="([^"]+)"/.exec(cIssue.body)[1];
    const cState = /name="state" value="([^"]+)"/.exec(cIssue.body)[1];
    c.jar(host('company-b')).set('mdl_hs', cState);
    const elsewhere = await c.submitHandoff('company-b', cCode, cState);
    assert.equal(elsewhere.headers.location, '/?error=handoff');

    // Истёкший код.
    const d = await loggedIn(MANAGER);
    const dStart = await d.get('nova', '/api/auth/handoff/start');
    const dIssue = await d.get('app', new URL(dStart.headers.location).pathname + new URL(dStart.headers.location).search);
    const dCode = /name="code" value="([^"]+)"/.exec(dIssue.body)[1];
    const dState = /name="state" value="([^"]+)"/.exec(dIssue.body)[1];
    await owner("UPDATE login_handoffs SET expires_at = now() - interval '1 second' WHERE code_hash = $1", [createHash('sha256').update(dCode).digest('hex')]);
    const expired = await d.submitHandoff('nova', dCode, dState);
    assert.equal(expired.headers.location, '/?error=handoff');
  });

  test('without a central session the browser is sent to login; a non-member is not let in', async () => {
    const anonymous = new Browser();
    const start = await anonymous.get('nova', '/api/auth/handoff/start');
    const issue = await anonymous.get('app', new URL(start.headers.location).pathname + new URL(start.headers.location).search);
    assert.equal(issue.status, 303);
    assert.equal(issue.headers.location, origin('app') + '/login?tenant=nova');
    const novaAdmin = await loggedIn(NOVA_ADMIN);
    const denied = await novaAdmin.enter('company-b');
    assert.equal(denied.headers.location, origin('app') + '/?error=no-access');
    assert.equal((await novaAdmin.get('suspended-co', '/api/auth/handoff/start')).status, 404, 'suspended company subdomain does not exist');
    // Прямой запрос кода для отключённой компании тоже не проходит.
    const direct = await novaAdmin.get('app', '/api/auth/handoff/issue?tenant=suspended-co&state=' + 's'.repeat(43));
    assert.equal(direct.headers.location, origin('app') + '/?error=no-access');
  });

  test('handoff completion from a foreign origin or as JSON is refused', async () => {
    const b = await loggedIn(MANAGER);
    const form = { code: 'x'.repeat(43), state: 'y'.repeat(43) };
    const r = await b.send('POST', 'nova', '/api/auth/handoff/complete', { origin: 'http://evil.localhost:8080', form });
    assert.equal(r.status, 403);
    // Второй шаг принимает только свой origin: app.<домен> и чужие сайты — отказ.
    assert.equal((await b.send('POST', 'nova', '/api/auth/handoff/finish', { origin: origin('app'), form })).status, 403);
    assert.equal((await b.send('POST', 'nova', '/api/auth/handoff/finish', { origin: origin('nova'), json: form })).status, 403);
    // Первый шаг ничего не создаёт: сессии без второго шага нет.
    const relay = await b.send('POST', 'nova', '/api/auth/handoff/complete', { origin: origin('app'), form, noCookies: true });
    assert.equal(relay.status, 200);
    assert.equal(relay.headers['set-cookie'], undefined);
  });
});

// ───────────── 3.5 границы контекстов ─────────────

describe('3.5 a session works only where it was issued', () => {
  test('company, app and platform tokens are not interchangeable', async () => {
    const b = await loggedIn(MANAGER, 'nova');
    const novaCookies = b.cookieHeader(host('nova'));
    const appCookies = b.cookieHeader(host('app'));
    const as = (label, cookie) => new Browser().get(label, '/api/auth/me', { headers: { Cookie: cookie } });
    assert.equal((await as('company-b', novaCookies)).status, 401, 'Nova session on Company B');
    assert.equal((await as('app', novaCookies)).status, 401, 'company token on app');
    assert.equal((await as('nova', appCookies)).status, 401, 'app token on a company');
    assert.equal((await as('admin', appCookies)).status, 401, 'app token on platform');
    const platform = new Browser();
    assert.equal((await platform.login('platform@modulyn.example', SEED_PASSWORD, 'admin')).status, 200);
    const platformCookies = platform.cookieHeader(host('admin'));
    assert.equal((await as('nova', platformCookies)).status, 401, 'platform token on a company');
    assert.equal((await as('app', platformCookies)).status, 401, 'platform token on app');
  });

  test('platform admins and company users are separate accounts', async () => {
    const b = new Browser();
    assert.equal((await b.login(MANAGER, SEED_PASSWORD, 'admin')).status, 401);
    assert.equal((await b.login('platform@modulyn.example', SEED_PASSWORD, 'app')).status, 401);
    assert.equal((await b.login('platform@modulyn.example', SEED_PASSWORD, 'nova')).status, 404, 'no login on company hosts');
    assert.equal((await b.login('platform@modulyn.example', SEED_PASSWORD, 'admin')).status, 200);
    assert.deepEqual((await b.get('admin', '/api/auth/me')).json, { admin: { name: 'Platform Admin', email: 'platform@modulyn.example' }, passwordChangeRequired: false, mfaSetupRequired: true, locale: 'de' });
  });

  test('disabling a membership closes that company at once, other companies keep working', async () => {
    const b = await loggedIn(MANAGER, 'nova');
    assert.equal((await b.enter('company-b')).headers.location, '/');
    const changed = await owner('UPDATE memberships SET is_active = false WHERE tenant_id = $1 AND user_id = $2', [tenants.nova.id, users[MANAGER].id], tenants.nova.id);
    assert.equal(changed.rowCount, 1);
    try {
      assert.equal((await b.get('nova', '/api/auth/me')).status, 401);
      assert.equal((await b.get('company-b', '/api/auth/me')).status, 200);
      assert.deepEqual((await b.get('app', '/api/auth/me')).json.companies.map(c => c.slug), ['company-b']);
    } finally {
      await owner('UPDATE memberships SET is_active = true WHERE tenant_id = $1 AND user_id = $2', [tenants.nova.id, users[MANAGER].id], tenants.nova.id);
    }
  });

  test('blocking an account closes every session at once', async () => {
    const b = await loggedIn(NOVA_ADMIN, 'nova');
    await owner('UPDATE users SET is_active = false WHERE id = $1', [users[NOVA_ADMIN].id]);
    try {
      assert.equal((await b.get('nova', '/api/auth/me')).status, 401);
      assert.equal((await b.get('app', '/api/auth/me')).status, 401);
      assert.equal((await b.post('app', '/api/auth/refresh')).status, 401);
    } finally { await owner('UPDATE users SET is_active = true WHERE id = $1', [users[NOVA_ADMIN].id]); }
  });

  test('company sessions are isolated by RLS like other company data', async () => {
    await loggedIn(MANAGER, 'nova');
    await loggedIn(MANAGER, 'company-b');
    const c = new pg.Client({ connectionString: env.appUrl });
    await c.connect();
    try {
      assert.equal((await c.query('SELECT count(*)::int AS n FROM tenant_sessions')).rows[0].n, 0, 'no context — no rows');
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenants.nova.id]);
      const { rows } = await c.query('SELECT DISTINCT tenant_id FROM tenant_sessions');
      assert.deepEqual(rows.map(r => r.tenant_id), [tenants.nova.id]);
      await c.query('ROLLBACK');
    } finally { await c.end(); }
  });
});

// ───────────── 3.4 ротация, выход, отзыв ─────────────

describe('3.4 refresh rotation, logout and revocation', () => {
  test('refresh rotates the token; a parallel duplicate gets 409; reuse later revokes the chain', async () => {
    for (const label of ['app', 'nova']) {
      const b = await loggedIn(MANAGER, 'nova');
      const old = b.jar(host(label)).get('mdl_rt');
      const first = await b.post(label, '/api/auth/refresh');
      assert.equal(first.status, 200);
      const rotated = b.jar(host(label)).get('mdl_rt');
      assert.notEqual(rotated, old);
      const duplicate = await new Browser().post(label, '/api/auth/refresh', {}, { headers: { Cookie: `mdl_rt=${old}` } });
      assert.equal(duplicate.status, 409, `${label}: concurrent refresh within the grace window`);
      assert.equal((await b.get(label, '/api/auth/me')).status, 200, `${label}: still logged in`);

      const table = label === 'app' ? 'user_sessions' : 'tenant_sessions';
      const aged = await owner(`UPDATE ${table} SET rotated_at = now() - interval '1 minute' WHERE token_hash = $1`,
        [createHash('sha256').update(old).digest('hex')], label === 'app' ? undefined : tenants.nova.id);
      assert.equal(aged.rowCount, 1);
      const theft = await new Browser().post(label, '/api/auth/refresh', {}, { headers: { Cookie: `mdl_rt=${old}` } });
      assert.equal(theft.status, 401, `${label}: reuse after the window`);
      assert.equal((await b.get(label, '/api/auth/me')).status, 401, `${label}: the whole chain is revoked`);
      assert.equal((await b.post(label, '/api/auth/refresh')).status, 401);
    }
  });

  test('logout on a company host logs this browser out everywhere, another browser stays', async () => {
    const b = await loggedIn(MANAGER, 'nova');
    assert.equal((await b.enter('company-b')).headers.location, '/');
    const other = await loggedIn(MANAGER, 'nova');
    const r = await b.post('nova', '/api/auth/logout');
    assert.equal(r.status, 204);
    assert.equal(b.jar(host('nova')).size, 0, 'cookies cleared');
    assert.equal((await b.get('app', '/api/auth/me')).status, 401, 'central session revoked');
    assert.equal((await b.get('company-b', '/api/auth/me')).status, 401, 'sibling company session revoked');
    assert.equal((await other.get('nova', '/api/auth/me')).status, 200, 'other browser unaffected');
  });

  test('stolen cookies stop working after logout', async () => {
    const b = await loggedIn(MANAGER, 'nova');
    const stolen = b.cookieHeader(host('nova'));
    await b.post('nova', '/api/auth/logout');
    assert.equal((await new Browser().get('nova', '/api/auth/me', { headers: { Cookie: stolen } })).status, 401);
    assert.equal((await new Browser().post('nova', '/api/auth/refresh', {}, { headers: { Cookie: stolen } })).status, 401);
  });

  test('logout on app works with an expired access token; logout-all closes other browsers', async () => {
    const b = await loggedIn(NOVA_ADMIN, 'nova');
    b.jar(host('app')).delete('mdl_at');
    assert.equal((await b.post('app', '/api/auth/logout')).status, 204);
    assert.equal((await b.get('nova', '/api/auth/me')).status, 401, 'company session opened from it is revoked');

    const one = await loggedIn(NOVA_ADMIN, 'nova');
    const two = await loggedIn(NOVA_ADMIN, 'nova');
    assert.equal((await one.post('nova', '/api/auth/logout-all')).status, 204);
    assert.equal((await two.get('nova', '/api/auth/me')).status, 401);
    assert.equal((await two.get('app', '/api/auth/me')).status, 401);
  });

  test('changing the password keeps this browser and revokes the others', async () => {
    const email = 'admin@company-b.example';
    const a = await loggedIn(email, 'company-b');
    const other = await loggedIn(email, 'company-b');
    const weak = await a.post('company-b', '/api/auth/password', { currentPassword: SEED_PASSWORD, newPassword: 'short' });
    assert.equal(weak.status, 400);
    const wrong = await a.post('company-b', '/api/auth/password', { currentPassword: 'not-the-password', newPassword: 'a brand new passphrase' });
    assert.equal(wrong.status, 400);
    const ok = await a.post('company-b', '/api/auth/password', { currentPassword: SEED_PASSWORD, newPassword: 'a brand new passphrase' });
    assert.equal(ok.status, 204);
    try {
      assert.equal((await a.get('company-b', '/api/auth/me')).status, 200);
      assert.equal((await a.get('app', '/api/auth/me')).status, 200);
      assert.equal((await other.get('company-b', '/api/auth/me')).status, 401);
      assert.equal((await other.get('app', '/api/auth/me')).status, 401);
      assert.equal((await new Browser().login(email)).status, 401, 'old password');
      assert.equal((await new Browser().login(email, 'a brand new passphrase')).status, 200);
    } finally {
      assert.equal((await a.post('app', '/api/auth/password', { currentPassword: 'a brand new passphrase', newPassword: SEED_PASSWORD })).status, 204);
    }
  });
});

// ───────────── 3.6 CSRF и ограничение входа ─────────────

describe('3.6 Origin checks and login throttling', () => {
  test('unsafe requests without the own Origin or not JSON are refused', async () => {
    const b = await loggedIn(MANAGER, 'nova');
    const body = { email: MANAGER, password: SEED_PASSWORD };
    assert.equal((await b.send('POST', 'app', '/api/auth/login', { json: body })).status, 403, 'no Origin');
    assert.equal((await b.send('POST', 'app', '/api/auth/login', { json: body, origin: origin('nova') })).status, 403, 'sibling origin');
    assert.equal((await b.send('POST', 'app', '/api/auth/login', { form: body, origin: origin('app') })).status, 403, 'form body');
    assert.equal((await b.send('POST', 'nova', '/api/auth/logout', { json: {}, origin: 'http://evil.example' })).status, 403);
    assert.equal((await b.get('nova', '/api/auth/me')).status, 200, 'the refused logout did nothing');
  });

  test('ten failed attempts for one account block it for a while, even with the right password', async () => {
    const b = new Browser();
    const email = 'admin@suspended.example';
    for (let i = 0; i < 10; i++) {
      b.ip = randomIp();
      assert.equal((await b.login(email, 'wrong-password-' + i)).status, 401);
    }
    b.ip = randomIp();
    const blocked = await b.login(email);
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers['retry-after'], '900');
    assert.equal((await new Browser().login(MANAGER)).status, 200, 'other accounts are not affected');
    await owner('DELETE FROM auth_throttle');
  });

  test('more than twenty attempts from one IP are refused', async () => {
    const b = new Browser();
    for (let i = 0; i < 20; i++) assert.equal((await b.login(`n${i}@nobody.example`, 'wrong-password-x')).status, 401);
    assert.equal((await b.login(MANAGER)).status, 429);
    b.ip = randomIp();
    assert.equal((await b.login(MANAGER)).status, 200);
    const { rows } = await owner('SELECT key_hash FROM auth_throttle');
    assert.ok(rows.every(r => /^[0-9a-f]{64}$/.test(r.key_hash) && !r.key_hash.includes('@')), 'no raw IPs or emails stored');
    await owner('DELETE FROM auth_throttle');
  });
});

// ───────────── 3.9 Google ─────────────

describe('3.9 Google sign-in (fake OIDC provider)', () => {
  /** Шаги браузера: /api/auth/google → «провайдер» выдаёт код → callback. */
  async function googleLogin(b, claims, { tenant, tamperState = false } = {}) {
    const start = await b.get('app', '/api/auth/google' + (tenant ? `?tenant=${tenant}` : ''));
    assert.equal(start.status, 303);
    const auth = new URL(start.headers.location);
    assert.equal(auth.origin + auth.pathname, provider.issuer + '/auth');
    assert.equal(auth.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(auth.searchParams.get('redirect_uri'), origin('app') + '/api/auth/google/callback');
    const code = 'code-' + randomInt(1e9);
    provider.codes.set(code, { ...claims, nonce: auth.searchParams.get('nonce'), challenge: auth.searchParams.get('code_challenge') });
    const state = tamperState ? 'forged-state' : auth.searchParams.get('state');
    return b.get('app', `/api/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`);
  }

  test('a verified Google email links to the existing account and signs in; next time sub is enough', async () => {
    const b = new Browser();
    const r = await googleLogin(b, { sub: 'google-sub-manager', email: MANAGER, emailVerified: true }, { tenant: 'nova' });
    assert.equal(r.status, 303);
    assert.equal(r.headers.location, origin('nova') + '/api/auth/handoff/start', 'continues into the requested company');
    assert.equal((await b.get('app', '/api/auth/me')).json.user.email, MANAGER);
    const { rows } = await owner("SELECT user_id, email_at_link FROM user_identities WHERE provider_subject = 'google-sub-manager'");
    assert.deepEqual(rows, [{ user_id: users[MANAGER].id, email_at_link: MANAGER }]);

    const again = new Browser();
    const r2 = await googleLogin(again, { sub: 'google-sub-manager', email: 'changed@gmail.example', emailVerified: true });
    assert.equal(r2.headers.location, origin('app') + '/');
    assert.equal((await again.get('app', '/api/auth/me')).json.user.email, MANAGER, 'linked by sub, not by the new email');
  });

  test('no registration: unverified or unknown emails are refused', async () => {
    const unverified = await googleLogin(new Browser(), { sub: 'g-unverified', email: NOVA_ADMIN, emailVerified: false });
    assert.equal(unverified.headers.location, origin('app') + '/login?error=google');
    const unknown = await googleLogin(new Browser(), { sub: 'g-unknown', email: 'stranger@gmail.example', emailVerified: true }, { tenant: 'nova' });
    assert.equal(unknown.headers.location, origin('app') + '/login?error=google&tenant=nova');
    const { rows } = await owner("SELECT count(*)::int AS n FROM users WHERE email = 'stranger@gmail.example'");
    assert.equal(rows[0].n, 0);
  });

  test('a forged state or a missing browser cookie is refused', async () => {
    const forged = await googleLogin(new Browser(), { sub: 'g-x', email: NOVA_ADMIN, emailVerified: true }, { tamperState: true });
    assert.equal(forged.headers.location, origin('app') + '/login?error=google');
    const b = new Browser();
    const start = await b.get('app', '/api/auth/google');
    const auth = new URL(start.headers.location);
    const code = 'code-nocookie';
    provider.codes.set(code, { sub: 'g-y', email: NOVA_ADMIN, emailVerified: true, nonce: auth.searchParams.get('nonce'), challenge: auth.searchParams.get('code_challenge') });
    const noCookie = await new Browser().get('app', `/api/auth/google/callback?code=${code}&state=${auth.searchParams.get('state')}`);
    assert.equal(noCookie.headers.location, origin('app') + '/login?error=google');
  });

  test('a Google account already linked to someone cannot be linked to a second account', async () => {
    // google-sub-manager связан с менеджером; другой аккаунт с тем же email у Google невозможен,
    // но второй Google-аккаунт для того же пользователя тоже не привязывается.
    const r = await googleLogin(new Browser(), { sub: 'another-google-of-manager', email: MANAGER, emailVerified: true });
    assert.equal(r.headers.location, origin('app') + '/login?error=google');
  });
});
