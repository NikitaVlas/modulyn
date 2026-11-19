// Интеграционные тесты Phase 4 (4.1–4.5): реальный PostgreSQL, роль modulyn_app, команда platform-admin под владельцем схемы.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { prepareTestDatabase } from './setup.mjs';
import { SEED_PASSWORD } from '../../scripts/seed.mjs';
import { Browser, mailToken } from './browser.mjs';

const apiRoot = fileURLToPath(new URL('../../', import.meta.url));
let env; let app; let port; let tenants; let totp; let outbox;

before(async () => {
  env = await prepareTestDatabase();
  ({ tenants } = env.seeded);
  Object.assign(process.env, {
    DATABASE_URL: env.appUrl, APP_BASE_DOMAIN: 'localhost', NODE_ENV: 'test', PUBLIC_PORT: '8080', PUBLIC_SCHEME: 'http', TRUST_PROXY: 'true',
    SMTP_URL: 'memory:',
  });
  totp = await import('../../dist/auth/totp.js');
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
});

const browser = () => new Browser(port);

async function sql(url, query, params, tenantId) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    if (!tenantId) return await c.query(query, params);
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await c.query(query, params);
    await c.query('COMMIT');
    return result;
  } finally { await c.end(); }
}
const owner = (q, p, t) => sql(env.ownerUrl, q, p, t);

/** Команда сервера (B1, B9). Возвращает код выхода, вывод и временный пароль, если он напечатан. */
function cli(args, url = env.ownerUrl) {
  const r = spawnSync(process.execPath, ['scripts/platform-admin.mjs', ...args], {
    cwd: apiRoot, encoding: 'utf8', env: { ...process.env, MIGRATION_DATABASE_URL: url },
  });
  return { status: r.status, out: r.stdout, err: r.stderr, password: /Temporary password[^:]*: (\S+)/.exec(r.stdout)?.[1] };
}

/** Администратор после первого входа: смена временного пароля и настройка второго фактора. */
async function readyAdmin(email) {
  const created = cli(['create', '--email', email, '--name', 'Owner ' + email]);
  assert.equal(created.status, 0, created.err);
  const b = browser();
  assert.equal((await b.post('admin', '/api/auth/login', { email, password: created.password })).status, 200);
  const newPassword = 'platform owner passphrase';
  assert.equal((await b.post('admin', '/api/auth/password', { currentPassword: created.password, newPassword })).status, 204);
  const setup = await b.post('admin', '/api/auth/mfa/setup');
  const secret = totp.base32Decode(setup.json.secret);
  const enabled = await b.post('admin', '/api/auth/mfa/enable', { code: totp.totpCode(secret, totp.currentStep()) });
  assert.equal(enabled.status, 200);
  return { b, secret, password: newPassword, recoveryCodes: enabled.json.recoveryCodes };
}

// ───────────── 4.1 ─────────────

