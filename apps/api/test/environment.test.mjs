import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEnvironment } from '../dist/config/environment.js';
const secrets = { JWT_SECRET_TENANT: 't'.repeat(32), JWT_SECRET_APP: 'a'.repeat(32), JWT_SECRET_PLATFORM: 'p'.repeat(32), PLATFORM_TOTP_KEY: 'ab'.repeat(32) };
const base = { DATABASE_URL: 'postgresql://test:local@localhost:5432/test', ...secrets };
test('valid configuration uses development defaults', () => { assert.equal(parseEnvironment(base).port, 3001); });
test('missing database URL fails closed', () => { assert.throws(() => parseEnvironment({}), /DATABASE_URL is required/); });
test('invalid ports are rejected rather than truncated', () => {
  for (const API_PORT of ['0', '65536', '3001oops', '1.5', '-1']) assert.throws(() => parseEnvironment({ ...base, API_PORT }), /API_PORT/);
});
test('database validation never includes credentials in errors', () => {
  for (const DATABASE_URL of ['https://user:secret@localhost/db', 'postgresql://localhost/db', 'secret']) {
    assert.throws(() => parseEnvironment({ ...secrets, DATABASE_URL }), error => !error.message.includes('secret') && error.message.startsWith('DATABASE_URL'));
  }
});
test('JWT secrets are required, long enough and different per context', () => {
  assert.throws(() => parseEnvironment({ ...base, JWT_SECRET_APP: undefined }), /JWT_SECRET_APP/);
  assert.throws(() => parseEnvironment({ ...base, JWT_SECRET_TENANT: 'short' }), /JWT_SECRET_TENANT/);
  assert.throws(() => parseEnvironment({ ...base, JWT_SECRET_PLATFORM: secrets.JWT_SECRET_APP }), /must differ/);
});
test('plain http is allowed only for the local base domain', () => {
  assert.equal(parseEnvironment(base).publicScheme, 'http');
  assert.equal(parseEnvironment({ ...base, APP_BASE_DOMAIN: 'modulyn.app' }).publicScheme, 'https');
  assert.throws(() => parseEnvironment({ ...base, APP_BASE_DOMAIN: 'modulyn.app', PUBLIC_SCHEME: 'http' }), /PUBLIC_SCHEME/);
  assert.throws(() => parseEnvironment({ ...base, PUBLIC_PORT: '80a' }), /PUBLIC_PORT/);
});
test('public origins are built from scheme, base domain and port', async () => {
  const { originFor } = await import('../dist/config/environment.js');
  assert.equal(originFor(parseEnvironment({ ...base, PUBLIC_PORT: '8080' }), 'app'), 'http://app.localhost:8080');
  assert.equal(originFor(parseEnvironment({ ...base, APP_BASE_DOMAIN: 'modulyn.app', PUBLIC_PORT: '443' }), 'nova'), 'https://nova.modulyn.app');
});
test('Google sign-in needs both credentials and an https issuer outside local development', () => {
  assert.equal(parseEnvironment(base).google, undefined);
  assert.throws(() => parseEnvironment({ ...base, GOOGLE_CLIENT_ID: 'id' }), /GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
  assert.equal(parseEnvironment({ ...base, GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' }).google.issuer, 'https://accounts.google.com');
  assert.throws(() => parseEnvironment({ ...base, NODE_ENV: 'production', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's', GOOGLE_ISSUER: 'http://fake' }), /https/);
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
test('the TOTP encryption key is required and must be 32 bytes in hex', () => {
  assert.throws(() => parseEnvironment({ ...base, PLATFORM_TOTP_KEY: undefined }), /PLATFORM_TOTP_KEY/);
  assert.throws(() => parseEnvironment({ ...base, PLATFORM_TOTP_KEY: 'ab'.repeat(16) }), /PLATFORM_TOTP_KEY/);
  assert.equal(parseEnvironment(base).totpKey.length, 32);
});
test('mail: SMTP URL scheme is checked; memory: only outside production', () => {
  assert.equal(parseEnvironment(base).smtpUrl, undefined);
  assert.equal(parseEnvironment({ ...base, SMTP_URL: 'smtp://127.0.0.1:1025' }).smtpUrl, 'smtp://127.0.0.1:1025');
  assert.throws(() => parseEnvironment({ ...base, SMTP_URL: 'http://mail' }), /SMTP_URL/);
  assert.throws(() => parseEnvironment({ ...base, NODE_ENV: 'production', SMTP_URL: 'memory:' }), /memory/);
  assert.match(parseEnvironment(base).mailFrom, /no-reply@modulyn\.localhost/);
  assert.throws(() => parseEnvironment({ ...base, MAIL_FROM: 'x\r\nBcc: evil@example.com' }), /MAIL_FROM/);
});
