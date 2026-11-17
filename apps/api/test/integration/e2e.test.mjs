// Phase 9 (9.1, F1): сквозной бизнес-сценарий через все фазы на одном приложении и одной базе.
// Платформа создаёт компанию → первый администратор принимает приглашение из письма → приглашает менеджера →
// модуль «Заявки» отключают и включают → администратор создаёт точку приёма → сайт присылает заявку →
// менеджер берёт её в работу → администратор назначает → менеджер закрывает → удаление по запросу → отключение компании.
// Всё — синтетические данные в отдельной тестовой базе; почта — в памяти (SMTP_URL=memory:).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { prepareTestDatabase } from './setup.mjs';
import { SEED_INTAKE, SEED_PASSWORD } from '../../scripts/seed.mjs';
import { Browser, mailToken, origin } from './browser.mjs';

const apiRoot = fileURLToPath(new URL('../../', import.meta.url));
let env; let app; let port; let outbox; let totp;

before(async () => {
  env = await prepareTestDatabase();
  Object.assign(process.env, {
    DATABASE_URL: env.appUrl, APP_BASE_DOMAIN: 'localhost', NODE_ENV: 'test', PUBLIC_PORT: '8080', PUBLIC_SCHEME: 'http', TRUST_PROXY: 'true', SMTP_URL: 'memory:',
  });
  totp = await import('../../dist/auth/totp.js');
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

/** Сайт компании: запрос с сервера сайта, без cookies. */
function website(slug, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({
      hostname: '127.0.0.1', port, method: 'POST', path,
      headers: { Host: `${slug}.localhost:8080`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
    }, res => { let t = ''; res.setEncoding('utf8'); res.on('data', c => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(t || 'null') })); });
    req.on('error', reject);
    req.end(payload);
  });
}

async function platformOwner() {
  const r = spawnSync(process.execPath, ['scripts/platform-admin.mjs', 'create', '--email', 'owner@e2e.example', '--name', 'E2E Owner'], {
    cwd: apiRoot, encoding: 'utf8', env: { ...process.env, MIGRATION_DATABASE_URL: env.ownerUrl },
  });
  assert.equal(r.status, 0, r.stderr);
  const temporary = /Temporary password[^:]*: (\S+)/.exec(r.stdout)[1];
  const b = new Browser(port);
  assert.equal((await b.post('admin', '/api/auth/login', { email: 'owner@e2e.example', password: temporary })).status, 200);
  assert.equal((await b.post('admin', '/api/auth/password', { currentPassword: temporary, newPassword: 'e2e platform passphrase' })).status, 204);
  const setup = await b.post('admin', '/api/auth/mfa/setup');
  const code = totp.totpCode(totp.base32Decode(setup.json.secret), totp.currentStep());
  assert.equal((await b.post('admin', '/api/auth/mfa/enable', { code })).status, 200);
  return b;
}

async function acceptInvitation(email, name, password, slug) {
  const token = mailToken(outbox, email);
  assert.ok(token, `invitation mail to ${email}`);
  const b = new Browser(port);
  const accepted = await b.post('app', '/api/invitations/accept', { token, name, password });
  assert.deepEqual([accepted.status, accepted.json.tenantSlug], [200, slug]);
  assert.equal((await b.enter(slug)).headers.location, '/');
  return b;
}

