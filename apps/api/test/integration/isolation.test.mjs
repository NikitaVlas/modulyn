// Интеграционные тесты изоляции компаний (подшаги 2.2–2.6). Реальный PostgreSQL, роль modulyn_app, RLS.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import pg from 'pg';
import { prepareTestDatabase } from './setup.mjs';

let env; let app; let database; let tenantDb; let port;
let nova; let companyB; let suspended; let bAdmin; let sharedManager;

before(async () => {
  env = await prepareTestDatabase();
  ({ nova, 'company-b': companyB, 'suspended-co': suspended } = env.seeded.tenants);
  bAdmin = env.seeded.users['admin@company-b.example'];
  sharedManager = env.seeded.users['manager@shared.example'];

  process.env.DATABASE_URL = env.appUrl;
  process.env.APP_BASE_DOMAIN = 'localhost';
  process.env.NODE_ENV = 'test';
  const { createApplication } = await import('../../dist/bootstrap.js');
  const { DatabaseService } = await import('../../dist/database/database.service.js');
  const { TenantDb } = await import('../../dist/database/tenant-db.service.js');
  app = await createApplication();
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  port = app.getHttpServer().address().port;
  database = app.get(DatabaseService);
  tenantDb = app.get(TenantDb);
});

after(async () => {
  await app?.close();
  await env?.ownerPrisma.$disconnect();
});

/** Отдельное подключение без Prisma для проверок на уровне SQL. */
async function rawClient(url = env.appUrl) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

