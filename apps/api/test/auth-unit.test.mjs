// Unit-тесты auth (Phase 3) без базы данных: токены, cookies, пароли, guard, Origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  DATABASE_URL: 'postgresql://test:local@localhost:5432/test',
  JWT_SECRET_TENANT: 't'.repeat(40), JWT_SECRET_APP: 'a'.repeat(40), JWT_SECRET_PLATFORM: 'p'.repeat(40),
  APP_BASE_DOMAIN: 'localhost', PUBLIC_PORT: '8080', NODE_ENV: 'test',
});

const { TokensService } = await import('../dist/auth/tokens.service.js');
const { parseCookies, cookieName } = await import('../dist/auth/cookies.js');
const { PasswordService, passwordPolicyError } = await import('../dist/auth/password.service.js');
const { AuthGuard } = await import('../dist/auth/auth.guard.js');
const { OriginMiddleware } = await import('../dist/auth/origin.middleware.js');
const { runWithRequestContext } = await import('../dist/tenancy/request-context.js');

const tokens = new TokensService();
const nova = { tenantId: '0195f0a0-0000-7000-8000-000000000001', slug: 'nova', displayName: 'Nova CRM' };

test('an access token is accepted only by the context it was issued for', async () => {
  const token = await tokens.signAccess('tenant', { sub: 'u1', sid: 's1', tid: nova.tenantId });
  assert.deepEqual(await tokens.verifyAccess('tenant', token), { sub: 'u1', sid: 's1', tid: nova.tenantId });
  assert.equal(await tokens.verifyAccess('app', token), null);
  assert.equal(await tokens.verifyAccess('platform', token), null);
  const app = await tokens.signAccess('app', { sub: 'u1', sid: 's1' });
  assert.equal(await tokens.verifyAccess('tenant', app), null, 'app token has no tid and another key');
});

test('tampered, foreign-key and alg=none tokens are rejected', async () => {
  const token = await tokens.signAccess('app', { sub: 'u1', sid: 's1' });
  const [h, p, s] = token.split('.');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  const forged = Buffer.from(JSON.stringify({ ...payload, sub: 'admin' })).toString('base64url');
  assert.equal(await tokens.verifyAccess('app', `${h}.${forged}.${s}`), null);
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.equal(await tokens.verifyAccess('app', `${none}.${p}.`), null);
  assert.equal(await tokens.verifyAccess('app', 'garbage'), null);
  assert.equal(await tokens.verifyAccess('app', undefined), null);
});

test('refresh tokens are random and stored only as a hash', () => {
  const a = tokens.randomToken();
  assert.notEqual(a, tokens.randomToken());
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.match(tokens.hash(a), /^[0-9a-f]{64}$/);
  assert.notEqual(tokens.hash(a), a);
});

test('cookie names get the __Host- prefix only with https; parser takes the first value', () => {
  assert.equal(cookieName('access', true), '__Host-mdl_at');
  assert.equal(cookieName('access', false), 'mdl_at');
  const parsed = parseCookies('mdl_at=one; other=x; mdl_at=two; broken=%E0%A4%A');
  assert.equal(parsed.get('mdl_at'), 'one');
  assert.equal(parsed.has('broken'), false);
});

test('Argon2id hashes verify; a missing account costs the same work and fails', async () => {
  const passwords = new PasswordService();
  const hash = await passwords.hash('correct horse battery');
  assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  assert.equal(await passwords.verify(hash, 'correct horse battery'), true);
  assert.equal(await passwords.verify(hash, 'wrong'), false);
  assert.equal(await passwords.verify('not-a-hash', 'x'), false);
  assert.equal(await passwords.verifyDummy('anything'), false);
});

test('password policy: length only, no composition rules', () => {
  assert.notEqual(passwordPolicyError('short'), null);
  assert.equal(passwordPolicyError('twelve chars'), null);
  assert.notEqual(passwordPolicyError('x'.repeat(129)), null);
  assert.notEqual(passwordPolicyError(' '.repeat(20)), null);
});

