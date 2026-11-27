// Phase 11 (11.2, E2, E3): выделенная установка с явными адресами — как у Nova
// (crm.<домен> — CRM, login.crm.<домен> — вход, admin.crm.<домен> — платформа), здесь на *.localhost.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareTestDatabase } from './setup.mjs';
import { SEED_INTAKE, SEED_PASSWORD } from '../../scripts/seed.mjs';
import { Browser, mailToken } from './browser.mjs';

const CRM = 'crm'; const LOGIN = 'login.crm'; const ADMIN = 'admin.crm';
const origin = label => `http://${label}.localhost:8080`;
let env; let app; let port; let outbox;

before(async () => {
  env = await prepareTestDatabase();
  Object.assign(process.env, {
    DATABASE_URL: env.appUrl, APP_BASE_DOMAIN: 'localhost', NODE_ENV: 'test', PUBLIC_PORT: '8080', PUBLIC_SCHEME: 'http', TRUST_PROXY: 'true', SMTP_URL: 'memory:',
    APP_HOST: 'login.crm.localhost', PLATFORM_HOST: 'admin.crm.localhost', TENANT_HOSTS: 'crm.localhost=nova',
  });
  const { createApplication } = await import('../../dist/bootstrap.js');
  const { MailService } = await import('../../dist/mail/mail.service.js');
  app = await createApplication();
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  port = app.getHttpServer().address().port;
  outbox = app.get(MailService).outbox;
});

after(async () => {
  await app?.close();
  await env?.ownerPrisma.$disconnect();
});

/** Вход и переход в CRM по явным адресам — шаги браузера, как в Browser.enter, но с другими хостами. */
async function signInto(email) {
  const b = new Browser(port);
  assert.equal((await b.post(LOGIN, '/api/auth/login', { email, password: SEED_PASSWORD })).status, 200);
  const start = await b.get(CRM, '/api/auth/handoff/start');
  assert.equal(start.status, 303);
  const issueUrl = new URL(start.headers.location);
  assert.equal(issueUrl.origin, origin(LOGIN), 'the company sends the browser to its own login host');
  const issue = await b.get(LOGIN, issueUrl.pathname + issueUrl.search);
  assert.match(issue.body, new RegExp(`action="${origin(CRM)}/api/auth/handoff/complete"`));
  const field = (body, name) => new RegExp(`name="${name}" value="([^"]+)"`).exec(body)?.[1];
  const relay = await b.send('POST', CRM, '/api/auth/handoff/complete', { origin: origin(LOGIN), form: { code: field(issue.body, 'code'), state: field(issue.body, 'state') }, noCookies: true });
  assert.equal(relay.status, 200);
  const finish = await b.send('POST', CRM, '/api/auth/handoff/finish', { origin: origin(CRM), form: { code: field(relay.body, 'code'), state: field(relay.body, 'state') } });
  assert.equal(finish.headers.location, '/');
  return b;
}

test('only the explicit hosts work; the label scheme is closed', async () => {
  const guest = new Browser(port);
  assert.deepEqual((await guest.get(CRM, '/api/tenant')).json, { slug: 'nova', displayName: 'Nova CRM' });
  for (const label of ['nova', 'company-b', 'app', 'admin', 'nova.crm', 'www.crm']) {
    assert.equal((await guest.get(label, '/api/tenant')).status, 404, label);
  }
  assert.equal((await guest.post('app', '/api/auth/login', { email: 'admin@nova.example', password: SEED_PASSWORD })).status, 404, 'old login host');
  assert.equal((await guest.get(ADMIN, '/api/platform/tenants')).status, 401, 'platform lives on admin.crm');
});

test('sign-in on login.crm, work on crm; a session of crm is not valid on the login host', async () => {
  const admin = await signInto('admin@nova.example');
  const me = await admin.get(CRM, '/api/auth/me');
  assert.deepEqual([me.json.tenant.slug, me.json.role], ['nova', 'TENANT_ADMIN']);
  assert.equal((await admin.get(CRM, '/api/leads')).status, 200);
  assert.equal((await admin.send('GET', LOGIN, '/api/leads', { headers: { Cookie: admin.cookieHeader(`${CRM}.localhost:8080`) }, noCookies: true })).status, 404);
  // CSRF: изменяющий запрос с адреса входа на CRM — отказ.
  assert.equal((await admin.post(CRM, '/api/leads', { name: 'x', phone: '123' }, { origin: origin(LOGIN) })).status, 403);
});

test('links point to the explicit hosts: invitations, intake URL, sign-in redirects', async () => {
  const admin = await signInto('admin@nova.example');
  assert.equal((await admin.post(CRM, '/api/members/invitations', { email: 'host.test@nova-team.example', name: 'Host Test', role: 'MANAGER' })).status, 201);
  const mail = outbox.find(m => m.to === 'host.test@nova-team.example');
  assert.match(mail.text, /http:\/\/login\.crm\.localhost:8080\/invite#/);
  assert.ok(mailToken(outbox, 'host.test@nova-team.example'));

  const endpoints = (await admin.get(CRM, '/api/form-endpoints')).json;
  const nova = endpoints.find(e => e.publicKey === SEED_INTAKE.publicKey);
  assert.equal(nova.intakeUrl, `http://crm.localhost:8080/api/webhooks/forms/${SEED_INTAKE.publicKey}`);
  const site = await new Browser(port).send('POST', CRM, `/api/webhooks/forms/${SEED_INTAKE.publicKey}`, {
    json: { submissionId: 'dedicated-host-0001', firstName: 'Host', lastName: 'Lead', email: 'host.lead@example.de', phone: '', program: 'Erwachsene' },
    headers: { 'X-CRM-Integration-Key': SEED_INTAKE.secret }, noCookies: true,
  });
  assert.equal(site.status, 202);
  assert.equal((await admin.get(CRM, '/api/leads?q=Host%20Lead')).json.total, 1);
});

test('every protected route answers 401 on its own explicit host and 404 elsewhere', async () => {
  const { AppModule } = await import('../../dist/app.module.js');
  const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'ALL', 'OPTIONS', 'HEAD'];
  const hosts = { tenant: CRM, app: LOGIN, platform: ADMIN };
  const failures = [];
  const b = new Browser(port);
  for (const c of Reflect.getMetadata('controllers', AppModule)) {
    const base = Reflect.getMetadata('path', c);
    for (const name of Object.getOwnPropertyNames(c.prototype)) {
      const h = c.prototype[name];
      if (name === 'constructor' || typeof h !== 'function' || Reflect.getMetadata('method', h) === undefined) continue;
      const meta = k => Reflect.getMetadata(k, h) ?? Reflect.getMetadata(k, c);
      if (meta('modulyn:public')) continue;
      const method = METHODS[Reflect.getMetadata('method', h)];
      const path = `/api/${base}/${Reflect.getMetadata('path', h)}`.replace(/\/+/g, '/').replace(/\/$/, '').replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
      const contexts = meta('modulyn:contexts') ?? ['tenant', 'app', 'platform'];
      for (const [kind, label] of Object.entries(hosts)) {
        const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
        const res = await b.send(method, label, path, { ...(mutating ? { origin: origin(label), json: {} } : {}), noCookies: true });
        const expected = contexts.includes(kind) ? 401 : 404;
        if (res.status !== expected) failures.push(`${method} ${path} on ${label}: ${res.status}, expected ${expected}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});
