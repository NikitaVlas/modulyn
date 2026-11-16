import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { MissingTenantContextError, currentTenant, requireTenant, runWithRequestContext } from '../dist/tenancy/request-context.js';
import { TenantDb } from '../dist/database/tenant-db.service.js';

const tenant = (n) => ({ kind: 'tenant', tenant: { tenantId: `00000000-0000-7000-8000-00000000000${n}`, slug: `t${n}`, displayName: `T${n}` } });

test('without context tenant operations fail before any SQL is issued', async () => {
  let touched = false;
  const database = { assertRuntimeRole: async () => { touched = true; }, client: { $transaction: async () => { touched = true; } } };
  const db = new TenantDb(database);
  assert.throws(() => db.run(async () => 'x'), MissingTenantContextError);
  assert.equal(touched, false);
  assert.throws(() => requireTenant(), MissingTenantContextError);
});

test('platform and app contexts are not tenant contexts', () => {
  for (const kind of ['platform', 'app']) {
    runWithRequestContext({ kind }, () => assert.throws(() => requireTenant(), MissingTenantContextError));
  }
});

test('interleaved asynchronous requests keep their own tenant', async () => {
  const seen = await Promise.all(Array.from({ length: 50 }, (_, i) => runWithRequestContext(tenant(i % 2), async () => {
    await sleep(Math.random() * 5);
    const first = currentTenant().slug;
    await sleep(Math.random() * 5);
    return [i % 2, first, currentTenant().slug];
  })));
  for (const [n, first, second] of seen) { assert.equal(first, `t${n}`); assert.equal(second, `t${n}`); }
  assert.equal(currentTenant(), undefined);
});

test('tenant id is validated before a transaction is opened', async () => {
  const database = { assertRuntimeRole: async () => { throw new Error('must not be reached'); } };
  await assert.rejects(new TenantDb(database).runInTenant("x' OR 1=1 --", async () => 1), /Invalid tenant id/);
});
