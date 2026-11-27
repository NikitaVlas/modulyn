// Phase 11 (E2, E3): адреса выделенной установки — разбор настройки, Host → контекст, ссылки, режим одной компании.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostFor, parseHosting, singleCompany } from '@modulyn/contracts';
import { resolveHost } from '../dist/tenancy/hostname.js';
import { originFor, parseEnvironment } from '../dist/config/environment.js';

const NOVA = { APP_BASE_DOMAIN: 'crm.bjjmoenchengladbach.de', APP_HOST: 'login.crm.bjjmoenchengladbach.de', PLATFORM_HOST: 'admin.crm.bjjmoenchengladbach.de', TENANT_HOSTS: 'crm.bjjmoenchengladbach.de=nova' };

test('without explicit hosts — the label + base domain scheme, unchanged', () => {
  const h = parseHosting({ APP_BASE_DOMAIN: 'localhost' });
  assert.deepEqual(h, { baseDomain: 'localhost' });
  assert.equal(hostFor(h, 'nova'), 'nova.localhost');
  assert.equal(singleCompany(h), null);
  assert.deepEqual(parseHosting({ APP_HOST: '', PLATFORM_HOST: '', TENANT_HOSTS: '' }), { baseDomain: 'localhost' }, 'empty values from Compose = not set');
});

test('explicit hosts of a dedicated installation', () => {
  const h = parseHosting(NOVA);
  assert.deepEqual(resolveHost('crm.bjjmoenchengladbach.de', h), { kind: 'tenant', slug: 'nova' });
  assert.deepEqual(resolveHost('CRM.bjjmoenchengladbach.de:443', h), { kind: 'tenant', slug: 'nova' });
  assert.deepEqual(resolveHost('login.crm.bjjmoenchengladbach.de', h), { kind: 'app' });
  assert.deepEqual(resolveHost('admin.crm.bjjmoenchengladbach.de', h), { kind: 'platform' });
  for (const other of ['nova.crm.bjjmoenchengladbach.de', 'app.crm.bjjmoenchengladbach.de', 'bjjmoenchengladbach.de', 'evil.example', 'x.crm.bjjmoenchengladbach.de']) {
    assert.deepEqual(resolveHost(other, h), { kind: 'invalid' }, other);
  }
  assert.equal(hostFor(h, 'app'), 'login.crm.bjjmoenchengladbach.de');
  assert.equal(hostFor(h, 'admin'), 'admin.crm.bjjmoenchengladbach.de');
  assert.equal(hostFor(h, 'nova'), 'crm.bjjmoenchengladbach.de');
  assert.equal(singleCompany(h), 'nova');
  assert.equal(singleCompany(parseHosting({ ...NOVA, TENANT_HOSTS: 'crm.a.de=a, crm.b.de=b' })), null, 'two companies — not single');
});

test('configuration errors stop the start', () => {
  assert.throws(() => parseHosting({ APP_HOST: 'login.x.de' }), /set together/);
  assert.throws(() => parseHosting({ ...NOVA, TENANT_HOSTS: 'crm.x.de' }), /host=slug/);
  assert.throws(() => parseHosting({ ...NOVA, TENANT_HOSTS: 'crm.x.de=Nova!' }), /host=slug/);
  assert.throws(() => parseHosting({ ...NOVA, APP_HOST: 'crm.bjjmoenchengladbach.de' }), /different/);
  assert.throws(() => parseHosting({ ...NOVA, PLATFORM_HOST: 'https://admin.x.de' }), /Invalid host/);
});

test('links use the explicit hosts with https; http only for *.localhost', () => {
  const base = { DATABASE_URL: 'postgresql://u:p@db:5432/m', JWT_SECRET_TENANT: 'a'.repeat(32), JWT_SECRET_APP: 'b'.repeat(32), JWT_SECRET_PLATFORM: 'c'.repeat(32), PLATFORM_TOTP_KEY: 'd'.repeat(64) };
  const env = parseEnvironment({ ...base, ...NOVA });
  assert.equal(originFor(env, 'app'), 'https://login.crm.bjjmoenchengladbach.de');
  assert.equal(originFor(env, 'nova'), 'https://crm.bjjmoenchengladbach.de');
  assert.throws(() => parseEnvironment({ ...base, ...NOVA, APP_BASE_DOMAIN: 'localhost', PUBLIC_SCHEME: 'http' }), /localhost/);
  const local = parseEnvironment({ ...base, APP_BASE_DOMAIN: 'localhost', PUBLIC_SCHEME: 'http', PUBLIC_PORT: '8080', APP_HOST: 'login.crm.localhost', PLATFORM_HOST: 'admin.crm.localhost', TENANT_HOSTS: 'crm.localhost=nova' });
  assert.equal(originFor(local, 'nova'), 'http://crm.localhost:8080');
});
