// Интеграционные тесты Phase 8 (8.9–8.13): точки приёма, приём заявок с сайтов, журнал, изоляция.
// Отдельно — ровно тот запрос, который отправляет сайт Nova (Nova-MG/api/trial-crm.php).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import pg from 'pg';
import { prepareTestDatabase } from './setup.mjs';
import { SEED_INTAKE, SEED_PASSWORD } from '../../scripts/seed.mjs';
import { Browser } from './browser.mjs';

let env; let app; let port; let tenants;
let admin; let manager; let bAdmin;

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
  admin = await member('admin@nova.example', 'nova');
  manager = await member('manager@shared.example', 'nova');
  bAdmin = await member('admin@company-b.example', 'company-b');
});

after(async () => {
  await app?.close();
  await env?.ownerPrisma.$disconnect();
});

async function member(email, slug) {
  const b = new Browser(port);
  assert.equal((await b.post('app', '/api/auth/login', { email, password: SEED_PASSWORD })).status, 200);
  assert.equal((await b.enter(slug)).headers.location, '/');
  return b;
}

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

/** Запрос «с чужого сайта»: без cookies и без своего Origin. */
function send(slug, path, { method = 'POST', body, raw, headers = {} } = {}) {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1', port, method, path,
      headers: { Host: `${slug}.localhost:8080`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', c => { text += c; });
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch { json = undefined; } resolve({ status: res.statusCode, headers: res.headers, json, body: text }); });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const intake = (key = SEED_INTAKE.publicKey) => `/api/webhooks/forms/${key}`;
/** Ровно как nova_sync_trial_lead(): поля, submissionId из 16 случайных байт, X-CRM-Integration-Key. */
function novaPayload(overrides = {}) {
  return {
    submissionId: randomBytes(16).toString('hex'), firstName: 'Anna', lastName: 'Probe', email: 'anna.probe@example.de',
    phone: '+49 171 0000000', program: 'Kinder 4–6', message: 'Kommt mit Tochter', ...overrides,
  };
}
const novaHeaders = (secret = SEED_INTAKE.secret) => ({ 'X-CRM-Integration-Key': secret });
const leadsNamed = async name => (await owner('SELECT id, name, email, phone, message, source, source_detail, status FROM leads WHERE name = $1', [name], tenants.nova.id)).rows;

describe('8.10 / 8.12 the Nova website request, unchanged', () => {
  test('creates a NEW web lead with the program in the message, history and a journal entry', async () => {
    const payload = novaPayload({ firstName: 'Lena', lastName: 'Website' });
    const r = await send('nova', intake(), { body: payload, headers: novaHeaders() });
    assert.equal(r.status, 202);
    assert.deepEqual(r.json, { ok: true }, 'any 2xx is success for the site; no lead data is returned');
    const [lead] = await leadsNamed('Lena Website');
    assert.deepEqual(
      [lead.email, lead.phone, lead.source, lead.source_detail, lead.status, lead.message],
      ['anna.probe@example.de', '+49 171 0000000', 'WEB_FORM', 'trial', 'NEW', 'Programm: Kinder 4–6\nKommt mit Tochter'],
    );
    const card = await manager.get('nova', `/api/leads/${lead.id}`);
    assert.deepEqual(card.json.history.map(h => [h.previousStatus, h.newStatus, h.changedBy]), [[null, 'NEW', null]]);
    const journal = await admin.get('nova', '/api/form-endpoints/submissions');
    assert.deepEqual([journal.json[0].status, journal.json[0].leadId, journal.json[0].errorCode], ['IMPORTED', lead.id, null]);
  });

  test('the same submissionId again is a duplicate, not a second lead', async () => {
    const payload = novaPayload({ firstName: 'Dora', lastName: 'Duplicate' });
    assert.deepEqual((await send('nova', intake(), { body: payload, headers: novaHeaders() })).json, { ok: true });
    const again = await send('nova', intake(), { body: payload, headers: novaHeaders() });
    assert.deepEqual([again.status, again.json], [202, { ok: true, duplicate: true }]);
    assert.equal((await leadsNamed('Dora Duplicate')).length, 1);
    assert.equal((await admin.get('nova', '/api/form-endpoints/submissions')).json[0].status, 'DUPLICATE');
  });

  test('two identical requests at the same moment create exactly one lead', async () => {
    const payload = novaPayload({ firstName: 'Paula', lastName: 'Parallel' });
    const results = await Promise.all([1, 2, 3].map(() => send('nova', intake(), { body: payload, headers: novaHeaders() })));
    assert.ok(results.every(r => r.status === 202));
    assert.equal(results.filter(r => r.json.duplicate).length, 2);
    assert.equal((await leadsNamed('Paula Parallel')).length, 1);
  });

  test('without a site key, identical content on the same day is a duplicate', async () => {
    const body = { name: 'Hash Twin', email: 'twin@example.de', message: 'Hallo' };
    await send('nova', intake(), { body, headers: novaHeaders() });
    assert.equal((await send('nova', intake(), { body, headers: novaHeaders() })).json.duplicate, true);
    assert.equal((await leadsNamed('Hash Twin')).length, 1);
  });
});

