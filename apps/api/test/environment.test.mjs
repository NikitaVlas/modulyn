import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvironment } from '../dist/config/environment.js';
const base = { DATABASE_URL: 'postgresql://test:local@localhost:5432/test' };
test('valid configuration uses development defaults', () => { assert.equal(parseEnvironment(base).port, 3001); });
test('missing database URL fails closed', () => { assert.throws(() => parseEnvironment({}), /DATABASE_URL is required/); });
test('invalid ports are rejected rather than truncated', () => {
  for (const API_PORT of ['0', '65536', '3001oops', '1.5', '-1']) assert.throws(() => parseEnvironment({ ...base, API_PORT }), /API_PORT/);
});
test('database validation never includes credentials in errors', () => {
  for (const DATABASE_URL of ['https://user:secret@localhost/db', 'postgresql://localhost/db', 'secret']) {
    assert.throws(() => parseEnvironment({ DATABASE_URL }), error => !error.message.includes('secret') && error.message.startsWith('DATABASE_URL'));
  }
});
test('unknown runtime environment is rejected', () => { assert.throws(() => parseEnvironment({ ...base, NODE_ENV: 'prod' }), /NODE_ENV/); });
test('base domain defaults to localhost and rejects scheme, port or upper case', () => {
  assert.equal(parseEnvironment(base).appBaseDomain, 'localhost');
  assert.equal(parseEnvironment({ ...base, APP_BASE_DOMAIN: 'modulyn.app' }).appBaseDomain, 'modulyn.app');
  for (const APP_BASE_DOMAIN of ['https://modulyn.app', 'modulyn.app:443', 'Modulyn.app', '.modulyn.app', '']) {
    assert.throws(() => parseEnvironment({ ...base, APP_BASE_DOMAIN }), /APP_BASE_DOMAIN/);
  }
});
test('dev proxy host trust is opt-in and forbidden in production', () => {
  assert.equal(parseEnvironment(base).trustDevProxyHost, false);
  assert.equal(parseEnvironment({ ...base, TRUST_DEV_PROXY_HOST: 'true' }).trustDevProxyHost, true);
  assert.throws(() => parseEnvironment({ ...base, NODE_ENV: 'production', TRUST_DEV_PROXY_HOST: 'true' }), /TRUST_DEV_PROXY_HOST/);
});