test('9.1 the whole MVP path, from a new company to a processed website lead', async () => {
  // 1. Платформа (Phase 4): администратор с обязательным вторым фактором создаёт компанию.
  const platform = await platformOwner();
  const created = await platform.post('admin', '/api/platform/tenants', {
    slug: 'studio', name: 'Studio E2E GmbH', displayName: 'Studio CRM', adminEmail: 'boss@studio.example', adminName: 'Studio Boss',
  });
  assert.equal(created.status, 201);
  const tenantId = created.json.tenant.id;
  assert.equal(created.json.invitationSent, true);

  // 2. Первый администратор (Phase 5): приглашение из письма → аккаунт → вход в компанию.
  const boss = await acceptInvitation('boss@studio.example', 'Studio Boss', 'studio boss passphrase', 'studio');
  assert.deepEqual((await boss.get('studio', '/api/tenant/capabilities')).json, { modules: ['leads'], role: 'TENANT_ADMIN' }, 'new companies get Leads');

  // 3. Сотрудник: администратор приглашает менеджера; менеджер принимает.
  assert.equal((await boss.post('studio', '/api/members/invitations', { email: 'trainer@studio.example', name: 'Studio Trainer', role: 'MANAGER' })).json.invitationSent, true);
  const trainer = await acceptInvitation('trainer@studio.example', 'Studio Trainer', 'studio trainer passphrase', 'studio');
  assert.equal((await boss.get('studio', '/api/members')).json.members.length, 2);

  // 4. Модули (Phase 6): платформа отключает «Заявки» — раздел закрыт для всех, приём с сайтов тоже; затем включает.
  assert.equal((await platform.patch('admin', `/api/platform/tenants/${tenantId}/modules/leads`, { enabled: false })).status, 200);
  assert.equal((await trainer.get('studio', '/api/leads')).json.code, 'MODULE_DISABLED');
  assert.deepEqual((await trainer.get('studio', '/api/tenant/capabilities')).json.modules, []);
  assert.equal((await platform.patch('admin', `/api/platform/tenants/${tenantId}/modules/leads`, { enabled: true })).status, 200);

  // 5. Приём заявок (Phase 8): администратор создаёт точку для сайта; секрет показан один раз.
  const endpoint = await boss.post('studio', '/api/form-endpoints', {
    name: 'Website', mode: 'SERVER', sourceDetail: 'trial', fieldMapping: { extra: [{ field: 'program', label: 'Программа' }] },
  });
  assert.equal(endpoint.status, 201);
  const { publicKey, intakeUrl } = endpoint.json.endpoint;
  const secret = endpoint.json.secret;
  assert.equal(intakeUrl, `http://studio.localhost:8080/api/webhooks/forms/${publicKey}`);

  // 6. Сайт присылает заявку (формат сайта Nova); повтор — дубль.
  const submission = { submissionId: 'e2e-studio-trial-0001', firstName: 'Mia', lastName: 'Website', email: 'mia@visitor.example', phone: '+49 30 1234567', program: 'Kinder 7–10', message: 'Ab nächster Woche' };
  assert.deepEqual((await website('studio', `/api/webhooks/forms/${publicKey}`, submission, { 'X-CRM-Integration-Key': secret })).json, { ok: true });
  assert.deepEqual((await website('studio', `/api/webhooks/forms/${publicKey}`, submission, { 'X-CRM-Integration-Key': secret })).json, { ok: true, duplicate: true });

  // 7. Заявки (Phase 7): менеджер видит новую заявку, берёт в работу.
  const fresh = await trainer.get('studio', '/api/leads?status=NEW');
  assert.equal(fresh.json.total, 1);
  const [item] = fresh.json.items;
  assert.deepEqual([item.name, item.source, item.sourceDetail, item.assignee], ['Mia Website', 'WEB_FORM', 'trial', null]);
  const card = await trainer.get('studio', `/api/leads/${item.id}`);
  assert.equal(card.json.message, 'Программа: Kinder 7–10\nAb nächster Woche');
  assert.equal((await trainer.post('studio', `/api/leads/${item.id}/status`, { from: 'NEW', to: 'IN_PROGRESS' })).status, 204);

  // Назначает только администратор; после назначения заявка — в «Мои» у менеджера.
  const trainerId = (await boss.get('studio', '/api/leads/assignees')).json.find(a => a.name === 'Studio Trainer').userId;
  assert.equal((await trainer.send('PUT', 'studio', `/api/leads/${item.id}/assignee`, { origin: origin('studio'), json: { userId: trainerId } })).status, 403);
  assert.equal((await boss.send('PUT', 'studio', `/api/leads/${item.id}/assignee`, { origin: origin('studio'), json: { userId: trainerId } })).status, 204);
  assert.equal((await trainer.get('studio', '/api/leads?assignee=me')).json.total, 1);
  assert.equal((await trainer.post('studio', `/api/leads/${item.id}/status`, { from: 'IN_PROGRESS', to: 'CONTACTED' })).status, 204);
  assert.equal((await trainer.post('studio', `/api/leads/${item.id}/status`, { from: 'CONTACTED', to: 'CLOSED' })).status, 204);
  const history = (await boss.get('studio', `/api/leads/${item.id}`)).json.history;
  assert.deepEqual(history.map(h => [h.previousStatus, h.newStatus, h.changedBy?.name ?? null]),
    [[null, 'NEW', null], ['NEW', 'IN_PROGRESS', 'Studio Trainer'], ['IN_PROGRESS', 'CONTACTED', 'Studio Trainer'], ['CONTACTED', 'CLOSED', 'Studio Trainer']]);
  const summary = (await boss.get('studio', '/api/leads/summary')).json;
  assert.deepEqual([summary.total, summary.byStatus.CLOSED, summary.byStatus.NEW], [1, 1, 0]);

  // Журнал приёма: «Принята» со ссылкой, «Дубль»; без содержимого формы.
  const journal = (await boss.get('studio', '/api/form-endpoints/submissions')).json;
  assert.deepEqual(journal.map(j => [j.status, j.leadId]), [['DUPLICATE', null], ['IMPORTED', item.id]]);
  assert.doesNotMatch(JSON.stringify(journal), /Mia|mia@|\+49/);

  // 8. Изоляция: другая компания и платформа не видят заявку; ключ точки не работает на чужом поддомене.
  const nova = new Browser(port);
  assert.equal((await nova.post('app', '/api/auth/login', { email: 'admin@nova.example', password: SEED_PASSWORD })).status, 200);
  assert.equal((await nova.enter('nova')).headers.location, '/');
  assert.equal((await nova.get('nova', `/api/leads/${item.id}`)).status, 404);
  assert.equal((await nova.get('nova', '/api/leads?q=Mia')).json.total, 0);
  assert.equal((await website('nova', `/api/webhooks/forms/${publicKey}`, submission, { 'X-CRM-Integration-Key': secret })).status, 404);
  assert.equal((await website('studio', `/api/webhooks/forms/${SEED_INTAKE.publicKey}`, submission, { 'X-CRM-Integration-Key': SEED_INTAKE.secret })).status, 404);
  const platformView = await platform.get('admin', `/api/platform/tenants/${tenantId}`);
  assert.equal(platformView.json.activeMembers, 2);
  assert.doesNotMatch(platformView.body, /Mia|mia@|trainer@|boss@studio/, 'the platform sees numbers, not people');

  // 9. Удаление по запросу человека (Phase 9, F6).
  assert.equal((await boss.send('DELETE', 'studio', `/api/leads/${item.id}`, { origin: origin('studio'), json: {} })).status, 204);
  assert.equal((await trainer.get('studio', '/api/leads')).json.total, 0);

  // 10. Платформа отключает компанию: сессии и приём закрыты сразу; данные сохраняются.
  assert.equal((await platform.patch('admin', `/api/platform/tenants/${tenantId}`, { status: 'SUSPENDED' })).json.status, 'SUSPENDED');
  assert.equal((await trainer.get('studio', '/api/leads')).status, 404);
  assert.equal((await website('studio', `/api/webhooks/forms/${publicKey}`, { ...submission, submissionId: 'e2e-after-suspend' }, { 'X-CRM-Integration-Key': secret })).status, 404);
  assert.equal((await platform.patch('admin', `/api/platform/tenants/${tenantId}`, { status: 'ACTIVE' })).json.status, 'ACTIVE');
  assert.equal((await trainer.get('studio', '/api/leads')).status, 401, 'sessions were revoked: sign in again');
  const again = new Browser(port);
  assert.equal((await again.post('app', '/api/auth/login', { email: 'trainer@studio.example', password: 'studio trainer passphrase' })).status, 200);
  assert.equal((await again.enter('studio')).headers.location, '/');
  assert.equal((await again.get('studio', '/api/members')).status, 403, 'still a manager');
  assert.equal((await again.get('studio', '/api/form-endpoints')).status, 403);
});