describe('8.10 / 8.13 rejections and isolation', () => {
  test('secret: Bearer works too; wrong or missing secret is 401 and logged without data', async () => {
    assert.equal((await send('nova', intake(), { body: novaPayload({ lastName: 'Bearer' }), headers: { Authorization: `Bearer ${SEED_INTAKE.secret}` } })).status, 202);
    assert.equal((await send('nova', intake(), { body: novaPayload(), headers: novaHeaders('mdl_wrong') })).status, 401);
    assert.equal((await send('nova', intake(), { body: novaPayload() })).status, 401);
    const journal = (await admin.get('nova', '/api/form-endpoints/submissions')).json;
    assert.equal(journal[0].errorCode, 'unauthorized');
    assert.doesNotMatch(JSON.stringify(journal), /@|Anna|Probe|\+49/, 'no form content in the journal');
  });

  test('invalid data is 400 with the field; nothing is created', async () => {
    const bad = await send('nova', intake(), { body: novaPayload({ firstName: '', lastName: '', email: 'not-mail' }), headers: novaHeaders() });
    assert.deepEqual([bad.status, bad.json.error, bad.json.field, bad.json.reason], [400, 'VALIDATION', 'name', 'required']);
    const noContact = await send('nova', intake(), { body: { name: 'X', submissionId: 'abcdefgh' }, headers: novaHeaders() });
    assert.deepEqual([noContact.status, noContact.json.reason], [400, 'contact_required']);
    assert.equal((await send('nova', intake(), { raw: 'name=x', headers: { ...novaHeaders(), 'content-type': 'text/plain' } })).status, 400);
    assert.equal((await send('nova', intake(), { raw: JSON.stringify({ name: 'x'.repeat(40000), phone: '1' }), headers: novaHeaders() })).status, 413);
  });

  test('unknown key, another company, disabled endpoint, module or company — the same 404', async () => {
    const unknown = await send('nova', intake('nonexistent-endpoint-key'), { body: novaPayload(), headers: novaHeaders() });
    assert.deepEqual([unknown.status, unknown.json], [404, { ok: false, error: 'NOT_FOUND' }]);
    const elsewhere = await send('company-b', intake(), { body: novaPayload(), headers: novaHeaders() });
    assert.deepEqual([elsewhere.status, elsewhere.body], [unknown.status, unknown.body], 'the Nova key does not exist on company-b');
    assert.equal((await send('suspended-co', intake(), { body: novaPayload(), headers: novaHeaders() })).status, 404);

    await owner("UPDATE tenant_modules SET enabled = false WHERE module_id = (SELECT id FROM modules WHERE key = 'leads')", [], tenants.nova.id);
    try {
      const off = await send('nova', intake(), { body: novaPayload(), headers: novaHeaders() });
      assert.deepEqual([off.status, off.body], [unknown.status, unknown.body], 'module disabled (W9)');
    } finally {
      await owner("UPDATE tenant_modules SET enabled = true WHERE module_id = (SELECT id FROM modules WHERE key = 'leads')", [], tenants.nova.id);
    }
    const endpoints = (await admin.get('nova', '/api/form-endpoints')).json;
    const nova = endpoints.find(e => e.publicKey === SEED_INTAKE.publicKey);
    await admin.patch('nova', `/api/form-endpoints/${nova.id}`, { isActive: false });
    assert.equal((await send('nova', intake(), { body: novaPayload(), headers: novaHeaders() })).status, 404, 'endpoint disabled');
    await admin.patch('nova', `/api/form-endpoints/${nova.id}`, { isActive: true });
    assert.equal((await send('nova', intake(), { body: novaPayload({ lastName: 'Back' }), headers: novaHeaders() })).status, 202);
  });

  test('more than 60 requests a minute to one endpoint are refused', async () => {
    const created = await admin.post('nova', '/api/form-endpoints', { name: 'Burst', mode: 'SERVER' });
    const key = created.json.endpoint.publicKey; const secret = created.json.secret;
    const results = [];
    for (let i = 0; i < 61; i++) results.push((await send('nova', intake(key), { body: { name: 'x', submissionId: 'burst' + i + 'aaaa' }, headers: novaHeaders(secret) })).status);
    assert.equal(results.filter(s => s === 400).length, 60, 'first 60 are processed (invalid: no contact)');
    assert.equal(results[60], 429);
  });
});