function get(path, host, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, path, headers: { Host: host, ...extraHeaders } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('2.2 schema constraints', () => {
  test('a lead cannot be assigned to a person who is not a member of that company', async () => {
    await assert.rejects(tenantDb.runInTenant(nova.id, tx => tx.lead.create({
      data: { tenantId: nova.id, name: 'x', source: 'MANUAL', assignedToId: bAdmin.id },
    })), error => error.code === 'P2003');
  });

  test('history cannot reference a lead of another company even with the right tenant id', async () => {
    const bLead = await tenantDb.runInTenant(companyB.id, tx => tx.lead.findFirstOrThrow());
    await assert.rejects(tenantDb.runInTenant(nova.id, tx => tx.leadStatusHistory.create({
      data: { tenantId: nova.id, leadId: bLead.id, newStatus: 'NEW' },
    })), error => error.code === 'P2003');
  });

  test('slug format, reserved names and email normalization are enforced by the database', async () => {
    const owner = await rawClient(env.ownerUrl);
    try {
      for (const slug of ['admin', 'www', 'Nova', 'bad_slug', '-x', 'a.b']) {
        await assert.rejects(owner.query(
          "INSERT INTO tenants (id, slug, name, display_name, updated_at) VALUES (gen_random_uuid(), $1, 'x', 'x', now())", [slug],
        ), error => error.code === '23514', slug);
      }
      for (const email of ['Upper@example.com', ' space@example.com']) {
        await assert.rejects(owner.query(
          "INSERT INTO users (id, email, name, updated_at) VALUES (gen_random_uuid(), $1, 'x', now())", [email],
        ), error => error.code === '23514', email);
      }
    } finally { await owner.end(); }
  });

  test('assignment is removed by writing null, the tenant link stays intact', async () => {
    const lead = await tenantDb.runInTenant(nova.id, tx => tx.lead.findFirstOrThrow({ where: { assignedToId: { not: null } } }));
    const updated = await tenantDb.runInTenant(nova.id, tx => tx.lead.update({ where: { id: lead.id }, data: { assignedToId: null } }));
    assert.equal(updated.assignedToId, null);
    assert.equal(updated.tenantId, nova.id);
    await tenantDb.runInTenant(nova.id, tx => tx.lead.update({ where: { id: lead.id }, data: { assignedToId: sharedManager.id } }));
  });
});

describe('2.3 tenant resolution over HTTP', () => {
  test('active companies resolve, unknown and suspended look identical', async () => {
    assert.deepEqual(JSON.parse((await get('/api/tenant', 'nova.localhost:8080')).body), { slug: 'nova', displayName: 'Nova CRM' });
    assert.deepEqual(JSON.parse((await get('/api/tenant', 'company-b.localhost')).body), { slug: 'company-b', displayName: 'Company B CRM' });
    const unknown = await get('/api/tenant', 'unknown.localhost');
    const suspendedRes = await get('/api/tenant', `${suspended.slug}.localhost`);
    assert.equal(unknown.status, 404);
    assert.deepEqual(suspendedRes, unknown);
  });

  test('reserved, nested, foreign and bare hosts get the same 404; health works everywhere', async () => {
    const reference = await get('/api/tenant', 'unknown.localhost');
    for (const host of ['admin.localhost', 'app.localhost', 'www.localhost', 'localhost', 'a.nova.localhost', 'evil.com']) {
      const res = await get('/api/tenant', host);
      assert.equal(res.status, 404, host);
      assert.deepEqual(JSON.parse(res.body), JSON.parse(reference.body), host);
    }
    assert.equal((await get('/api/health/ready', 'evil.com')).status, 200);
  });

  test('a client-supplied X-Forwarded-Host cannot switch the company', async () => {
    const res = await get('/api/tenant', 'nova.localhost', { 'X-Forwarded-Host': 'company-b.localhost' });
    assert.equal(JSON.parse(res.body).slug, 'nova');
  });

  test('100 interleaved requests each see their own company', async () => {
    const hosts = ['nova.localhost', 'company-b.localhost'];
    const results = await Promise.all(Array.from({ length: 100 }, (_, i) => get('/api/tenant', hosts[i % 2])));
    results.forEach((res, i) => assert.equal(JSON.parse(res.body).slug, hosts[i % 2].split('.')[0]));
  });
});

describe('2.4 tenant context and scoped access', () => {
  test('each company sees only its own rows without any tenant filter in the query', async () => {
    const novaLeads = await tenantDb.runInTenant(nova.id, tx => tx.lead.findMany());
    const bLeads = await tenantDb.runInTenant(companyB.id, tx => tx.lead.findMany());
    assert.equal(novaLeads.length, 3);
    assert.equal(bLeads.length, 2);
    assert.ok(novaLeads.every(l => l.tenantId === nova.id));
    assert.ok(bLeads.every(l => l.tenantId === companyB.id));
    assert.equal((await tenantDb.runInTenant(nova.id, tx => tx.leadStatusHistory.findMany())).length, 3);
    assert.equal((await tenantDb.runInTenant(nova.id, tx => tx.membership.findMany())).length, 2);
  });

  test('a known id of another company is invisible, unchangeable and undeletable (IDOR)', async () => {
    const bLead = await tenantDb.runInTenant(companyB.id, tx => tx.lead.findFirstOrThrow());
    await tenantDb.runInTenant(nova.id, async tx => {
      assert.equal(await tx.lead.findUnique({ where: { id: bLead.id } }), null);
      assert.equal((await tx.lead.updateMany({ where: { id: bLead.id }, data: { status: 'CLOSED' } })).count, 0);
      assert.equal((await tx.lead.deleteMany({ where: { id: bLead.id } })).count, 0);
      await assert.rejects(tx.lead.update({ where: { id: bLead.id }, data: { status: 'CLOSED' } }), e => e.code === 'P2025');
    });
    const after = await tenantDb.runInTenant(companyB.id, tx => tx.lead.findUniqueOrThrow({ where: { id: bLead.id } }));
    assert.equal(after.status, bLead.status);
  });

  test('writing rows with another company id is rejected by RLS', async () => {
    await assert.rejects(tenantDb.runInTenant(nova.id, tx => tx.lead.create({
      data: { tenantId: companyB.id, name: 'smuggled', source: 'MANUAL' },
    })));
    const bCount = await tenantDb.runInTenant(companyB.id, tx => tx.lead.count());
    assert.equal(bCount, 2);
  });

  test('the manager who works in both companies sees only the current company', async () => {
    const inNova = await tenantDb.runInTenant(nova.id, tx => tx.lead.findMany({ where: { assignedToId: sharedManager.id } }));
    const inB = await tenantDb.runInTenant(companyB.id, tx => tx.lead.findMany({ where: { assignedToId: sharedManager.id } }));
    assert.deepEqual(inNova.map(l => l.name), ['Nova Lead 1']);
    assert.deepEqual(inB.map(l => l.name), ['Company B Lead 1']);
  });

  test('a failed transaction is rolled back and leaves no context behind', async () => {
    await assert.rejects(tenantDb.runInTenant(nova.id, async tx => {
      await tx.lead.create({ data: { tenantId: nova.id, name: 'rolled back', source: 'MANUAL' } });
      throw new Error('boom');
    }), /boom/);
    assert.equal(await tenantDb.runInTenant(nova.id, tx => tx.lead.count({ where: { name: 'rolled back' } })), 0);
    assert.equal(await database.client.lead.count(), 0, 'outside a tenant transaction nothing is visible');
  });

  test('100 concurrent transactions of two companies never mix', async () => {
    const ids = [nova.id, companyB.id];
    const counts = await Promise.all(Array.from({ length: 100 }, (_, i) =>
      tenantDb.runInTenant(ids[i % 2], async tx => {
        const rows = await tx.lead.findMany({ select: { tenantId: true } });
        return rows.every(r => r.tenantId === ids[i % 2]) ? rows.length : -1;
      })));
    counts.forEach((c, i) => assert.equal(c, i % 2 === 0 ? 3 : 2));
  });
});

describe('2.5 row-level security and the runtime role', () => {
  test('the runtime role is neither superuser nor BYPASSRLS nor table owner', async () => {
    const c = await rawClient();
    try {
      const { rows } = await c.query("SELECT rolsuper, rolbypassrls, (SELECT count(*) FROM pg_tables WHERE tableowner = current_user)::int AS owned FROM pg_roles WHERE rolname = current_user");
      assert.deepEqual(rows[0], { rolsuper: false, rolbypassrls: false, owned: 0 });
    } finally { await c.end(); }
  });

  test('without context: no rows and no inserts', async () => {
    const c = await rawClient();
    try {
      for (const table of ['leads', 'memberships', 'tenant_modules', 'lead_status_history', 'tenant_audit_logs']) {
        assert.equal((await c.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, table);
      }
      await assert.rejects(c.query(
        "INSERT INTO leads (id, tenant_id, name, source, updated_at) VALUES (gen_random_uuid(), $1, 'x', 'MANUAL', now())", [nova.id],
      ), e => e.code === '42501');
    } finally { await c.end(); }
  });

  test('a pooled connection forgets the tenant after the transaction', async () => {
    const pool = new pg.Pool({ connectionString: env.appUrl, max: 1 });
    try {
      const client = await pool.connect();
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [nova.id]);
        assert.equal((await client.query('SELECT count(*)::int AS n FROM leads')).rows[0].n, 3);
        await client.query('COMMIT');
      } finally { client.release(); }
      const again = await pool.connect();
      try {
        assert.equal((await again.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, pid, 'same physical connection');
        assert.equal((await again.query("SELECT current_setting('app.tenant_id', true) AS v")).rows[0].v, '');
        assert.equal((await again.query('SELECT count(*)::int AS n FROM leads')).rows[0].n, 0);
      } finally { again.release(); }
    } finally { await pool.end(); }
  });

  test('the runtime role cannot switch RLS off or bypass it', async () => {
    const c = await rawClient();
    try {
      await assert.rejects(c.query('ALTER TABLE leads DISABLE ROW LEVEL SECURITY'), e => e.code === '42501');
      await c.query('SET row_security = off');
      await assert.rejects(c.query('SELECT * FROM leads'), e => e.code === '42501');
    } finally { await c.end(); }
  });

  test('a person can read own memberships across companies but not change them without company context', async () => {
    const c = await rawClient();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.user_id', $1, true)", [sharedManager.id]);
      const { rows } = await c.query('SELECT tenant_id FROM memberships ORDER BY tenant_id');
      assert.deepEqual(rows.map(r => r.tenant_id).sort(), [nova.id, companyB.id].sort());
      assert.equal((await c.query("UPDATE memberships SET role = 'TENANT_ADMIN'")).rowCount, 0);
      assert.equal((await c.query('SELECT count(*)::int AS n FROM leads')).rows[0].n, 0);
      await c.query('ROLLBACK');
    } finally { await c.end(); }
  });

  test('history and audit are append-only, global tables are read-only for the runtime role', async () => {
    await assert.rejects(tenantDb.runInTenant(nova.id, tx => tx.leadStatusHistory.updateMany({ data: { newStatus: 'CLOSED' } })));
    await assert.rejects(tenantDb.runInTenant(nova.id, tx => tx.leadStatusHistory.deleteMany()));
    const c = await rawClient();
    try {
      await assert.rejects(c.query("UPDATE tenants SET status = 'ACTIVE'"), e => e.code === '42501');
      await assert.rejects(c.query('SELECT * FROM _prisma_migrations'), e => ['42501', '42P01'].includes(e.code));
    } finally { await c.end(); }
  });
});
