// Интеграционные тесты Phase 7 (7.2–7.7): список, карточка, статусы с историей, назначение, ручные заявки, изоляция.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { prepareTestDatabase } from './setup.mjs';
import { SEED_PASSWORD } from '../../scripts/seed.mjs';
import { Browser } from './browser.mjs';

let env; let app; let port; let tenants; let users;
let admin; let manager; let bAdmin;

before(async () => {
  env = await prepareTestDatabase();
  ({ tenants, users } = env.seeded);
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

const list = (b, query = '', slug = 'nova') => b.get(slug, '/api/leads' + (query ? '?' + query : ''));
const MANAGER = () => users['manager@shared.example'].id;

describe('7.2 list and card', () => {
  test('the list shows only this company, newest first, without message text', async () => {
    const r = await list(manager);
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.total, r.json.page, r.json.pageSize], [3, 1, 25]);
    assert.ok(r.json.items.every(i => !('message' in i)), 'message only in the card (L8)');
    const dates = r.json.items.map(i => i.createdAt);
    assert.deepEqual(dates, [...dates].sort().reverse());
    const b = await list(bAdmin, '', 'company-b');
    assert.equal(b.json.total, 2);
    assert.ok(!b.json.items.some(i => i.name.startsWith('Nova')));
    const assigned = r.json.items.find(i => i.name === 'Nova Lead 1');
    assert.deepEqual(assigned.assignee, { userId: MANAGER(), name: 'Shared Manager' });
    assert.deepEqual([assigned.source, assigned.sourceDetail], ['WEB_FORM', 'trial']);
  });

  test('filters, search, sort and pages; bad parameters are refused clearly', async () => {
    assert.equal((await list(manager, 'status=NEW')).json.total, 3);
    assert.equal((await list(manager, 'status=CLOSED,CONVERTED')).json.total, 0);
    assert.deepEqual((await list(manager, 'assignee=me')).json.items.map(i => i.name), ['Nova Lead 1']);
    assert.equal((await list(admin, 'assignee=me')).json.total, 0, '"me" is the requesting user');
    assert.equal((await list(manager, 'assignee=none')).json.total, 2);
    assert.equal((await list(manager, `assignee=${MANAGER()}`)).json.total, 1);
    assert.deepEqual((await list(manager, 'q=LEAD1%40NOVA')).json.items.map(i => i.name), ['Nova Lead 1'], 'email, case-insensitive');
    assert.deepEqual((await list(manager, 'q=0000001')).json.items.map(i => i.name), ['Nova Lead 2'], 'phone');
    assert.equal((await list(manager, 'q=Company')).json.total, 0, 'no leads of another company');
    const asc = (await list(manager, 'sort=created_asc')).json.items.map(i => i.id);
    const desc = (await list(manager, 'sort=created_desc')).json.items.map(i => i.id);
    assert.deepEqual(asc, [...desc].reverse());
    const page2 = await list(manager, 'page=2&pageSize=25');
    assert.deepEqual([page2.json.items.length, page2.json.total], [0, 3]);
    for (const bad of ['status=OPEN', 'pageSize=10', 'page=0', 'assignee=someone', 'sort=name', 'q=' + 'x'.repeat(101)]) {
      assert.equal((await list(manager, bad)).status, 400, bad);
    }
  });

  test('the card has the message and the status history; another company\'s lead is not found', async () => {
    const id = (await list(manager)).json.items.find(i => i.name === 'Nova Lead 1').id;
    const card = await manager.get('nova', `/api/leads/${id}`);
    assert.equal(card.status, 200);
    assert.equal(card.json.email, 'lead1@nova-visitor.example');
    assert.deepEqual(card.json.history.map(h => [h.previousStatus, h.newStatus, h.changedBy]), [[null, 'NEW', null]]);
    const bLeadId = (await list(bAdmin, '', 'company-b')).json.items[0].id;
    const idor = await manager.get('nova', `/api/leads/${bLeadId}`);
    const missing = await manager.get('nova', '/api/leads/00000000-0000-7000-8000-000000000000');
    assert.deepEqual([idor.status, idor.body], [missing.status, missing.body], 'foreign and missing look the same');
    assert.equal(idor.status, 404);
    assert.equal((await manager.get('nova', '/api/leads/not-a-uuid')).status, 404);
  });
});

