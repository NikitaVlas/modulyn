// Unit-тесты auth (Phase 3) без базы данных: токены, cookies, пароли, guard, Origin.
import { test } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, {
  DATABASE_URL: 'postgresql://test:local@localhost:5432/test',
  JWT_SECRET_TENANT: 't'.repeat(40), JWT_SECRET_APP: 'a'.repeat(40), JWT_SECRET_PLATFORM: 'p'.repeat(40), PLATFORM_TOTP_KEY: 'ab'.repeat(32),
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

function guardWith({ meta = {}, principal = null, enabled = [] }) {
  const reflector = { getAllAndOverride: key => meta[key] };
  const sessions = {
    authenticateTenant: async () => principal, authenticateApp: async () => principal, authenticatePlatform: async () => principal,
  };
  const guard = new AuthGuard(reflector, sessions, { isEnabled: async (_tenantId, key) => enabled.includes(key) });
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

// ───────────── Phase 4: TOTP, шифрование, временные пароли, ограничения сессии ─────────────
const totp = await import('../dist/auth/totp.js');
const { temporaryPassword } = await import('../dist/auth/password.service.js');

test('TOTP matches the RFC 6238 reference vector and rejects replays', () => {
  const secret = Buffer.from('12345678901234567890'); // RFC 6238, приложение B, SHA1
  assert.equal(totp.totpCode(secret, Math.floor(59 / 30)), '287082');          // 94287082 → 6 цифр
  assert.equal(totp.totpCode(secret, Math.floor(1111111109 / 30)), '081804');  // 07081804
  const now = 1111111109 * 1000;
  const step = totp.verifyTotp(secret, '081804', null, now);
  assert.equal(step, Math.floor(1111111109 / 30));
  assert.equal(totp.verifyTotp(secret, '081804', step, now), null, 'same step cannot be used twice');
  assert.equal(totp.verifyTotp(secret, '000000', null, now), null);
  assert.equal(totp.verifyTotp(secret, '12345', null, now), null);
  // Соседний шаг (часы телефона отстают на 30 с) принимается, через два шага — нет.
  assert.notEqual(totp.verifyTotp(secret, totp.totpCode(secret, step - 1), null, now), null);
  assert.equal(totp.verifyTotp(secret, totp.totpCode(secret, step - 2), null, now), null);
});

test('base32 round-trips and otpauth URI carries issuer and account', () => {
  const secret = totp.newTotpSecret();
  assert.equal(secret.length, 20);
  assert.deepEqual(totp.base32Decode(totp.base32Encode(secret)), secret);
  const uri = new URL(totp.otpauthUri(secret, 'me@example.com'));
  assert.equal(uri.protocol, 'otpauth:');
  assert.equal(uri.searchParams.get('issuer'), 'Modulyn');
  assert.equal(uri.searchParams.get('secret'), totp.base32Encode(secret));
});

test('TOTP secrets are sealed with AES-256-GCM; another key or tampering fails', () => {
  const key = Buffer.alloc(32, 7);
  const secret = totp.newTotpSecret();
  const sealed = totp.sealSecret(key, secret);
  assert.ok(!sealed.includes(totp.base32Encode(secret)));
  assert.notEqual(totp.sealSecret(key, secret), sealed, 'random IV');
  assert.deepEqual(totp.openSecret(key, sealed), secret);
  assert.throws(() => totp.openSecret(Buffer.alloc(32, 8), sealed));
  const raw = Buffer.from(sealed, 'base64'); raw[raw.length - 1] ^= 1;
  assert.throws(() => totp.openSecret(key, raw.toString('base64')));
});

test('recovery codes and temporary passwords are random and readable', () => {
  const codes = totp.newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.match(c, /^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  assert.equal(totp.normalizeRecoveryCode(' abcde-fghij '), 'ABCDEFGHIJ');
  const p = temporaryPassword();
  assert.match(p, /^[a-km-np-z2-9A]{20}$/);
  assert.notEqual(p, temporaryPassword());
});

test('guard: a restricted session reaches only routes that allow its restriction', async () => {
  const restricted = { adminId: 'a', sessionId: 's', restricted: 'mfa-setup' };
  const platform = () => ({ kind: 'platform', host: 'admin.localhost:8080' });
  await assert.rejects(guardWith({ principal: restricted })(platform()),
    e => e.getStatus() === 403 && e.getResponse().code === 'MFA_SETUP_REQUIRED');
  assert.equal(await guardWith({ meta: { 'modulyn:allow-restricted': ['mfa-setup'] }, principal: restricted })(platform()), true);
  const temp = { userId: 'u', sessionId: 's', restricted: 'password-change' };
  await assert.rejects(guardWith({ meta: { 'modulyn:allow-restricted': ['mfa-setup'] }, principal: temp })({ kind: 'app', host: 'app.localhost:8080' }),
    e => e.getResponse().code === 'PASSWORD_CHANGE_REQUIRED');
});

// ───────────── Phase 5: письма ─────────────
const { invitationMail, passwordResetMail } = await import('../dist/mail/templates.js');

test('mail templates escape names and carry only the link', () => {
  const m = invitationMail({ to: 'a@b.example', companyName: 'Nova <script>', inviterName: 'Anna "A"', link: 'http://app.localhost:8080/invite#tok' });
  assert.equal(m.subject, 'Приглашение в Nova <script>');
  assert.doesNotMatch(m.html, /<script>/);
  assert.match(m.html, /Nova &#60;script&#62;/);
  assert.match(m.text, /Anna "A" приглашает вас в Nova <script>\./);
  assert.match(m.text, /invite#tok/);
  const r = passwordResetMail({ to: 'a@b.example', link: 'http://app.localhost:8080/reset-password#t' });
  assert.match(r.text, /1 час/);
  assert.match(r.html, /reset-password#t/);
});

// ───────────── Phase 6: модули ─────────────
test('guard: a module route needs the module enabled for the company; core routes do not', async () => {
  const tenantCtx = () => ({ kind: 'tenant', tenant: nova, host: 'nova.localhost:8080' });
  const manager = { userId: 'u', sessionId: 's', role: 'MANAGER' };
  await assert.rejects(guardWith({ meta: { 'modulyn:module': 'leads' }, principal: manager })(tenantCtx()),
    e => e.getStatus() === 403 && e.getResponse().code === 'MODULE_DISABLED');
  assert.equal(await guardWith({ meta: { 'modulyn:module': 'leads' }, principal: manager, enabled: ['leads'] })(tenantCtx()), true);
  assert.equal(await guardWith({ principal: manager })(tenantCtx()), true, 'no module on the route — always available');
  await assert.rejects(guardWith({ meta: { 'modulyn:module': 'leads' } })(tenantCtx()), e => e.getStatus() === 401, 'login is checked before the module');
});
