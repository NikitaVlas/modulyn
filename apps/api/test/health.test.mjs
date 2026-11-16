import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HealthController } from '../dist/health/health.controller.js';
test('liveness does not depend on database availability', () => {
  const controller = new HealthController({ ping: async () => { throw new Error('offline'); } });
  assert.deepEqual(controller.live(), { status: 'ok', service: 'modulyn-api' });
});
test('readiness confirms a successful database query', async () => {
  let queried = false;
  const controller = new HealthController({ ping: async () => { queried = true; } });
  assert.deepEqual(await controller.ready(), { status: 'ready', database: 'up' });
  assert.equal(queried, true);
});
test('database failure becomes 503 without internal error details', async () => {
  const controller = new HealthController({ ping: async () => { throw new Error('postgresql://secret'); } });
  await assert.rejects(controller.ready(), error => error.getStatus() === 503 && !JSON.stringify(error.getResponse()).includes('secret'));
});