function guardWith({ meta = {}, principal = null }) {
  const reflector = { getAllAndOverride: key => meta[key] };
  const sessions = {
    authenticateTenant: async () => principal, authenticateApp: async () => principal, authenticatePlatform: async () => principal,
  };
  const guard = new AuthGuard(reflector, sessions);
  const execution = { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) };
  return context => runWithRequestContext(context, () => guard.canActivate(execution));
}

test('guard: routes are closed by default, wrong host type is 404, missing role is 403', async () => {
  const tenantCtx = () => ({ kind: 'tenant', tenant: nova, host: 'nova.localhost:8080' });
  await assert.rejects(guardWith({})(tenantCtx()), e => e.getStatus() === 401);
  await assert.rejects(guardWith({ meta: { 'modulyn:contexts': ['app'] } })(tenantCtx()), e => e.getStatus() === 404);
  assert.equal(await guardWith({ meta: { 'modulyn:public': true } })(tenantCtx()), true);
  const manager = { userId: 'u', sessionId: 's', role: 'MANAGER' };
  await assert.rejects(guardWith({ meta: { 'modulyn:roles': ['TENANT_ADMIN'] }, principal: manager })(tenantCtx()), e => e.getStatus() === 403);
  const ctx = tenantCtx();
  assert.equal(await guardWith({ meta: { 'modulyn:roles': ['MANAGER'] }, principal: manager })(ctx), true);
  assert.deepEqual(ctx.principal, manager);
  // Роль компании на хосте платформы не имеет смысла: отказ, а не пропуск.
  await assert.rejects(guardWith({ meta: { 'modulyn:roles': ['TENANT_ADMIN'] }, principal: { adminId: 'a', sessionId: 's' } })({ kind: 'platform', host: 'admin.localhost:8080' }), e => e.getStatus() === 403);
});

function originCheck(context, { method = 'POST', path = '/api/auth/login', origin, type = 'application/json' }) {
  const middleware = new OriginMiddleware();
  let status = 200; let passed = false;
  const res = { status(code) { status = code; return this; }, json() { return this; } };
  const req = { method, path, headers: { ...(origin ? { origin } : {}), ...(type ? { 'content-type': type } : {}) } };
  runWithRequestContext(context, () => middleware.handle(req, res, () => { passed = true; }));
  return passed ? 200 : status;
}

test('CSRF: unsafe requests need the exact own Origin and JSON; handoff accepts only the app origin form', () => {
  const app = { kind: 'app', host: 'app.localhost:8080' };
  const tenant = { kind: 'tenant', tenant: nova, host: 'nova.localhost:8080' };
  assert.equal(originCheck(app, { origin: 'http://app.localhost:8080' }), 200);
  assert.equal(originCheck(app, { origin: 'http://app.localhost:8080', type: 'application/json; charset=utf-8' }), 200);
  assert.equal(originCheck(app, {}), 403, 'no Origin');
  assert.equal(originCheck(app, { origin: 'null' }), 403);
  assert.equal(originCheck(app, { origin: 'http://nova.localhost:8080' }), 403, 'sibling subdomain');
  assert.equal(originCheck(app, { origin: 'http://app.localhost:8080', type: 'text/plain' }), 403);
  assert.equal(originCheck(app, { method: 'GET' }), 200);
  const handoff = { path: '/api/auth/handoff/complete', type: 'application/x-www-form-urlencoded' };
  assert.equal(originCheck(tenant, { ...handoff, origin: 'http://app.localhost:8080' }), 200);
  assert.equal(originCheck(tenant, { ...handoff, origin: 'http://evil.localhost:8080' }), 403);
  assert.equal(originCheck(tenant, { ...handoff, origin: 'http://nova.localhost:8080', path: '/api/auth/logout' }), 403);
  const finish = { path: '/api/auth/handoff/finish', type: 'application/x-www-form-urlencoded' };
  assert.equal(originCheck(tenant, { ...finish, origin: 'http://nova.localhost:8080' }), 200);
  assert.equal(originCheck(tenant, { ...finish, origin: 'http://app.localhost:8080' }), 403, 'second step only from its own origin');
});
