import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
const origin = new URL(process.env.SMOKE_ORIGIN ?? 'http://nova.localhost:8080');
if (origin.protocol !== 'http:' || !(origin.hostname === 'localhost' || origin.hostname === '127.0.0.1' || origin.hostname.endsWith('.localhost'))) {
  throw new Error('Smoke checks target local HTTP environments only');
}
// Preserve Host while connecting directly to loopback: Windows DNS need not resolve *.localhost.
function request(path, host = origin.host, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: origin.port || 80, path, method, headers: { Host: host, ...headers }, timeout: 10000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('HTTP smoke request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const cookiesOf = res => (res.headers['set-cookie'] ?? []).map(c => c.split(';')[0]).filter(c => !c.endsWith('=')).join('; ');
const page = await request('/');
assert.equal(page.status, 200);
assert.match(page.body, /MODULYN/);
// Phase 9.2: страницы интерфейса нельзя встроить в чужой сайт (clickjacking).
assert.equal(page.headers['x-frame-options'], 'DENY', 'page frame protection');
assert.match(page.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
assert.equal(page.headers['x-content-type-options'], 'nosniff');
const live = await request('/api/health');
assert.equal(live.status, 200);
assert.deepEqual(JSON.parse(live.body), { status: 'ok', service: 'modulyn-api' });
assert.equal(live.headers['x-content-type-options'], 'nosniff');
const ready = await request('/api/health/ready');
assert.equal(ready.status, 200);
assert.deepEqual(JSON.parse(ready.body), { status: 'ready', database: 'up' });
const missing = await request('/api/does-not-exist');
assert.equal(missing.status, 404);
const port = ':' + (origin.port || 80);
for (const host of ['nova.localhost', 'company-b.localhost', 'admin.localhost']) {
  assert.equal((await request('/', host + port)).status, 200);
}
// Phase 2: компания определяется по hostname. Нужны синтетические данные: pnpm db:seed.
const nova = await request('/api/tenant', 'nova.localhost' + port);
if (nova.status === 404) throw new Error('nova.localhost is unknown to the API: run pnpm db:seed first');
assert.equal(nova.status, 200);
assert.deepEqual(JSON.parse(nova.body), { slug: 'nova', displayName: 'Nova CRM' });
assert.equal(JSON.parse((await request('/api/tenant', 'company-b.localhost' + port)).body).slug, 'company-b');
const unknown = await request('/api/tenant', 'unknown-company.localhost' + port);
const suspended = await request('/api/tenant', 'suspended-co.localhost' + port);
assert.equal(unknown.status, 404);
assert.deepEqual([suspended.status, suspended.body], [unknown.status, unknown.body]);
assert.equal((await request('/api/tenant', 'admin.localhost' + port)).status, 404);

// Phase 3: вход на app.localhost, переход в Nova через одноразовый код, сессия не действует в Company B.
// Пароль синтетических пользователей — SEED_PASSWORD из apps/api/scripts/seed.mjs (только локально).
const appHost = 'app.localhost' + port;
const appOrigin = 'http://' + appHost;
const login = await request('/api/auth/login', appHost, {
  method: 'POST', headers: { Origin: appOrigin, 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'manager@shared.example', password: 'modulyn-local-dev-password' }),
});
assert.equal(login.status, 200, 'login on app.localhost');
const appCookies = cookiesOf(login);
const start = await request('/api/auth/handoff/start', 'nova.localhost' + port);
assert.equal(start.status, 303);
const issueUrl = new URL(start.headers.location);
const issue = await request(issueUrl.pathname + issueUrl.search, appHost, { headers: { Cookie: appCookies } });
assert.equal(issue.status, 200, 'handoff code issued');
const field = name => new RegExp(`name="${name}" value="([^"]+)"`).exec(issue.body)[1];
// Шаг 3: межсайтовая форма с app.localhost (браузер не прикладывает cookies Lax) — пересылка на свой хост.
const relay = await request('/api/auth/handoff/complete', 'nova.localhost' + port, {
  method: 'POST', headers: { Origin: appOrigin, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ code: field('code'), state: field('state') }).toString(),
});
assert.equal(relay.status, 200, 'handoff relay page');
// Шаг 4: та же форма со своего origin вместе с cookie state.
const complete = await request('/api/auth/handoff/finish', 'nova.localhost' + port, {
  method: 'POST', headers: { Origin: 'http://nova.localhost' + port, 'content-type': 'application/x-www-form-urlencoded', Cookie: cookiesOf(start) },
  body: new URLSearchParams({ code: field('code'), state: field('state') }).toString(),
});
assert.equal(complete.headers.location, '/', 'handoff accepted');
const novaCookies = cookiesOf(complete);
const me = await request('/api/auth/me', 'nova.localhost' + port, { headers: { Cookie: novaCookies } });
assert.equal(me.status, 200);
assert.equal(JSON.parse(me.body).tenant.slug, 'nova');
assert.equal((await request('/api/auth/me', 'company-b.localhost' + port, { headers: { Cookie: novaCookies } })).status, 401, 'Nova session on Company B');
// Phase 6: модуль «Заявки» включён у Nova — сводка доступна.
const caps = await request('/api/tenant/capabilities', 'nova.localhost' + port, { headers: { Cookie: novaCookies } });
assert.deepEqual(JSON.parse(caps.body).modules, ['leads']);
const summary = await request('/api/leads/summary', 'nova.localhost' + port, { headers: { Cookie: novaCookies } });
assert.equal(summary.status, 200, 'leads module summary');
// Phase 7: список заявок компании.
const leadList = await request('/api/leads?pageSize=25', 'nova.localhost' + port, { headers: { Cookie: novaCookies } });
assert.equal(leadList.status, 200, 'leads list');
assert.equal(JSON.parse(leadList.body).total, JSON.parse(summary.body).total, 'list and summary agree');
// Phase 8: заявка ровно в формате сайта Nova (api/trial-crm.php) на локальную точку приёма из seed (SEED_INTAKE).
// Ключ submissionId фиксирован: первый запуск создаёт заявку «Smoke Website», повторная отправка — всегда дубль.
const intakePath = '/api/webhooks/forms/nova-local-trial-endpoint';
const novaLead = {
  method: 'POST', headers: { 'content-type': 'application/json', 'X-CRM-Integration-Key': 'mdl_local-nova-trial-secret-for-development' },
  body: JSON.stringify({ submissionId: 'smoke-phase8-nova-trial-0001', firstName: 'Smoke', lastName: 'Website', email: 'smoke@nova-visitor.example', phone: '', program: 'Erwachsene', message: 'Smoke check' }),
};
const firstIntake = await request(intakePath, 'nova.localhost' + port, novaLead);
assert.equal(firstIntake.status, 202, 'website lead accepted');
assert.deepEqual(JSON.parse((await request(intakePath, 'nova.localhost' + port, novaLead)).body), { ok: true, duplicate: true }, 'resend is a duplicate');
assert.equal((await request(intakePath, 'company-b.localhost' + port, novaLead)).status, 404, 'Nova endpoint unknown on Company B');
const found = await request('/api/leads?q=Smoke%20Website', 'nova.localhost' + port, { headers: { Cookie: novaCookies } });
assert.equal(JSON.parse(found.body).total, 1, 'website lead visible in Nova');
await request('/api/auth/logout', 'nova.localhost' + port, { method: 'POST', headers: { Origin: 'http://nova.localhost' + port, 'content-type': 'application/json', Cookie: novaCookies }, body: '{}' });
assert.equal((await request('/api/auth/me', 'nova.localhost' + port, { headers: { Cookie: novaCookies } })).status, 401, 'logout revokes');
console.log('PASS: page (+ frame protection headers), liveness, PostgreSQL readiness, security header, API 404, three local hostnames, tenant resolution (nova, company-b, unknown = suspended, admin), login → handoff → Nova session, session not valid on Company B, leads module (summary + list), website form intake (Nova request, duplicate, other company), logout');
