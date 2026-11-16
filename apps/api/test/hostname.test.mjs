import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveHost, RESERVED_SUBDOMAINS } from '../dist/tenancy/hostname.js';

const base = 'localhost';

test('company subdomain resolves to its slug; case and port are normalized', () => {
  assert.deepEqual(resolveHost('nova.localhost', base), { kind: 'tenant', slug: 'nova' });
  assert.deepEqual(resolveHost('NOVA.LocalHost:8080', base), { kind: 'tenant', slug: 'nova' });
  assert.deepEqual(resolveHost('company-b.localhost:3000', base), { kind: 'tenant', slug: 'company-b' });
});

test('admin and app are separate contexts, other reserved names are rejected', () => {
  assert.deepEqual(resolveHost('admin.localhost', base), { kind: 'platform' });
  assert.deepEqual(resolveHost('app.localhost:8080', base), { kind: 'app' });
  for (const name of RESERVED_SUBDOMAINS) {
    if (name === 'admin' || name === 'app') continue;
    assert.deepEqual(resolveHost(`${name}.localhost`, base), { kind: 'invalid' }, name);
  }
});

test('hosts outside one subdomain of the base domain are invalid', () => {
  const invalid = [
    undefined, '', 'localhost', 'localhost:8080', '.localhost', 'a.nova.localhost', 'nova.localhost.',
    'evil.com', 'nova.localhost.evil.com', 'novalocalhost', 'nova.localhost:80:80', 'nova.localhost:abc',
    '[::1]:8080', 'nova .localhost', ' nova.localhost', 'nova.localhost\t', '-nova.localhost', 'nova-.localhost',
    'no_va.localhost', 'növa.localhost', 'a'.repeat(64) + '.localhost', 'nova.localhost:123456',
  ];
  for (const host of invalid) assert.deepEqual(resolveHost(host, base), { kind: 'invalid' }, String(host));
});

test('punycode labels are plain DNS labels; production base domain works the same way', () => {
  assert.deepEqual(resolveHost('xn--nva-tna.localhost', base), { kind: 'tenant', slug: 'xn--nva-tna' });
  assert.deepEqual(resolveHost('nova.modulyn.app', 'modulyn.app'), { kind: 'tenant', slug: 'nova' });
  assert.deepEqual(resolveHost('nova.localhost', 'modulyn.app'), { kind: 'invalid' });
});