describe('8.9 endpoint settings (company admin)', () => {
  test('create SERVER: the secret is shown once and stored as a hash; rotation kills the old secret', async () => {
    const r = await admin.post('nova', '/api/form-endpoints', {
      name: 'Landingpage', mode: 'SERVER', sourceDetail: 'landing', fieldMapping: { fields: { name: 'fullName' } },
    });
    assert.equal(r.status, 201);
    const { endpoint, secret } = r.json;
    assert.match(secret, /^mdl_[A-Za-z0-9_-]{43}$/);
    assert.equal(endpoint.intakeUrl, `http://nova.localhost:8080/api/webhooks/forms/${endpoint.publicKey}`);
    assert.equal(endpoint.secretPrefix, secret.slice(0, 10));
    const list = await admin.get('nova', '/api/form-endpoints');
    assert.doesNotMatch(list.body, new RegExp(secret.slice(10)), 'the secret is never shown again');
    const { rows } = await owner('SELECT secret_hash FROM form_endpoints WHERE id = $1', [endpoint.id], tenants.nova.id);
    assert.equal(rows[0].secret_hash, createHash('sha256').update(secret).digest('hex'));

    assert.equal((await send('nova', intake(endpoint.publicKey), { body: { fullName: 'Renamed Field', phone: '12345' }, headers: { Authorization: `Bearer ${secret}` } })).status, 202);
    assert.equal((await leadsNamed('Renamed Field'))[0].source_detail, 'landing');

    const rotated = await admin.post('nova', `/api/form-endpoints/${endpoint.id}/rotate-secret`);
    assert.notEqual(rotated.json.secret, secret);
    assert.equal((await send('nova', intake(endpoint.publicKey), { body: { fullName: 'Old', phone: '1234' }, headers: { Authorization: `Bearer ${secret}` } })).status, 401);
    assert.equal((await send('nova', intake(endpoint.publicKey), { body: { fullName: 'New', phone: '1234' }, headers: { Authorization: `Bearer ${rotated.json.secret}` } })).status, 202);
  });

  test('validation of settings; mode and key cannot change', async () => {
    for (const body of [{ name: '', mode: 'SERVER' }, { name: 'x', mode: 'FTP' }, { name: 'x', mode: 'BROWSER' },
      { name: 'x', mode: 'BROWSER', allowedOrigins: ['ftp://site.de'] }, { name: 'x', mode: 'BROWSER', allowedOrigins: ['https://site.de/form'] },
      { name: 'x', mode: 'SERVER', sourceDetail: 'with space' }, { name: 'x', mode: 'SERVER', fieldMapping: { fields: { password: 'p' } } }]) {
      assert.equal((await admin.post('nova', '/api/form-endpoints', body)).status, 400, JSON.stringify(body));
    }
    const nova = (await admin.get('nova', '/api/form-endpoints')).json.find(e => e.publicKey === SEED_INTAKE.publicKey);
    assert.equal((await admin.patch('nova', `/api/form-endpoints/${nova.id}`, { mode: 'BROWSER' })).status, 400);
    assert.equal((await admin.patch('nova', `/api/form-endpoints/${nova.id}`, { publicKey: 'x'.repeat(20) })).status, 400);
  });

  test('only the company admin manages endpoints; other companies see nothing', async () => {
    assert.equal((await manager.get('nova', '/api/form-endpoints')).status, 403);
    assert.equal((await manager.post('nova', '/api/form-endpoints', { name: 'x', mode: 'SERVER' })).status, 403);
    assert.equal((await manager.get('nova', '/api/form-endpoints/submissions')).status, 403);
    const b = await bAdmin.get('company-b', '/api/form-endpoints');
    assert.deepEqual(b.json, []);
    const nova = (await admin.get('nova', '/api/form-endpoints')).json[0];
    assert.equal((await bAdmin.patch('company-b', `/api/form-endpoints/${nova.id}`, { isActive: false })).status, 404);
    assert.equal((await bAdmin.post('company-b', `/api/form-endpoints/${nova.id}/rotate-secret`)).status, 404);
    const raw = new pg.Client({ connectionString: env.appUrl });
    await raw.connect();
    try { assert.equal((await raw.query('SELECT count(*)::int AS n FROM form_endpoints')).rows[0].n, 0, 'RLS: nothing without company context'); }
    finally { await raw.end(); }
  });
});

