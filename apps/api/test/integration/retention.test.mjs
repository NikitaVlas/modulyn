// Phase 9.5: сроки хранения (F5), очистка функцией БД (F7) и удаление заявки администратором (F6).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import pg from 'pg';
import { prepareTestDatabase } from './setup.mjs';
import { SEED_INTAKE, SEED_PASSWORD } from '../../scripts/seed.mjs';
import { Browser } from './browser.mjs';

let env; let app; let port; let tenants; let users; let platformAdmins;

before(async () => {
  env = await prepareTestDatabase();
  ({ tenants, users, platformAdmins } = env.seeded);
  Object.assign(process.env, {
    DATABASE_URL: env.appUrl, APP_BASE_DOMAIN: 'localhost', NODE_ENV: 'test', PUBLIC_PORT: '8080', PUBLIC_SCHEME: 'http', TRUST_PROXY: 'true', SMTP_URL: 'memory:',
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
});

async function client(url, fn) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try { return await fn(c); } finally { await c.end(); }
}
/** Запросы владельцем схемы в контексте компании (для подготовки данных «в прошлом»). */
const owner = (sql, params = [], tenantId = null) => client(env.ownerUrl, async c => {
  await c.query('BEGIN');
  if (tenantId) await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  const r = await c.query(sql, params);
  await c.query('COMMIT');
  return r;
});
const hash = () => randomBytes(32).toString('hex');
const cleanup = () => client(env.appUrl, async c => (await c.query('SELECT modulyn_cleanup() AS r')).rows[0].r);

describe('9.5 cleanup of technical records (F5, F7)', () => {
  test('old records go, fresh ones and leads stay; every company is cleaned, isolation intact', async () => {
    const nova = tenants.nova.id; const b = tenants['company-b'].id;
    const userId = users['manager@shared.example'].id;
    const adminId = platformAdmins['platform@modulyn.example'].id;
    const endpointId = (await owner('SELECT id FROM form_endpoints WHERE public_key = $1', [SEED_INTAKE.publicKey], nova)).rows[0].id;

    // Сессии входа: старая отозванная (40 дней), свежая.
    const oldUs = (await owner(`INSERT INTO user_sessions (id, user_id, token_hash, family_id, expires_at, absolute_expires_at, revoked_at, created_at)
      VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), now() - interval '40 days', now() - interval '35 days', now() - interval '40 days', now() - interval '45 days') RETURNING id`, [userId, hash()])).rows[0].id;
    const freshUs = (await owner(`INSERT INTO user_sessions (id, user_id, token_hash, family_id, expires_at, absolute_expires_at)
      VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), now() + interval '7 days', now() + interval '30 days') RETURNING id`, [userId, hash()])).rows[0].id;
    // Старая сессия входа, на которую ещё ссылается живая сессия компании, — остаётся (внешний ключ).
    const heldUs = (await owner(`INSERT INTO user_sessions (id, user_id, token_hash, family_id, expires_at, absolute_expires_at)
      VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), now() - interval '60 days', now() - interval '31 days') RETURNING id`, [userId, hash()])).rows[0].id;
    for (const [tenantId, us, expired] of [[nova, oldUs, true], [b, oldUs, true], [nova, heldUs, false], [nova, freshUs, false]]) {
      await owner(`INSERT INTO tenant_sessions (id, tenant_id, user_id, user_session_id, token_hash, family_id, expires_at, absolute_expires_at)
        VALUES (gen_random_uuid(), $1, $2, $3, $4, gen_random_uuid(), now() ${expired ? "- interval '35 days'" : "+ interval '1 day'"}, now() ${expired ? "- interval '31 days'" : "+ interval '20 days'"})`,
      [tenantId, userId, us, hash()], tenantId);
    }
    await owner(`INSERT INTO platform_sessions (id, admin_id, token_hash, family_id, expires_at, absolute_expires_at)
      VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), now() - interval '31 days', now() - interval '31 days')`, [adminId, hash()]);
    await owner(`INSERT INTO login_handoffs (id, user_id, tenant_id, user_session_id, code_hash, state_hash, expires_at)
      VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, now() - interval '2 days')`, [userId, nova, freshUs, hash(), hash()]);
    await owner(`INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (gen_random_uuid(), $1, $2, now() - interval '2 days')`, [userId, hash()]);
    await owner(`INSERT INTO auth_throttle (key_hash, window_start, count) VALUES ($1, now() - interval '2 days', 3), ($2, now(), 1)`, [hash(), hash()]);
    // Приглашения: истекло 31 день назад (уходит), отозвано вчера (остаётся).
    await owner(`INSERT INTO invitations (id, tenant_id, email, name, role, token_hash, expires_at) VALUES (gen_random_uuid(), $1, 'old@x.example', 'Old', 'MANAGER', $2, now() - interval '31 days')`, [b, hash()], b);
    await owner(`INSERT INTO invitations (id, tenant_id, email, name, role, token_hash, expires_at, revoked_at) VALUES (gen_random_uuid(), $1, 'new@x.example', 'New', 'MANAGER', $2, now() + interval '6 days', now() - interval '1 day')`, [nova, hash()], nova);
    // Журнал приёма: 91 день (уходит) и 89 дней (остаётся). Аудит: 366 и 364 дня.
    await owner(`INSERT INTO form_submissions (id, tenant_id, endpoint_id, idempotency_key, status, error_code, created_at)
      VALUES (gen_random_uuid(), $1, $2, 'old-91', 'REJECTED', 'spam', now() - interval '91 days'), (gen_random_uuid(), $1, $2, 'old-89', 'REJECTED', 'spam', now() - interval '89 days')`, [nova, endpointId], nova);
    await owner(`INSERT INTO tenant_audit_logs (id, tenant_id, action, created_at) VALUES (gen_random_uuid(), $1, 'test.old', now() - interval '366 days'), (gen_random_uuid(), $1, 'test.recent', now() - interval '364 days')`, [b], b);
    await owner(`INSERT INTO platform_audit_logs (id, action, created_at) VALUES (gen_random_uuid(), 'test.old', now() - interval '366 days')`);
    // Очень старая заявка — не трогается никогда.
    await owner(`UPDATE leads SET created_at = now() - interval '5 years' WHERE name = 'Nova Lead 3'`, [], nova);
    const leadsBefore = Number((await owner('SELECT count(*) FROM leads', [], nova)).rows[0].count);

    const result = await cleanup();
    assert.deepEqual(
      [result.tenant_sessions, result.user_sessions, result.platform_sessions, result.login_handoffs, result.password_resets, result.auth_throttle,
        result.invitations, result.form_submissions, result.tenant_audit_logs, result.platform_audit_logs],
      [2, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    );
    const exists = async (table, id, tenantId) => (await owner(`SELECT 1 FROM ${table} WHERE id = $1`, [id], tenantId)).rowCount === 1;
    assert.equal(await exists('user_sessions', oldUs), false);
    assert.equal(await exists('user_sessions', heldUs), true, 'still referenced by a live company session');
    assert.equal(await exists('user_sessions', freshUs), true);
    assert.equal((await owner("SELECT 1 FROM invitations WHERE email = 'new@x.example'", [], nova)).rowCount, 1);
    assert.equal((await owner("SELECT 1 FROM form_submissions WHERE idempotency_key = 'old-89'", [], nova)).rowCount, 1);
    assert.equal((await owner("SELECT 1 FROM tenant_audit_logs WHERE action = 'test.recent'", [], b)).rowCount, 1);
    assert.equal(Number((await owner('SELECT count(*) FROM leads', [], nova)).rows[0].count), leadsBefore, 'leads are never cleaned');

    const again = await cleanup();
    assert.ok(Object.values(again).every(n => n === 0), 'second run has nothing to do');
  });

  test('the runtime role may only call the function — no direct deletes of journals and sessions', async () => {
    for (const table of ['tenant_audit_logs', 'platform_audit_logs', 'form_submissions', 'user_sessions', 'tenant_sessions', 'invitations', 'lead_status_history']) {
      await assert.rejects(client(env.appUrl, c => c.query(`DELETE FROM ${table}`)), /permission denied/, table);
    }
  });

  test('two runs at the same time: the second one skips', async () => {
    await client(env.appUrl, async holder => {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('modulyn_cleanup'))");
      assert.deepEqual(await cleanup(), { skipped: true });
      await holder.query('ROLLBACK');
    });
  });
});

function send(slug, path, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = httpRequest({ hostname: '127.0.0.1', port, method: 'POST', path, headers: { Host: `${slug}.localhost:8080`, 'content-type': 'application/json', ...headers } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('9.5 deleting a lead on request (F6)', () => {
  let admin; let manager; let bAdmin;
  before(async () => {
    const login = async (email, slug) => {
      const b = new Browser(port);
      assert.equal((await b.post('app', '/api/auth/login', { email, password: SEED_PASSWORD })).status, 200);
      assert.equal((await b.enter(slug)).headers.location, '/');
      return b;
    };
    admin = await login('admin@nova.example', 'nova');
    manager = await login('manager@shared.example', 'nova');
    bAdmin = await login('admin@company-b.example', 'company-b');
  });

  test('the admin deletes a website lead: lead, history and journal link are gone, the audit keeps no personal data', async () => {
    assert.equal(await send('nova', `/api/webhooks/forms/${SEED_INTAKE.publicKey}`,
      { submissionId: 'delete-me-0001', firstName: 'Erika', lastName: 'Loeschen', email: 'erika@example.de', phone: '+49 1', program: 'Erwachsene' },
      { 'X-CRM-Integration-Key': SEED_INTAKE.secret }), 202);
    const nova = tenants.nova.id;
    const id = (await owner("SELECT id FROM leads WHERE name = 'Erika Loeschen'", [], nova)).rows[0].id;

    assert.equal((await manager.send('DELETE', 'nova', `/api/leads/${id}`, { origin: 'http://nova.localhost:8080', json: {} })).status, 403);
    assert.equal((await bAdmin.send('DELETE', 'company-b', `/api/leads/${id}`, { origin: 'http://company-b.localhost:8080', json: {} })).status, 404, 'other company');
    const r = await admin.send('DELETE', 'nova', `/api/leads/${id}`, { origin: 'http://nova.localhost:8080', json: {} });
    assert.equal(r.status, 204);

    assert.equal((await owner('SELECT 1 FROM leads WHERE id = $1', [id], nova)).rowCount, 0);
    assert.equal((await owner('SELECT 1 FROM lead_status_history WHERE lead_id = $1', [id], nova)).rowCount, 0);
    const sub = (await owner("SELECT status, lead_id FROM form_submissions WHERE idempotency_key = 'id:delete-me-0001'", [], nova)).rows;
    assert.deepEqual(sub, [{ status: 'IMPORTED', lead_id: null }]);
    const audit = (await owner("SELECT action, entity_id, metadata FROM tenant_audit_logs WHERE action = 'lead.deleted'", [], nova)).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].entity_id, id);
    assert.doesNotMatch(JSON.stringify(audit), /Erika|Loeschen|erika@|\+49/);
    assert.equal((await admin.get('nova', `/api/leads/${id}`)).status, 404);
    assert.equal((await admin.send('DELETE', 'nova', `/api/leads/${id}`, { origin: 'http://nova.localhost:8080', json: {} })).status, 404, 'twice');
    // Повтор той же отправки сайта после удаления — по-прежнему дубль: удалённая заявка не воскресает.
    assert.equal(await send('nova', `/api/webhooks/forms/${SEED_INTAKE.publicKey}`,
      { submissionId: 'delete-me-0001', firstName: 'Erika', lastName: 'Loeschen', email: 'erika@example.de', phone: '+49 1', program: 'Erwachsene' },
      { 'X-CRM-Integration-Key': SEED_INTAKE.secret }), 202);
    assert.equal((await owner("SELECT 1 FROM leads WHERE name = 'Erika Loeschen'", [], nova)).rowCount, 0);
  });

  test('company B leads are untouched by Nova deletions', async () => {
    const before = (await owner('SELECT count(*)::int AS n FROM leads', [], tenants['company-b'].id)).rows[0].n;
    assert.equal(before, 2);
  });
});
