// Интеграционные тесты Phase 5 (5.2–5.7): приглашения, участники, роли, восстановление пароля, почта.
// Реальный PostgreSQL под modulyn_app; почта — SMTP_URL=memory: (письма в outbox); Google — локальный поддельный провайдер.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomInt } from 'node:crypto';
import pg from 'pg';
import { prepareTestDatabase } from './setup.mjs';
import { SEED_PASSWORD } from '../../scripts/seed.mjs';
import { Browser, mailToken } from './browser.mjs';
import { startFakeGoogle } from './fake-google.mjs';

let env; let app; let port; let tenants; let users; let outbox; let provider;

before(async () => {
  provider = await startFakeGoogle();
  env = await prepareTestDatabase();
  ({ tenants, users } = env.seeded);
  Object.assign(process.env, {
    DATABASE_URL: env.appUrl, APP_BASE_DOMAIN: 'localhost', NODE_ENV: 'test', PUBLIC_PORT: '8080', PUBLIC_SCHEME: 'http', TRUST_PROXY: 'true',
    SMTP_URL: 'memory:', GOOGLE_CLIENT_ID: 'fake-client', GOOGLE_CLIENT_SECRET: 'fake-secret', GOOGLE_ISSUER: provider.issuer,
  });
  const { createApplication } = await import('../../dist/bootstrap.js');
  const { MailService } = await import('../../dist/mail/mail.service.js');
  app = await createApplication();
  app.useLogger(false);
  await app.listen(0, '127.0.0.1');
  port = app.getHttpServer().address().port;
  outbox = app.get(MailService).outbox;
});

after(async () => {
  await app?.close();
  await env?.ownerPrisma.$disconnect();
  provider?.server.close();
});

const browser = () => new Browser(port);
const sha = t => createHash('sha256').update(t).digest('hex');

async function sql(url, query, params = [], settings = {}) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    for (const [k, v] of Object.entries(settings)) await c.query('SELECT set_config($1, $2, true)', [k, v]);
    const r = await c.query(query, params);
    await c.query('COMMIT');
    return r;
  } finally { await c.end(); }
}
const owner = (q, p, tenantId) => sql(env.ownerUrl, q, p, tenantId ? { 'app.tenant_id': tenantId } : {});

/** Вошедший пользователь компании: app → переход в компанию. */
async function member(email, slug, password = SEED_PASSWORD) {
  const b = browser();
  assert.equal((await b.post('app', '/api/auth/login', { email, password })).status, 200, email);
  if (slug) assert.equal((await b.enter(slug)).headers.location, '/');
  return b;
}

const NOVA_ADMIN = 'admin@nova.example';

// ───────────── 5.7 почта + 5.2 приглашения ─────────────