describe('4.1 first platform admin, temporary password and two-factor authentication', () => {
  test('only the server command run as schema owner creates administrators; the password is printed once', async () => {
    const r = cli(['create', '--email', 'Founder@Platform.example', '--name', 'Founder']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.password, /^[a-km-np-z2-9A]{20}$/);
    const { rows } = await owner("SELECT password_hash, password_change_required, temp_password_expires_at > now() + interval '6 days' AS week FROM platform_admins WHERE email = 'founder@platform.example'");
    assert.equal(rows.length, 1);
    assert.ok(rows[0].password_hash.startsWith('$argon2id$') && !rows[0].password_hash.includes(r.password));
    assert.deepEqual([rows[0].password_change_required, rows[0].week], [true, true]);
    assert.notEqual(cli(['create', '--email', 'founder@platform.example', '--name', 'Again']).status, 0, 'duplicate email');
    const asRuntime = cli(['create', '--email', 'intruder@platform.example', '--name', 'X'], env.appUrl);
    assert.notEqual(asRuntime.status, 0, 'the API runtime role cannot create administrators');
    assert.equal((await owner("SELECT count(*)::int AS n FROM platform_admins WHERE email = 'intruder@platform.example'")).rows[0].n, 0);
    assert.notEqual(cli(['create', '--email', 'nameless@platform.example']).status, 0, 'name is required');
  });

  test('a temporary password opens only password change, then only two-factor setup', async () => {
    const r = cli(['create', '--email', 'steps@platform.example', '--name', 'Steps']);
    const b = browser();
    assert.deepEqual((await b.post('admin', '/api/auth/login', { email: 'steps@platform.example', password: r.password })).json, { ok: true });
    assert.deepEqual((await b.get('admin', '/api/auth/me')).json, {
      admin: { name: 'Steps', email: 'steps@platform.example' }, passwordChangeRequired: true, mfaSetupRequired: true, locale: 'de',
    });
    const blocked = await b.get('admin', '/api/platform/tenants');
    assert.deepEqual([blocked.status, blocked.json.code], [403, 'PASSWORD_CHANGE_REQUIRED']);
    assert.equal((await b.post('admin', '/api/auth/mfa/setup')).json.code, 'PASSWORD_CHANGE_REQUIRED');

    assert.equal((await b.post('admin', '/api/auth/password', { currentPassword: r.password, newPassword: 'steps passphrase 2026' })).status, 204);
    const stillBlocked = await b.get('admin', '/api/platform/tenants');
    assert.deepEqual([stillBlocked.status, stillBlocked.json.code], [403, 'MFA_SETUP_REQUIRED']);

    const setup = await b.post('admin', '/api/auth/mfa/setup');
    assert.equal(setup.status, 200);
    assert.match(setup.json.otpauthUri, /^otpauth:\/\/totp\/Modulyn%3Asteps%40platform\.example\?/);
    const secret = totp.base32Decode(setup.json.secret);
    const { rows } = await owner("SELECT totp_secret_enc, totp_enabled_at FROM platform_admins WHERE email = 'steps@platform.example'");
    assert.ok(rows[0].totp_secret_enc && !rows[0].totp_secret_enc.includes(setup.json.secret), 'the secret is stored encrypted');
    assert.equal(rows[0].totp_enabled_at, null, 'not enabled before confirmation');

    assert.equal((await b.post('admin', '/api/auth/mfa/enable', { code: '000000' })).status, 400);
    const enabled = await b.post('admin', '/api/auth/mfa/enable', { code: totp.totpCode(secret, totp.currentStep()) });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.json.recoveryCodes.length, 10);
    const stored = await owner("SELECT code_hash FROM platform_recovery_codes c JOIN platform_admins a ON a.id = c.admin_id WHERE a.email = 'steps@platform.example'");
    assert.equal(stored.rows.length, 10);
    assert.ok(stored.rows.every(x => /^[0-9a-f]{64}$/.test(x.code_hash)), 'recovery codes stored as hashes');
    assert.equal((await b.get('admin', '/api/platform/tenants')).status, 200);
    assert.equal((await b.post('admin', '/api/auth/mfa/setup')).status, 409, 'cannot be replaced from the API once enabled');
  });

  test('sign-in with two-factor: code required, no replay, recovery codes work once', async () => {
    const { secret, password, recoveryCodes } = await readyAdmin('mfa@platform.example');
    const login = async () => { const b = browser(); return { b, r: await b.post('admin', '/api/auth/login', { email: 'mfa@platform.example', password }) }; };

    const first = await login();
    assert.deepEqual(first.r.json, { ok: true, mfaRequired: true });
    assert.ok(!first.b.jar('admin.localhost:8080').has('mdl_at'), 'no session before the second factor');
    assert.equal((await first.b.get('admin', '/api/auth/me')).status, 401);
    assert.equal((await first.b.post('admin', '/api/auth/mfa', { code: '123456' })).status, 401);
    const code = totp.totpCode(secret, totp.currentStep() + 1);
    assert.equal((await first.b.post('admin', '/api/auth/mfa', { code })).status, 200);
    assert.equal((await first.b.get('admin', '/api/platform/tenants')).status, 200);

    const replay = await login();
    assert.equal((await replay.b.post('admin', '/api/auth/mfa', { code })).status, 401, 'the same code cannot be used twice');

    const recovery = await login();
    assert.equal((await recovery.b.post('admin', '/api/auth/mfa', { code: recoveryCodes[0].toLowerCase() })).status, 200);
    const again = await login();
    assert.equal((await again.b.post('admin', '/api/auth/mfa', { code: recoveryCodes[0] })).status, 401, 'recovery code is single-use');

    assert.equal((await browser().post('admin', '/api/auth/mfa', { code })).status, 401, 'no password step — no second step');
    const { rows } = await owner("SELECT action FROM platform_audit_logs l JOIN platform_admins a ON a.id = l.actor_admin_id WHERE a.email = 'mfa@platform.example'");
    const actions = rows.map(r => r.action);
    for (const a of ['admin.mfa_enabled', 'admin.login', 'admin.mfa_failed']) assert.ok(actions.includes(a), a);
  });

  test('expired temporary password, reset-2fa and block via the server command', async () => {
    const r = cli(['create', '--email', 'late@platform.example', '--name', 'Late']);
    await owner("UPDATE platform_admins SET temp_password_expires_at = now() - interval '1 minute' WHERE email = 'late@platform.example'");
    assert.equal((await browser().post('admin', '/api/auth/login', { email: 'late@platform.example', password: r.password })).status, 401);

    const { b, password } = await readyAdmin('lost@platform.example');
    assert.equal(cli(['reset-2fa', '--email', 'lost@platform.example']).status, 0);
    assert.equal((await b.get('admin', '/api/platform/tenants')).status, 401, 'sessions revoked');
    const fresh = browser();
    assert.deepEqual((await fresh.post('admin', '/api/auth/login', { email: 'lost@platform.example', password })).json, { ok: true });
    assert.equal((await fresh.get('admin', '/api/platform/tenants')).json.code, 'MFA_SETUP_REQUIRED');

    assert.equal(cli(['block', '--email', 'lost@platform.example']).status, 0);
    assert.equal((await fresh.get('admin', '/api/auth/me')).status, 401);
    assert.equal((await browser().post('admin', '/api/auth/login', { email: 'lost@platform.example', password })).status, 401);
  });

  test('the runtime role cannot grant itself an administrator account or change admin emails', async () => {
    await assert.rejects(sql(env.appUrl, "INSERT INTO platform_admins (id, email, password_hash, name, updated_at) VALUES (gen_random_uuid(), 'x@y.example', 'x', 'x', now())"), e => e.code === '42501');
    await assert.rejects(sql(env.appUrl, "UPDATE platform_admins SET email = 'x@y.example'"), e => e.code === '42501');
  });
});