describe('7.3 status changes with history', () => {
  test('status and history change together; a stale change gets 409 and changes nothing', async () => {
    const id = (await list(manager, 'q=Nova%20Lead%202')).json.items[0].id;
    assert.equal((await manager.post('nova', `/api/leads/${id}/status`, { from: 'NEW', to: 'IN_PROGRESS' })).status, 204);
    const card = await admin.get('nova', `/api/leads/${id}`);
    assert.equal(card.json.status, 'IN_PROGRESS');
    assert.deepEqual(card.json.history.map(h => [h.previousStatus, h.newStatus, h.changedBy?.name ?? null]),
      [[null, 'NEW', null], ['NEW', 'IN_PROGRESS', 'Shared Manager']]);

    const stale = await admin.post('nova', `/api/leads/${id}/status`, { from: 'NEW', to: 'CLOSED' });
    assert.deepEqual([stale.status, stale.json.code, stale.json.current], [409, 'LEAD_CHANGED', 'IN_PROGRESS']);
    assert.equal((await admin.get('nova', `/api/leads/${id}`)).json.history.length, 2, 'nothing written on conflict');
    assert.equal((await admin.post('nova', `/api/leads/${id}/status`, { from: 'IN_PROGRESS', to: 'IN_PROGRESS' })).status, 400);
    assert.equal((await admin.post('nova', `/api/leads/${id}/status`, { from: 'IN_PROGRESS', to: 'WON' })).status, 400);
    // L1: любой переход, в том числе назад.
    assert.equal((await admin.post('nova', `/api/leads/${id}/status`, { from: 'IN_PROGRESS', to: 'NEW' })).status, 204);
  });

  test('two simultaneous changes: exactly one wins; history always matches the status', async () => {
    const id = (await list(manager, 'q=Nova%20Lead%203')).json.items[0].id;
    const [a, b] = await Promise.all([
      manager.post('nova', `/api/leads/${id}/status`, { from: 'NEW', to: 'CONTACTED' }),
      admin.post('nova', `/api/leads/${id}/status`, { from: 'NEW', to: 'CLOSED' }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [204, 409]);
    const { rows } = await owner(`
      SELECT l.id, l.status, (SELECT h.new_status FROM lead_status_history h WHERE h.lead_id = l.id ORDER BY h.created_at DESC, h.id DESC LIMIT 1) AS last
      FROM leads l`, [], tenants.nova.id);
    assert.ok(rows.every(r => r.status === r.last), 'every lead status equals its last history entry');
  });

  test('a status change on another company\'s lead is not found', async () => {
    const bLeadId = (await list(bAdmin, '', 'company-b')).json.items[0].id;
    assert.equal((await manager.post('nova', `/api/leads/${bLeadId}/status`, { from: 'NEW', to: 'CLOSED' })).status, 404);
    assert.equal((await bAdmin.get('company-b', `/api/leads/${bLeadId}`)).json.status, 'NEW');
  });
});

describe('7.4 assignment', () => {
  test('only admins assign; only active members of this company; unassign; audit', async () => {
    const id = (await list(admin, 'q=Nova%20Lead%202')).json.items[0].id;
    assert.equal((await manager.send('PUT', 'nova', `/api/leads/${id}/assignee`, { origin: 'http://nova.localhost:8080', json: { userId: MANAGER() } })).status, 403, 'managers do not assign');
    const put = body => admin.send('PUT', 'nova', `/api/leads/${id}/assignee`, { origin: 'http://nova.localhost:8080', json: body });
    assert.equal((await put({ userId: MANAGER() })).status, 204);
    assert.deepEqual((await admin.get('nova', `/api/leads/${id}`)).json.assignee, { userId: MANAGER(), name: 'Shared Manager' });
    assert.ok((await list(manager, 'assignee=me')).json.items.some(i => i.id === id));

    assert.equal((await put({ userId: users['admin@company-b.example'].id })).status, 400, 'not a member of this company');
    await owner('UPDATE memberships SET is_active = false WHERE user_id = $1', [MANAGER()], tenants.nova.id);
    try {
      assert.equal((await put({ userId: MANAGER() })).status, 400, 'inactive member');
    } finally {
      await owner('UPDATE memberships SET is_active = true WHERE user_id = $1', [MANAGER()], tenants.nova.id);
    }
    assert.equal((await put({ userId: 'nope' })).status, 400);
    assert.equal((await put({ userId: null })).status, 204);
    assert.equal((await admin.get('nova', `/api/leads/${id}`)).json.assignee, null);
    const bLeadId = (await list(bAdmin, '', 'company-b')).json.items[0].id;
    assert.equal((await admin.send('PUT', 'nova', `/api/leads/${bLeadId}/assignee`, { origin: 'http://nova.localhost:8080', json: { userId: null } })).status, 404);

    const { rows } = await owner("SELECT action, metadata FROM tenant_audit_logs WHERE action LIKE 'lead.%' ORDER BY created_at", [], tenants.nova.id);
    assert.deepEqual(rows.map(r => r.action), ['lead.assigned', 'lead.unassigned']);
    assert.ok(rows.every(r => !JSON.stringify(r.metadata ?? {}).includes('@')));
  });

  test('assignee list: active members of this company only', async () => {
    const r = await manager.get('nova', '/api/leads/assignees');
    assert.deepEqual(r.json.map(a => [a.name, a.role]), [['Nova Admin', 'TENANT_ADMIN'], ['Shared Manager', 'MANAGER']]);
  });
});

describe('L4 manual leads', () => {
  test('both roles create a lead with a name and at least one contact', async () => {
    const created = await manager.post('nova', '/api/leads', { name: '  Звонок Иван ', phone: '+49 2161 123456', message: 'Хочет пробную тренировку' });
    assert.equal(created.status, 201);
    const card = await admin.get('nova', `/api/leads/${created.json.id}`);
    assert.deepEqual([card.json.name, card.json.source, card.json.status, card.json.email, card.json.message],
      ['Звонок Иван', 'MANUAL', 'NEW', null, 'Хочет пробную тренировку']);
    assert.deepEqual(card.json.history.map(h => [h.previousStatus, h.newStatus, h.changedBy?.name]), [[null, 'NEW', 'Shared Manager']]);
    assert.equal((await admin.post('nova', '/api/leads', { name: 'Mail Only', email: 'Visitor@Example.com' })).status, 201);
    for (const bad of [{ name: 'No contact' }, { name: '', phone: '123' }, { name: 'x', email: 'bad' }, { name: 'x', phone: 'abc' }, { name: 'x'.repeat(201), phone: '123' }]) {
      assert.equal((await manager.post('nova', '/api/leads', bad)).status, 400, JSON.stringify(bad));
    }
    assert.equal((await list(bAdmin, 'q=' + encodeURIComponent('Звонок'), 'company-b')).json.total, 0, 'not visible in another company');
    assert.equal((await list(manager, 'q=' + encodeURIComponent('звонок'))).json.total, 1, 'Cyrillic search, case-insensitive');
  });
});

describe('7.7 module disabled', () => {
  test('every leads route answers MODULE_DISABLED when the module is off', async () => {
    const id = (await list(admin)).json.items[0].id;
    await owner("UPDATE tenant_modules SET enabled = false WHERE module_id = (SELECT id FROM modules WHERE key = 'leads')", [], tenants.nova.id);
    try {
      const nova = 'http://nova.localhost:8080';
      const calls = [
        admin.get('nova', '/api/leads'),
        admin.get('nova', `/api/leads/${id}`),
        admin.get('nova', '/api/leads/summary'),
        admin.get('nova', '/api/leads/assignees'),
        admin.post('nova', '/api/leads', { name: 'x', phone: '123' }),
        admin.post('nova', `/api/leads/${id}/status`, { from: 'NEW', to: 'CLOSED' }),
        admin.send('PUT', 'nova', `/api/leads/${id}/assignee`, { origin: nova, json: { userId: null } }),
      ];
      for (const r of await Promise.all(calls)) assert.deepEqual([r.status, r.json.code], [403, 'MODULE_DISABLED']);
    } finally {
      await owner("UPDATE tenant_modules SET enabled = true WHERE module_id = (SELECT id FROM modules WHERE key = 'leads')", [], tenants.nova.id);
    }
    assert.equal((await list(admin)).status, 200);
  });
});
