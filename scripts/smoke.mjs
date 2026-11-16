import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
const origin = new URL(process.env.SMOKE_ORIGIN ?? 'http://nova.localhost:8080');
if (origin.protocol !== 'http:' || !(origin.hostname === 'localhost' || origin.hostname === '127.0.0.1' || origin.hostname.endsWith('.localhost'))) {
  throw new Error('Smoke checks target local HTTP environments only');
}
// Preserve Host while connecting directly to loopback: Windows DNS need not resolve *.localhost.
function request(path, host = origin.host) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: origin.port || 80, path, headers: { Host: host }, timeout: 10000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('timeout', () => req.destroy(new Error('HTTP smoke request timed out')));
    req.on('error', reject);
    req.end();
  });
}
const page = await request('/');
assert.equal(page.status, 200);
assert.match(page.body, /MODULYN/);
const live = await request('/api/health');
assert.equal(live.status, 200);
assert.deepEqual(JSON.parse(live.body), { status: 'ok', service: 'modulyn-api' });
assert.equal(live.headers['x-content-type-options'], 'nosniff');
const ready = await request('/api/health/ready');
assert.equal(ready.status, 200);
assert.deepEqual(JSON.parse(ready.body), { status: 'ready', database: 'up' });
const missing = await request('/api/does-not-exist');
assert.equal(missing.status, 404);
for (const host of ['nova.localhost', 'company-b.localhost', 'admin.localhost']) {
  assert.equal((await request('/', host + ':' + (origin.port || 80))).status, 200);
}
console.log('PASS: page, liveness, PostgreSQL readiness, security header, API 404, three local hostnames');