describe('5.2 / 5.7 invitations by e-mail', () => {
  let admin;
  before(async () => { admin = await member(NOVA_ADMIN, 'nova'); });

  test('the answer is the same for a new and an existing account; the e-mail carries a one-time link', async () => {
    const fresh = await admin.post('nova', '/api/members/invitations', { email: 'New.Person@nova-team.example', name: 'New Person', role: 'MANAGER' });
    const existing = await admin.post('nova', '/api/members/invitations', { email: 'admin@company-b.example', name: 'B Admin', role: 'MANAGER' });
    assert.deepEqual([fresh.status, fresh.body], [201, '{"invitationSent":true}']);
    assert.deepEqual([existing.status, existing.body], [fresh.status, fresh.body], 'no hint whether an account exists');

    const mail = outbox.find(m => m.to === 'new.person@nova-team.example');
    assert.equal(mail.subject, 'Приглашение в Nova CRM');
    assert.match(mail.text, /Nova Admin приглашает вас в Nova CRM/);
    assert.match(mail.text, /http:\/\/app\.localhost:8080\/invite#[A-Za-z0-9_-]{43}/);
    assert.match(mail.html, /Принять приглашение/);

    const list = await admin.get('nova', '/api/members');
    assert.deepEqual(list.json.invitations.map(i => i.email).sort(), ['admin@company-b.example', 'new.person@nova-team.example']);
    assert.doesNotMatch(list.body, /token|hash|password|session/i, 'no secrets in the list');
    assert.deepEqual(list.json.members.find(m => m.email === NOVA_ADMIN), {
      userId: users[NOVA_ADMIN].id, name: 'Nova Admin', email: NOVA_ADMIN, role: 'TENANT_ADMIN', isActive: true, isSelf: true,
    });
    const { rows } = await owner('SELECT token_hash FROM invitations', [], tenants.nova.id);
    const token = mailToken(outbox, 'new.person@nova-team.example');
    assert.ok(rows.some(r => r.token_hash === sha(token)) && !rows.some(r => r.token_hash === token), 'only the hash is stored');
  });

  test('validation and an already active member', async () => {
    assert.equal((await admin.post('nova', '/api/members/invitations', { email: 'bad', name: 'x', role: 'MANAGER' })).status, 400);
    assert.equal((await admin.post('nova', '/api/members/invitations', { email: 'ok@x.example', name: '', role: 'MANAGER' })).status, 400);
    assert.equal((await admin.post('nova', '/api/members/invitations', { email: 'ok@x.example', name: 'x', role: 'OWNER' })).status, 400);
    const dup = await admin.post('nova', '/api/members/invitations', { email: 'manager@shared.example', name: 'x', role: 'MANAGER' });
    assert.deepEqual([dup.status, dup.json.message], [409, 'Этот человек уже работает в компании']);
  });

  test('a new person sets a password and enters the company with the invited role', async () => {
    const token = mailToken(outbox, 'new.person@nova-team.example');
    const b = browser();
    const info = await b.post('app', '/api/invitations/inspect', { token });
    assert.deepEqual(info.json, {
      companyName: 'Nova CRM', email: 'new.person@nova-team.example', name: 'New Person', role: 'MANAGER',
      status: 'open', accountExists: false, signedInAs: null, google: true,
    });
    assert.equal((await b.post('app', '/api/invitations/accept', { token, password: 'short' })).status, 400);
    const ok = await b.post('app', '/api/invitations/accept', { token, name: 'Новый Человек', password: 'new person passphrase' });
    assert.deepEqual([ok.status, ok.json], [200, { tenantSlug: 'nova' }]);
    assert.equal((await b.enter('nova')).headers.location, '/');
    const me = await b.get('nova', '/api/auth/me');
    assert.deepEqual([me.json.user.name, me.json.role], ['Новый Человек', 'MANAGER']);
    assert.equal((await b.post('app', '/api/invitations/accept', { token, password: 'new person passphrase' })).status, 400, 'one-time link');
    assert.equal((await browser().post('app', '/api/auth/login', { email: 'new.person@nova-team.example', password: 'new person passphrase' })).status, 200);
    assert.ok(!(await admin.get('nova', '/api/members')).json.invitations.some(i => i.email === 'new.person@nova-team.example'));
  });

  test('an existing account must sign in with the invited e-mail to accept', async () => {
    const token = mailToken(outbox, 'admin@company-b.example');
    assert.equal((await browser().post('app', '/api/invitations/accept', { token, password: 'whatever passphrase' })).status, 409);
    const wrong = await member('manager@shared.example');
    const denied = await wrong.post('app', '/api/invitations/accept', { token });
    assert.equal(denied.status, 403, 'another signed-in account cannot take the invitation');
    const right = await member('admin@company-b.example');
    assert.equal((await right.post('app', '/api/invitations/inspect', { token })).json.accountExists, true);
    assert.equal((await right.post('app', '/api/invitations/accept', { token })).json.tenantSlug, 'nova');
    const companies = (await right.get('app', '/api/auth/me')).json.companies.map(c => [c.slug, c.role]);
    assert.deepEqual(companies, [['company-b', 'TENANT_ADMIN'], ['nova', 'MANAGER']]);
  });

  test('resend replaces the link, revoke and expiry kill it', async () => {
    await admin.post('nova', '/api/members/invitations', { email: 'later@nova-team.example', name: 'Later', role: 'MANAGER' });
    const first = mailToken(outbox, 'later@nova-team.example');
    const id = (await admin.get('nova', '/api/members')).json.invitations.find(i => i.email === 'later@nova-team.example').id;
    assert.equal((await admin.post('nova', `/api/members/invitations/${id}/resend`)).json.invitationSent, true);
    const second = mailToken(outbox, 'later@nova-team.example');
    assert.notEqual(second, first);
    assert.equal((await browser().post('app', '/api/invitations/inspect', { token: first })).status, 404, 'old link is gone');
    assert.equal((await browser().post('app', '/api/invitations/inspect', { token: second })).json.status, 'open');

    await owner("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE id = $1", [id], tenants.nova.id);
    assert.equal((await browser().post('app', '/api/invitations/inspect', { token: second })).json.status, 'used');
    assert.equal((await browser().post('app', '/api/invitations/accept', { token: second, password: 'later passphrase' })).status, 400);
    assert.equal((await admin.get('nova', '/api/members')).json.invitations.find(i => i.id === id).expired, true);

    assert.equal((await admin.post('nova', `/api/members/invitations/${id}/revoke`)).status, 204);
    assert.equal((await browser().post('app', '/api/invitations/inspect', { token: second })).json.status, 'used');
    assert.equal((await admin.post('nova', `/api/members/invitations/${id}/revoke`)).status, 404);
  });

  test('a new invitation to the same e-mail replaces the open one; 50 per day per company', async () => {
    const b = await member('admin@company-b.example', 'company-b');
    await b.post('company-b', '/api/members/invitations', { email: 'twice@b.example', name: 'Twice', role: 'MANAGER' });
    const first = mailToken(outbox, 'twice@b.example');
    await b.post('company-b', '/api/members/invitations', { email: 'twice@b.example', name: 'Twice', role: 'TENANT_ADMIN' });
    assert.equal((await browser().post('app', '/api/invitations/inspect', { token: first })).json.status, 'used');
    assert.equal((await b.get('company-b', '/api/members')).json.invitations.filter(i => i.email === 'twice@b.example').length, 1);

    for (let i = 0; i < 48; i++) {
      await owner("INSERT INTO invitations (id, tenant_id, email, name, role, token_hash, expires_at, revoked_at) VALUES (gen_random_uuid(), $1, $2, 'x', 'MANAGER', $3, now() + interval '1 day', now())",
        [tenants['company-b'].id, `bulk${i}@b.example`, `bulk-${i}-${randomInt(1e9)}`], tenants['company-b'].id);
    }
    const limited = await b.post('company-b', '/api/members/invitations', { email: 'one-more@b.example', name: 'x', role: 'MANAGER' });
    assert.equal(limited.status, 429);
  });

  test('Google: a new person joins with a verified Google e-mail that matches the invitation', async () => {
    await admin.post('nova', '/api/members/invitations', { email: 'gnew@nova-team.example', name: 'G New', role: 'MANAGER' });
    const token = mailToken(outbox, 'gnew@nova-team.example');
    const viaGoogle = async (b, claims) => {
      const start = await b.post('app', '/api/invitations/google', { token });
      assert.equal(start.status, 200);
      const auth = new URL(start.json.url);
      const code = 'code-' + randomInt(1e9);
      provider.codes.set(code, { ...claims, nonce: auth.searchParams.get('nonce'), challenge: auth.searchParams.get('code_challenge') });
      return b.get('app', `/api/auth/google/callback?code=${code}&state=${encodeURIComponent(auth.searchParams.get('state'))}`);
    };
    const mismatch = await viaGoogle(browser(), { sub: 'g-other', email: 'someone.else@gmail.example', emailVerified: true });
    assert.equal(mismatch.headers.location, 'http://app.localhost:8080/invite?error=google');
    const unverified = await viaGoogle(browser(), { sub: 'g-unv', email: 'gnew@nova-team.example', emailVerified: false });
    assert.equal(unverified.headers.location, 'http://app.localhost:8080/invite?error=google');

    const b = browser();
    const ok = await viaGoogle(b, { sub: 'g-new-sub', email: 'gnew@nova-team.example', emailVerified: true });
    assert.equal(ok.headers.location, 'http://nova.localhost:8080/api/auth/handoff/start');
    assert.equal((await b.enter('nova')).headers.location, '/');
    assert.equal((await b.get('nova', '/api/auth/me')).json.user.email, 'gnew@nova-team.example');
    const { rows } = await owner("SELECT u.password_hash IS NULL AS no_password, i.provider_subject FROM users u JOIN user_identities i ON i.user_id = u.id WHERE u.email = 'gnew@nova-team.example'");
    assert.deepEqual(rows, [{ no_password: true, provider_subject: 'g-new-sub' }]);
  });

  test('RLS: without context no invitations; with a token hash exactly one row', async () => {
    await admin.post('nova', '/api/members/invitations', { email: 'rls@nova-team.example', name: 'RLS', role: 'MANAGER' });
    const token = mailToken(outbox, 'rls@nova-team.example');
    assert.equal((await sql(env.appUrl, 'SELECT count(*)::int AS n FROM invitations')).rows[0].n, 0);
    const byToken = await sql(env.appUrl, 'SELECT email FROM invitations', [], { 'app.invite_token_hash': sha(token) });
    assert.deepEqual(byToken.rows, [{ email: 'rls@nova-team.example' }]);
    const leads = await sql(env.appUrl, 'SELECT count(*)::int AS n FROM leads', [], { 'app.invite_token_hash': sha(token) });
    assert.equal(leads.rows[0].n, 0, 'the token opens nothing else in the company');
    const wrongToken = await sql(env.appUrl, "UPDATE invitations SET role = 'TENANT_ADMIN'", [], { 'app.invite_token_hash': 'x' });
    assert.equal(wrongToken.rowCount, 0, 'a wrong token changes nothing');
  });
});

// ───────────── 5.3 роли и отключение ─────────────

describe('5.3 roles and access', () => {
  test('role change and disabling apply at once and only in this company', async () => {
    const admin = await member(NOVA_ADMIN, 'nova');
    const manager = await member('manager@shared.example', 'nova');
    assert.equal((await manager.enter('company-b')).headers.location, '/');
    const managerId = users['manager@shared.example'].id;

    const promoted = await admin.patch('nova', `/api/members/${managerId}`, { role: 'TENANT_ADMIN' });
    assert.deepEqual([promoted.status, promoted.json.role], [200, 'TENANT_ADMIN']);
    assert.equal((await manager.get('nova', '/api/auth/me')).json.role, 'TENANT_ADMIN', 'role is read from the database on every request');
    assert.equal((await manager.get('nova', '/api/members')).status, 200);
    await admin.patch('nova', `/api/members/${managerId}`, { role: 'MANAGER' });
    assert.equal((await manager.get('nova', '/api/members')).status, 403);

    assert.equal((await admin.patch('nova', `/api/members/${managerId}`, { isActive: false })).json.isActive, false);
    assert.equal((await manager.get('nova', '/api/auth/me')).status, 401, 'company session revoked');
    assert.equal((await manager.get('company-b', '/api/auth/me')).status, 200, 'other company untouched');
    assert.equal((await manager.get('app', '/api/auth/me')).status, 200, 'account untouched');
    assert.equal((await admin.patch('nova', `/api/members/${managerId}`, { isActive: true })).json.isActive, true);
    assert.equal((await manager.get('nova', '/api/auth/me')).status, 401, 'sign in again after re-enabling');
    assert.equal((await manager.enter('nova')).headers.location, '/');

    const { rows } = await owner("SELECT action, metadata FROM tenant_audit_logs WHERE action LIKE 'membership.%'", [], tenants.nova.id);
    const actions = rows.map(r => r.action);
    for (const a of ['membership.role_changed', 'membership.disabled', 'membership.enabled']) assert.ok(actions.includes(a), a);
    assert.ok(rows.every(r => !JSON.stringify(r.metadata ?? {}).includes('@')));
  });

  test('nobody changes themselves; two admins demoting each other leave at least one admin', async () => {
    const a = await member('admin@company-b.example', 'company-b');
    const self = await a.patch('company-b', `/api/members/${users['admin@company-b.example'].id}`, { isActive: false });
    assert.deepEqual([self.status, self.json.message], [400, 'Свою роль и доступ может изменить только другой администратор']);

    const managerId = users['manager@shared.example'].id;
    await a.patch('company-b', `/api/members/${managerId}`, { role: 'TENANT_ADMIN' });
    const b = await member('manager@shared.example', 'company-b');
    const [x, y] = await Promise.all([
      a.patch('company-b', `/api/members/${managerId}`, { role: 'MANAGER' }),
      b.patch('company-b', `/api/members/${users['admin@company-b.example'].id}`, { role: 'MANAGER' }),
    ]);
    assert.equal([x, y].filter(r => r.status === 200).length, 1, `exactly one demotion wins: ${x.status}/${y.status}`);
    const { rows } = await owner("SELECT count(*)::int AS n FROM memberships WHERE role = 'TENANT_ADMIN' AND is_active", [], tenants['company-b'].id);
    assert.ok(rows[0].n >= 1);
  });

  test('unknown member, bad payload', async () => {
    const admin = await member(NOVA_ADMIN, 'nova');
    assert.equal((await admin.patch('nova', '/api/members/00000000-0000-7000-8000-000000000000', { role: 'MANAGER' })).status, 404);
    assert.equal((await admin.patch('nova', `/api/members/${users['manager@shared.example'].id}`, { role: 'OWNER' })).status, 400);
    assert.equal((await admin.patch('nova', `/api/members/${users['manager@shared.example'].id}`, { email: 'x@y.example' })).status, 400);
  });
});

// ───────────── 5.5 права и изоляция ─────────────

describe('5.5 permissions and isolation', () => {
  test('managers and other companies cannot manage members', async () => {
    const manager = await member('manager@shared.example', 'nova');
    assert.equal((await manager.get('nova', '/api/members')).status, 403);
    assert.equal((await manager.post('nova', '/api/members/invitations', { email: 'x@y.example', name: 'x', role: 'MANAGER' })).status, 403);
    assert.equal((await manager.patch('nova', `/api/members/${users[NOVA_ADMIN].id}`, { isActive: false })).status, 403);

    const bAdmin = await member('admin@company-b.example', 'company-b');
    const cookies = bAdmin.cookieHeader('company-b.localhost:8080');
    assert.equal((await browser().get('nova', '/api/members', { headers: { Cookie: cookies } })).status, 401);
    const bList = await bAdmin.get('company-b', '/api/members');
    assert.ok(!bList.json.members.some(m => m.email === NOVA_ADMIN), 'nova admin is not visible in company-b');
    assert.equal((await bAdmin.patch('company-b', `/api/members/${users[NOVA_ADMIN].id}`, { isActive: false })).status, 404, 'a member of another company is not found');
    assert.equal((await browser().get('app', '/api/members')).status, 404, 'no members API on app');
    assert.equal((await browser().get('admin', '/api/members')).status, 404, 'no members API on the platform');
  });
});

// ───────────── 5.6 восстановление пароля ─────────────

describe('5.6 password reset by e-mail', () => {
  test('same answer for any e-mail; link works once for an hour; all sessions end', async () => {
    const before = await member('admin@suspended.example');
    const known = await browser().post('app', '/api/auth/password-reset/request', { email: 'Admin@Suspended.example' });
    const unknown = await browser().post('app', '/api/auth/password-reset/request', { email: 'nobody@nowhere.example' });
    assert.deepEqual([known.status, known.body], [202, '{"ok":true}']);
    assert.deepEqual([unknown.status, unknown.body], [known.status, known.body]);
    await new Promise(r => setTimeout(r, 300)); // письмо отправляется в фоне
    assert.ok(!outbox.some(m => m.to === 'nobody@nowhere.example'));
    const token = mailToken(outbox, 'admin@suspended.example', 'reset-password');
    assert.ok(token);
    assert.match(outbox.find(m => m.to === 'admin@suspended.example').subject, /Восстановление пароля/);

    assert.equal((await browser().post('app', '/api/auth/password-reset/confirm', { token, newPassword: 'short' })).status, 400);
    assert.equal((await browser().post('app', '/api/auth/password-reset/confirm', { token, newPassword: 'reset passphrase 2026' })).status, 204);
    assert.equal((await before.get('app', '/api/auth/me')).status, 401, 'existing sessions ended');
    assert.equal((await browser().post('app', '/api/auth/login', { email: 'admin@suspended.example', password: SEED_PASSWORD })).status, 401);
    assert.equal((await browser().post('app', '/api/auth/login', { email: 'admin@suspended.example', password: 'reset passphrase 2026' })).status, 200);
    assert.equal((await browser().post('app', '/api/auth/password-reset/confirm', { token, newPassword: 'another passphrase 1' })).status, 400, 'one-time');
  });

  test('expired link, mail limit per address, no reset on the platform', async () => {
    const request = () => browser().post('app', '/api/auth/password-reset/request', { email: 'admin@nova.example' });
    await request();
    await new Promise(r => setTimeout(r, 300));
    const token = mailToken(outbox, 'admin@nova.example', 'reset-password');
    await owner('UPDATE password_resets SET expires_at = now() - interval \'1 second\' WHERE token_hash = $1', [sha(token)]);
    assert.equal((await browser().post('app', '/api/auth/password-reset/confirm', { token, newPassword: 'expired passphrase' })).status, 400);

    const count = () => outbox.filter(m => m.to === 'admin@nova.example' && /reset-password/.test(m.text)).length;
    await request(); await request(); await request();
    await new Promise(r => setTimeout(r, 300));
    assert.equal(count(), 3, 'no more than 3 e-mails per hour per address');
    assert.equal((await browser().post('admin', '/api/auth/password-reset/request', { email: 'platform@modulyn.example' })).status, 404);
    assert.equal((await browser().post('nova', '/api/auth/password-reset/request', { email: 'admin@nova.example' })).status, 404);
  });
});
