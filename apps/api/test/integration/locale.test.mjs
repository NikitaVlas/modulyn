// Phase 10 (I2–I5, I10): язык ответов API, выбор языка аккаунтом, язык писем.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { prepareTestDatabase } from './setup.mjs';
import { SEED_PASSWORD } from '../../scripts/seed.mjs';
import { Browser, host, mailToken, origin } from './browser.mjs';

let env; let app; let port; let outbox;

before(async () => {
  env = await prepareTestDatabase();
  Object.assign(process.env, {
    DATABASE_URL: env.appUrl, APP_BASE_DOMAIN: 'localhost', NODE_ENV: 'test', PUBLIC_PORT: '8080', PUBLIC_SCHEME: 'http', TRUST_PROXY: 'true', SMTP_URL: 'memory:',
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
});

/** «Браузер» с выбранным в переключателе языком (cookie modulyn_lang на этом хосте). */
function browserWith(locale, labels = ['app']) {
  const b = new Browser(port);
  if (locale) for (const label of labels) b.jar(host(label)).set('modulyn_lang', locale);
  return b;
}

async function localeOf(email) {
  const c = new pg.Client({ connectionString: env.ownerUrl });
  await c.connect();
  try { return (await c.query('SELECT locale FROM users WHERE email = $1', [email])).rows[0]?.locale; } finally { await c.end(); }
}

async function signIn(email, slug, locale) {
  const b = browserWith(locale, ['app', slug]);
  assert.equal((await b.post('app', '/api/auth/login', { email, password: SEED_PASSWORD })).status, 200);
  assert.equal((await b.enter(slug)).headers.location, '/');
  return b;
}

test('before sign-in: German by default, otherwise the language of the switcher cookie', async () => {
  const wrong = { email: 'manager@shared.example', password: 'wrong password 123' };
  assert.equal((await browserWith(null).post('app', '/api/auth/login', wrong)).json.message, 'E-Mail oder Passwort ist falsch');
  assert.equal((await browserWith('en').post('app', '/api/auth/login', wrong)).json.message, 'Incorrect email or password');
  assert.equal((await browserWith('ru').post('app', '/api/auth/login', wrong)).json.message, 'Неверный email или пароль');
  assert.equal((await browserWith('fr').post('app', '/api/auth/login', wrong)).json.message, 'E-Mail oder Passwort ist falsch', 'unknown value → German');
});

test('after sign-in the account language wins over the cookie; each person changes only their own', async () => {
  const manager = await signIn('manager@shared.example', 'nova', 'en');
  const me = await manager.get('nova', '/api/auth/me');
  assert.equal(me.json.locale, 'de', 'existing accounts are German (I9)');
  const bad = await manager.post('nova', '/api/leads', { name: '', phone: '1' });
  assert.equal(bad.json.message, 'Geben Sie einen Namen an', 'account language, not the en cookie');

  assert.equal((await manager.send('PUT', 'nova', '/api/auth/locale', { origin: origin('nova'), json: { locale: 'xx' } })).status, 400);
  assert.equal((await manager.send('PUT', 'nova', '/api/auth/locale', { origin: origin('nova'), json: { locale: 'ru' } })).status, 204);
  assert.equal((await manager.get('nova', '/api/auth/me')).json.locale, 'ru');
  assert.equal((await manager.post('nova', '/api/leads', { name: '', phone: '1' })).json.message, 'Укажите имя');
  // Тот же аккаунт на app.<домен> и в другой компании — тоже русский: язык хранится в аккаунте.
  assert.equal((await manager.get('app', '/api/auth/me')).json.locale, 'ru');
  assert.equal(await localeOf('manager@shared.example'), 'ru');
  assert.equal(await localeOf('admin@nova.example'), 'de', 'other people are not affected');
  // Без входа сменить язык аккаунта нельзя.
  assert.equal((await browserWith(null).send('PUT', 'app', '/api/auth/locale', { origin: origin('app'), json: { locale: 'en' } })).status, 401);
  // Модуль отключён — сообщение на языке аккаунта.
  assert.equal((await manager.send('PUT', 'nova', '/api/auth/locale', { origin: origin('nova'), json: { locale: 'en' } })).status, 204);
  const forbidden = await manager.get('nova', '/api/members');
  assert.equal(forbidden.status, 403);
});

test('invitation: e-mail and page in the inviter’s language; the new account keeps the language chosen on acceptance', async () => {
  const admin = await signIn('admin@nova.example', 'nova', null);
  assert.equal((await admin.send('PUT', 'nova', '/api/auth/locale', { origin: origin('nova'), json: { locale: 'en' } })).status, 204);
  assert.equal((await admin.post('nova', '/api/members/invitations', { email: 'lang.person@nova-team.example', name: 'Lang Person', role: 'MANAGER' })).json.invitationSent, true);
  const mail = outbox.find(m => m.to === 'lang.person@nova-team.example');
  assert.equal(mail.subject, 'Invitation to Nova CRM');
  assert.match(mail.html, /<html lang="en">/);

  const token = mailToken(outbox, 'lang.person@nova-team.example');
  const guest = browserWith(null);
  assert.equal((await guest.post('app', '/api/invitations/inspect', { token })).json.locale, 'en');
  const accepted = await guest.post('app', '/api/invitations/accept', { token, name: 'Lang Person', password: 'lang person passphrase', locale: 'ru' });
  assert.equal(accepted.status, 200);
  assert.equal(await localeOf('lang.person@nova-team.example'), 'ru');

  // Сброс пароля — на языке аккаунта получателя, а не того, кто нажал кнопку.
  assert.equal((await browserWith('de').post('app', '/api/auth/password-reset/request', { email: 'lang.person@nova-team.example' })).status, 202);
  await new Promise(r => setTimeout(r, 300)); // письмо отправляется в фоне
  const reset = [...outbox].reverse().find(m => m.to === 'lang.person@nova-team.example');
  assert.equal(reset.subject, 'Восстановление пароля');
});

test('the company handoff page is in the chosen language', async () => {
  const b = browserWith('en', ['app', 'nova']);
  assert.equal((await b.post('app', '/api/auth/login', { email: 'admin@company-b.example', password: SEED_PASSWORD })).status, 200);
  const start = await b.get('company-b', '/api/auth/handoff/start');
  const issueUrl = new URL(start.headers.location);
  // Служебная страница перехода открыта без входа (@Public) — язык из переключателя этого браузера (cookie).
  const issue = await b.get('app', issueUrl.pathname + issueUrl.search);
  assert.match(issue.body, /<html lang="en">/);
  assert.match(issue.body, /Redirecting to Company B CRM/);
});