// ───────────── 4.2–4.3 ─────────────

describe('4.2–4.3 companies: create with first admin, settings, suspend and activate', () => {
  let admin;
  before(async () => { admin = await readyAdmin('companies@platform.example'); });

  test('input is validated with clear messages; reserved and taken subdomains are refused', async () => {
    const base = { name: 'Acme GmbH', displayName: 'Acme CRM', adminEmail: 'boss@acme.example', adminName: 'Acme Boss' };
    const cases = [
      [{ ...base, slug: 'admin' }, 400, /reserviert/],
      [{ ...base, slug: 'Bad_Slug' }, 400, /lateinische Buchstaben/],
      [{ ...base, slug: '-acme' }, 400, /lateinische Buchstaben/],
      [{ ...base, slug: 'nova' }, 409, /bereits vergeben/],
      [{ ...base, slug: 'acme-x', name: '' }, 400, /„Name“/],
      [{ ...base, slug: 'acme-x', adminEmail: 'not-an-email' }, 400, /E-Mail/],
    ];
    for (const [body, status, message] of cases) {
      const r = await admin.b.post('admin', '/api/platform/tenants', body);
      assert.equal(r.status, status, JSON.stringify(body));
      assert.match(r.json.message, message);
    }
    const { rows } = await owner("SELECT count(*)::int AS n FROM users WHERE email = 'boss@acme.example'");
    assert.equal(rows[0].n, 0, 'nothing created by refused requests');
  });

  test('a new company with a new first admin: temporary password once, forced change, then the admin enters', async () => {
    const r = await admin.b.post('admin', '/api/platform/tenants', {
      slug: 'Acme', name: 'Acme GmbH', displayName: 'Acme CRM', adminEmail: 'Boss@Acme.example', adminName: 'Acme Boss',
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.tenant.slug, 'acme');
    assert.equal(r.json.tenant.activeMembers, 0, 'the first admin becomes a member when accepting');
    // C3 (Phase 5): приглашение по email вместо временного пароля; платформа не узнаёт, был ли аккаунт.
    assert.deepEqual(r.json.firstAdmin, { email: 'boss@acme.example', name: 'Acme Boss' });
    assert.equal(r.json.invitationSent, true);
    assert.equal(r.json.temporaryPassword, undefined);
    assert.equal((await browser().get('acme', '/api/tenant')).json.displayName, 'Acme CRM', 'the subdomain works at once');

    const token = mailToken(outbox, 'boss@acme.example');
    assert.ok(token, 'invitation e-mail with a link');
    const boss = browser();
    const info = await boss.post('app', '/api/invitations/inspect', { token });
    assert.deepEqual([info.json.companyName, info.json.role, info.json.accountExists, info.json.status], ['Acme CRM', 'TENANT_ADMIN', false, 'open']);
    const accepted = await boss.post('app', '/api/invitations/accept', { token, name: 'Acme Boss', password: 'acme boss passphrase' });
    assert.deepEqual([accepted.status, accepted.json.tenantSlug], [200, 'acme']);
    assert.equal((await boss.enter('acme')).headers.location, '/');
    const inside = await boss.get('acme', '/api/auth/me');
    assert.deepEqual([inside.json.role, inside.json.tenant.slug], ['TENANT_ADMIN', 'acme']);
    const { rows } = await owner("SELECT email_verified_at IS NOT NULL AS verified FROM users WHERE email = 'boss@acme.example'");
    assert.equal(rows[0].verified, true);
  });

  test('an existing account accepts the first-admin invitation after signing in', async () => {
    const r = await admin.b.post('admin', '/api/platform/tenants', {
      slug: 'beta', name: 'Beta', displayName: 'Beta CRM', adminEmail: 'manager@shared.example', adminName: 'Manager',
    });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.firstAdmin, { email: 'manager@shared.example', name: 'Manager' }, 'no hint whether the account exists');
    const token = mailToken(outbox, 'manager@shared.example');
    const m = browser();
    assert.equal((await m.post('app', '/api/invitations/accept', { token, name: 'x', password: 'some long password' })).status, 409, 'existing account must sign in');
    await m.post('app', '/api/auth/login', { email: 'manager@shared.example', password: SEED_PASSWORD });
    assert.equal((await m.post('app', '/api/invitations/inspect', { token })).json.signedInAs, 'manager@shared.example');
    assert.equal((await m.post('app', '/api/invitations/accept', { token })).json.tenantSlug, 'beta');
    const companies = (await m.get('app', '/api/auth/me')).json.companies;
    assert.deepEqual(companies.find(c => c.slug === 'beta'), { slug: 'beta', displayName: 'Beta CRM', role: 'TENANT_ADMIN' });
    assert.equal((await m.post('app', '/api/invitations/accept', { token })).status, 400, 'the link works once');

    // C4: платформа может пригласить ещё одного администратора (например, если администраторов не осталось).
    const again = await admin.b.post('admin', `/api/platform/tenants/${r.json.tenant.id}/admin-invitations`, { email: 'second@beta.example', name: 'Second' });
    assert.deepEqual([again.status, again.json.invitationSent], [201, true]);
    assert.ok(mailToken(outbox, 'second@beta.example'));
  });

  test('names change; the subdomain cannot change, not even by direct SQL of the runtime role', async () => {
    const acme = (await admin.b.get('admin', '/api/platform/tenants')).json.find(t => t.slug === 'acme');
    const r = await admin.b.patch('admin', `/api/platform/tenants/${acme.id}`, { displayName: 'Acme Sales' });
    assert.equal(r.status, 200);
    assert.equal(r.json.displayName, 'Acme Sales');
    assert.equal((await browser().get('acme', '/api/tenant')).json.displayName, 'Acme Sales');
    const slugChange = await admin.b.patch('admin', `/api/platform/tenants/${acme.id}`, { slug: 'other' });
    assert.deepEqual([slugChange.status, slugChange.json.message], [400, 'Die Subdomain lässt sich nach dem Anlegen des Unternehmens nicht ändern']);
    await assert.rejects(sql(env.appUrl, "UPDATE tenants SET slug = 'hijack' WHERE slug = 'acme'"), e => e.code === '42501');
    assert.equal((await admin.b.patch('admin', `/api/platform/tenants/${acme.id}`, { status: 'DELETED' })).status, 400);
    assert.equal((await admin.b.get('admin', '/api/platform/tenants/00000000-0000-7000-8000-000000000000')).status, 404);
  });

  test('suspending closes the company at once and revokes its sessions; activating brings it back', async () => {
    const acme = (await admin.b.get('admin', '/api/platform/tenants')).json.find(t => t.slug === 'acme');
    const boss = browser();
    await boss.post('app', '/api/auth/login', { email: 'boss@acme.example', password: 'acme boss passphrase' });
    assert.equal((await boss.enter('acme')).headers.location, '/');
    assert.equal((await boss.get('acme', '/api/auth/me')).status, 200);

    assert.equal((await admin.b.patch('admin', `/api/platform/tenants/${acme.id}`, { status: 'SUSPENDED' })).json.status, 'SUSPENDED');
    assert.equal((await boss.get('acme', '/api/auth/me')).status, 404, 'subdomain is gone');
    assert.ok(!(await boss.get('app', '/api/auth/me')).json.companies.some(c => c.slug === 'acme'));
    const { rows } = await owner('SELECT count(*)::int AS n FROM tenant_sessions WHERE revoked_at IS NULL', [], acme.id);
    assert.equal(rows[0].n, 0, 'all company sessions revoked');

    assert.equal((await admin.b.patch('admin', `/api/platform/tenants/${acme.id}`, { status: 'ACTIVE' })).json.status, 'ACTIVE');
    assert.equal((await boss.get('acme', '/api/auth/me')).status, 401, 'old session stays revoked: sign in again');
    assert.equal((await boss.enter('acme')).headers.location, '/');
    assert.equal((await boss.get('acme', '/api/auth/me')).status, 200);
    assert.equal((await owner('SELECT count(*)::int AS n FROM leads', [], acme.id)).rows[0].n, 0);
  });

  test('every change is in the platform audit log without personal data', async () => {
    const { rows } = await owner("SELECT action, metadata FROM platform_audit_logs WHERE action LIKE 'tenant.%'");
    const actions = new Set(rows.map(r => r.action));
    for (const a of ['tenant.created', 'tenant.updated', 'tenant.suspended', 'tenant.activated']) assert.ok(actions.has(a), a);
    assert.ok(rows.every(r => !JSON.stringify(r.metadata ?? {}).includes('@')), 'no emails in audit metadata');
  });
});