describe('8.10 BROWSER mode', () => {
  let key;
  before(async () => {
    const r = await admin.post('nova', '/api/form-endpoints', { name: 'Static site', mode: 'BROWSER', allowedOrigins: ['https://static.example.com'] });
    assert.equal(r.json.secret, null, 'no secret for the browser mode');
    key = r.json.endpoint.publicKey;
  });

  test('CORS only for the allowed site; other origins and no origin are refused', async () => {
    const pre = await send('nova', intake(key), { method: 'OPTIONS', headers: { Origin: 'https://static.example.com', 'Access-Control-Request-Method': 'POST' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'https://static.example.com');
    assert.equal((await send('nova', intake(key), { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } })).status, 404);
    const ok = await send('nova', intake(key), { body: { name: 'Browser Lead', email: 'b@example.de' }, headers: { Origin: 'https://static.example.com', 'X-Forwarded-For': '10.9.9.1' } });
    assert.deepEqual([ok.status, ok.headers['access-control-allow-origin']], [202, 'https://static.example.com']);
    assert.equal((await send('nova', intake(key), { body: { name: 'x', email: 'x@example.de' }, headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await send('nova', intake(key), { body: { name: 'x', email: 'x@example.de' } })).status, 403);
  });

  test('a bot filling the hidden field gets "ok" but no lead', async () => {
    const r = await send('nova', intake(key), { body: { name: 'Spam Bot', email: 'bot@example.de', website: 'http://spam' }, headers: { Origin: 'https://static.example.com', 'X-Forwarded-For': '10.9.9.2' } });
    assert.deepEqual([r.status, r.json], [202, { ok: true }]);
    assert.equal((await leadsNamed('Spam Bot')).length, 0);
    assert.equal((await admin.get('nova', '/api/form-endpoints/submissions')).json[0].errorCode, 'spam');
  });

  test('more than 10 a minute from one visitor IP are refused', async () => {
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await send('nova', intake(key), { body: { name: `Visitor ${i}`, email: `v${i}@example.de` }, headers: { Origin: 'https://static.example.com', 'X-Forwarded-For': '10.9.9.3' } })).status);
    }
    assert.deepEqual([statuses.slice(0, 10).every(s => s === 202), statuses[10]], [true, 429]);
  });
});