// ───────────── 4.5 ─────────────

describe('4.5 platform boundaries', () => {
  test('company users cannot reach platform routes; anonymous gets 401', async () => {
    const user = browser();
    await user.post('app', '/api/auth/login', { email: 'admin@nova.example', password: SEED_PASSWORD });
    await user.enter('nova');
    const novaCookies = user.cookieHeader('nova.localhost:8080');
    assert.equal((await user.get('nova', '/api/platform/tenants')).status, 404, 'no platform routes on a company host');
    assert.equal((await user.get('app', '/api/platform/tenants')).status, 404, 'no platform routes on app');
    assert.equal((await browser().get('admin', '/api/platform/tenants', { headers: { Cookie: novaCookies } })).status, 401);
    assert.equal((await browser().get('admin', '/api/platform/tenants')).status, 401);
    assert.equal((await browser().post('admin', '/api/platform/tenants', { slug: 'x' })).status, 401);
  });

  test('platform responses carry no leads and no member names or emails', async () => {
    const { b } = await readyAdmin('privacy@platform.example');
    const list = await b.get('admin', '/api/platform/tenants');
    const nova = list.json.find(t => t.slug === 'nova');
    assert.equal(nova.activeMembers, 2);
    assert.deepEqual(Object.keys(nova).sort(), ['activeMembers', 'createdAt', 'displayName', 'id', 'name', 'slug', 'status', 'updatedAt']);
    const one = await b.get('admin', `/api/platform/tenants/${tenants.nova.id}`);
    for (const body of [list.body, one.body]) {
      assert.doesNotMatch(body, /@|Nova Lead|Shared Manager/);
    }
  });
});
