import { randomBytes } from 'node:crypto';
import {
  BadRequestException, Body, ConflictException, Controller, Get, HttpCode, HttpException, NotFoundException, Post, Put, Query, Req, Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type {
  AppMeResponse, AuthProvidersResponse, LoginResponse, MfaEnableResponse, MfaSetupResponse, PlatformMeResponse,
  TenantInfoResponse, TenantMeResponse,
} from '@modulyn/contracts';
import { isLocale } from '@modulyn/i18n';
import { originFor, parseEnvironment } from '../config/environment.js';
import { requestLocale, t } from '../i18n.js';
import { AuthStore, type LoginAdmin } from '../database/auth-store.service.js';
import { MembersStore } from '../database/members-store.service.js';
import { MailService } from '../mail/mail.service.js';
import { passwordResetMail } from '../mail/templates.js';
import { SLUG_PATTERN } from '../tenancy/hostname.js';
import { currentRequestContext, type RequestContext } from '../tenancy/request-context.js';
import { HANDOFF_CODE_TTL_MS, HANDOFF_STATE_TTL_MS, MFA_PENDING_TTL_MS, OIDC_STATE_TTL_MS, PASSWORD_MAX } from './auth.constants.js';
import { clearCookie, readCookie, setCookie } from './cookies.js';
import { AllowRestricted, Contexts, Public } from './decorators.js';
import { base32Encode, newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, openSecret, otpauthUri, sealSecret, verifyTotp } from './totp.js';
import { GoogleService } from './google.service.js';
import { PasswordService, passwordPolicyError } from './password.service.js';
import { SessionsService } from './sessions.service.js';
import { ThrottleService } from './throttle.service.js';
import { TokensService, safeEqual } from './tokens.service.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;

function context(): RequestContext {
  const value = currentRequestContext();
  if (!value) throw new NotFoundException();
  return value;
}

function text(body: unknown, key: string, max: number): string {
  const value = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new BadRequestException(t('err.fieldInvalid', { field: key }));
  return value;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new UnauthorizedException(t('err.invalidCredentials'));
  return email;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
}

/**
 * Маршруты входа (Phase 3). Один и тот же путь ведёт себя по-разному на app.<домен>, admin.<домен> и поддомене компании;
 * @Contexts закрывает маршрут на «чужих» хостах (404).
 */
@Controller('auth')
export class AuthController {
  private readonly env = parseEnvironment(process.env);
  private readonly appOrigin = originFor(this.env, 'app');

  constructor(
    private readonly store: AuthStore,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionsService,
    private readonly throttle: ThrottleService,
    private readonly google: GoogleService,
    private readonly tokens: TokensService,
    private readonly members: MembersStore,
    private readonly mail: MailService,
  ) {}

  // ───────────── Справочное для страницы входа ─────────────

  @Public() @Contexts('app') @Get('providers')
  providers(): AuthProvidersResponse {
    return { password: true, google: this.google.enabled };
  }

  /** Название компании для страницы входа «Вход в Nova CRM» (A5). Неизвестная и отключённая — одинаковый 404. */
  @Public() @Contexts('app') @Get('tenant-name')
  async tenantName(@Query('slug') slug: unknown): Promise<TenantInfoResponse> {
    if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug)) throw new NotFoundException();
    const tenant = await this.store.findActiveTenantBySlug(slug);
    if (!tenant) throw new NotFoundException();
    return { slug: tenant.slug, displayName: tenant.displayName };
  }

  // ───────────── Вход по паролю (3.2, 3.3) ─────────────

  @Public() @Contexts('app', 'platform') @Post('login') @HttpCode(200)
  async login(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<LoginResponse> {
    const ctx = context();
    const email = normalizeEmail(text(body, 'email', 320));
    const password = text(body, 'password', 1024);
    const scope = ctx.kind; // app или platform: отдельные счётчики и отдельные таблицы аккаунтов
    await this.throttle.before(res, scope, ctx.ip, email);

    const account = ctx.kind === 'platform'
      ? await this.store.findPlatformAdminByEmail(email)
      : await this.store.findUserByEmail(email);
    const valid = account?.passwordHash
      ? await this.passwords.verify(account.passwordHash, password)
      : await this.passwords.verifyDummy(password);
    // Временный пароль действует 7 дней (B8). Просроченный, заблокированный аккаунт и неверный пароль — один ответ (A8).
    const tempExpired = account?.passwordChangeRequired === true && account.tempPasswordExpiresAt !== null && account.tempPasswordExpiresAt < new Date();
    if (!account || !valid || !account.isActive || tempExpired) {
      await this.throttle.failed(scope, ctx.ip, email);
      if (ctx.kind === 'platform' && account) await this.store.platformAudit('admin.login_failed', account.id);
      throw new UnauthorizedException(t('err.invalidCredentials'));
    }
    await this.throttle.succeeded(scope, ctx.ip, email);
    if (ctx.kind !== 'platform') {
      await this.sessions.startApp(res, account.id);
      return { ok: true };
    }
    // Платформа: при настроенном втором факторе сессии ещё нет — только короткая отметка «пароль проверен» (B10).
    if ((account as LoginAdmin).totpEnabledAt) {
      const pending = await this.tokens.signState({ sub: account.id }, MFA_PENDING_TTL_MS, 'mfa-pending');
      setCookie(res, 'mfaPending', pending, this.sessions.secure, MFA_PENDING_TTL_MS);
      return { ok: true, mfaRequired: true };
    }
    // Второй фактор ещё не настроен: сессия ограничена — смена временного пароля и настройка TOTP (guard).
    await this.sessions.startPlatform(res, account.id);
    await this.store.platformAudit('admin.login', account.id, undefined, { mfa: 'not-configured' });
    return { ok: true };
  }

  // ───────────── Второй фактор платформы (4.1, B2, B10) ─────────────

  /** Второй шаг входа: 6-значный код из приложения или одноразовый код восстановления. */
  @Public() @Contexts('platform') @Post('mfa') @HttpCode(200)
  async verifyMfa(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    const ctx = context();
    const pending = await this.tokens.verifyState(readCookie(req, 'mfaPending', this.sessions.secure), 'mfa-pending');
    if (!pending || typeof pending.sub !== 'string') throw new UnauthorizedException({ statusCode: 401, message: t('err.signInAgain'), code: 'MFA_EXPIRED' });
    const adminId = pending.sub;
    const code = text(body, 'code', 32).trim();
    await this.throttle.before(res, 'mfa', ctx.ip, adminId);
    const admin = await this.store.findPlatformAdminById(adminId);
    let method: 'totp' | 'recovery' | null = null;
    if (admin?.isActive && admin.totpEnabledAt && admin.totpSecretEnc) {
      if (/^\d{6}$/.test(code)) {
        const step = verifyTotp(openSecret(this.env.totpKey, admin.totpSecretEnc), code, admin.totpLastStep === null ? null : Number(admin.totpLastStep));
        if (step !== null && await this.store.acceptTotpStep(adminId, step)) method = 'totp';
      } else if (await this.store.useRecoveryCode(adminId, this.tokens.hash(normalizeRecoveryCode(code)))) {
        method = 'recovery';
      }
    }
    if (!method) {
      await this.throttle.failed('mfa', ctx.ip, adminId);
      await this.store.platformAudit('admin.mfa_failed', adminId);
      throw new UnauthorizedException({ statusCode: 401, message: t('err.invalidCode'), code: 'MFA_INVALID_CODE' });
    }
    await this.throttle.succeeded('mfa', ctx.ip, adminId);
    clearCookie(res, 'mfaPending', this.sessions.secure);
    await this.sessions.startPlatform(res, adminId);
    await this.store.platformAudit('admin.login', adminId, undefined, { mfa: method });
    return { ok: true };
  }

  /** Настройка второго фактора: новый секрет (до подтверждения его можно перевыпустить). Показывается один раз. */
  @AllowRestricted('mfa-setup') @Contexts('platform') @Post('mfa/setup') @HttpCode(200)
  async setupMfa(): Promise<MfaSetupResponse> {
    const ctx = context();
    if (ctx.kind !== 'platform') throw new NotFoundException();
    const admin = await this.store.findPlatformAdminById(ctx.principal!.adminId);
    if (!admin || admin.totpEnabledAt) throw new ConflictException(t('err.mfaAlreadySet'));
    const secret = newTotpSecret();
    if (!(await this.store.setPendingTotp(admin.id, sealSecret(this.env.totpKey, secret)))) throw new ConflictException(t('err.mfaAlreadySet'));
    return { otpauthUri: otpauthUri(secret, admin.email), secret: base32Encode(secret) };
  }

  /** Подтверждение настройки кодом из приложения: включает второй фактор и выдаёт 10 кодов восстановления. */
  @AllowRestricted('mfa-setup') @Contexts('platform') @Post('mfa/enable') @HttpCode(200)
  async enableMfa(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<MfaEnableResponse> {
    const ctx = context();
    if (ctx.kind !== 'platform') throw new NotFoundException();
    const adminId = ctx.principal!.adminId;
    const code = text(body, 'code', 16).trim();
    await this.throttle.before(res, 'mfa', ctx.ip, adminId);
    const admin = await this.store.findPlatformAdminById(adminId);
    if (!admin || admin.totpEnabledAt || !admin.totpSecretEnc) throw new ConflictException(t('err.mfaStartFirst'));
    const step = verifyTotp(openSecret(this.env.totpKey, admin.totpSecretEnc), code, null);
    if (step === null) {
      await this.throttle.failed('mfa', ctx.ip, adminId);
      throw new BadRequestException(t('err.mfaCodeMismatch'));
    }
    const recoveryCodes = newRecoveryCodes();
    const hashes = recoveryCodes.map(c => this.tokens.hash(normalizeRecoveryCode(c)));
    if (!(await this.store.enableTotp(adminId, step, hashes))) throw new ConflictException(t('err.mfaAlreadySet'));
    await this.throttle.succeeded('mfa', ctx.ip, adminId);
    await this.store.platformAudit('admin.mfa_enabled', adminId);
    return { recoveryCodes };
  }

  // ───────────── Обновление и выход (3.4) ─────────────

  /** 200 — новые cookies; 409 — токен только что обновлён другой вкладкой, повторите запрос; 401 — войдите заново. */
  @Public() @Post('refresh') @HttpCode(200)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    const ctx = context();
    const outcome = await this.sessions.refresh(req, res, ctx.kind, ctx.kind === 'tenant' ? ctx.tenant : undefined);
    if (outcome.status === 'retry') throw new ConflictException('Retry');
    if (outcome.status === 'invalid') { this.sessions.clear(res); throw new UnauthorizedException(); }
    return { ok: true };
  }

  /**
   * Выход в этом браузере. Работает и с истёкшим access-токеном (по refresh-cookie).
   * На поддомене компании — полный выход: сессия компании, центральная сессия и все её сессии компаний.
   */
  @Public() @Post('logout') @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    const ctx = context();
    const refresh = readCookie(req, 'refresh', this.sessions.secure);
    this.sessions.clear(res);
    let session: { id: string; ownerId: string; familyId: string } | null = null;
    if (ctx.kind === 'tenant') {
      const principal = await this.sessions.authenticateTenant(req, ctx.tenant);
      if (principal) session = { id: principal.sessionId, ownerId: principal.userId, familyId: '' };
      else if (refresh) session = await this.store.findSessionByToken('tenant', this.tokens.hash(refresh), ctx.tenant.tenantId);
      if (session) await this.store.revokeTenantLogout(session.ownerId, session.id);
      return;
    }
    if (refresh) session = await this.store.findSessionByToken(ctx.kind, this.tokens.hash(refresh));
    if (session) await this.store.revokeFamily(ctx.kind, session.familyId, session.ownerId);
  }

  /** Выход на всех устройствах: все сессии человека (или администратора платформы). */
  @AllowRestricted('password-change', 'mfa-setup') @Post('logout-all') @HttpCode(204)
  async logoutAll(@Res({ passthrough: true }) res: Response): Promise<void> {
    const ctx = context();
    this.sessions.clear(res);
    if (ctx.kind === 'platform') await this.store.revokeAllPlatformSessions(ctx.principal!.adminId);
    else await this.store.revokeAllUserSessions(ctx.principal!.userId);
  }

  // ───────────── Текущий пользователь ─────────────

  @AllowRestricted('password-change', 'mfa-setup') @Get('me')
  async me(): Promise<AppMeResponse | TenantMeResponse | PlatformMeResponse> {
    const ctx = context();
    if (ctx.kind === 'platform') {
      const admin = await this.store.findPlatformAdminById(ctx.principal!.adminId);
      if (!admin) throw new UnauthorizedException();
      return { admin: { name: admin.name, email: admin.email }, passwordChangeRequired: admin.passwordChangeRequired, mfaSetupRequired: admin.totpEnabledAt === null, locale: admin.locale };
    }
    const user = await this.store.findUserById(ctx.principal!.userId);
    if (!user) throw new UnauthorizedException();
    const account = { name: user.name, email: user.email };
    if (ctx.kind === 'tenant') {
      return {
        user: account, role: ctx.principal!.role, tenant: { slug: ctx.tenant.slug, displayName: ctx.tenant.displayName },
        passwordChangeRequired: user.passwordChangeRequired, locale: user.locale,
      };
    }
    // До смены временного пароля список компаний не показывается — переход в них всё равно закрыт.
    return { user: account, companies: user.passwordChangeRequired ? [] : await this.store.listCompanies(user.id), passwordChangeRequired: user.passwordChangeRequired, locale: user.locale };
  }

  /**
   * Язык своего аккаунта (Phase 10, I2): во всех трёх контекстах, в том числе до завершения обязательных шагов.
   * Меняется только своя строка (users или platform_admins); cookie языка ставит сам интерфейс.
   */
  @AllowRestricted('password-change', 'mfa-setup') @Put('locale') @HttpCode(204)
  async setLocale(@Body() body: unknown): Promise<void> {
    const ctx = context();
    const locale = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).locale : undefined;
    if (!isLocale(locale)) throw new BadRequestException(t('err.localeInvalid'));
    if (ctx.kind === 'platform') await this.store.setPlatformAdminLocale(ctx.principal!.adminId, locale);
    else await this.store.setUserLocale(ctx.principal!.userId, locale);
  }

  /** Смена своего пароля (A10). Остальные сессии отзываются, текущий браузер остаётся в системе. Снимает признак временного пароля (B8). */
  @AllowRestricted('password-change', 'mfa-setup') @Post('password') @HttpCode(204)
  async changePassword(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<void> {
    const ctx = context();
    const current = text(body, 'currentPassword', 1024);
    const next = text(body, 'newPassword', PASSWORD_MAX * 4);
    const policy = passwordPolicyError(next);
    if (policy) throw new BadRequestException(policy);
    if (next === current) throw new BadRequestException(t('err.passwordSame'));

    const ownerId = ctx.kind === 'platform' ? ctx.principal!.adminId : ctx.principal!.userId;
    const account = ctx.kind === 'platform' ? await this.store.findPlatformAdminById(ownerId) : await this.store.findUserById(ownerId);
    const scope = `password:${ctx.kind}`;
    await this.throttle.before(res, scope, ctx.ip, ownerId);
    if (!account?.passwordHash || !(await this.passwords.verify(account.passwordHash, current))) {
      await this.throttle.failed(scope, ctx.ip, ownerId);
      throw new BadRequestException(t('err.passwordCurrentWrong'));
    }
    await this.throttle.succeeded(scope, ctx.ip, ownerId);
    const hash = await this.passwords.hash(next);
    if (ctx.kind === 'platform') {
      await this.store.setPlatformAdminPassword(ownerId, hash);
      await this.store.revokeAllPlatformSessions(ownerId, (await this.store.platformSessionFamily(ctx.principal!.sessionId)) ?? undefined);
      return;
    }
    await this.store.setUserPassword(ownerId, hash);
    const keep = ctx.kind === 'tenant'
      ? await this.store.parentFamilyOfTenantSession(ctx.tenant.tenantId, ctx.principal!.sessionId)
      : await this.store.userSessionFamily(ctx.principal!.sessionId);
    await this.store.revokeAllUserSessions(ownerId, keep ?? undefined);
  }

  // ───────────── Переход app → компания (3.10, A6) ─────────────

  /** Шаг 1, поддомен компании: привязываем переход к этому браузеру cookie state и отправляем на app.<домен>. */
  @Public() @Contexts('tenant') @Get('handoff/start')
  handoffStart(@Res() res: Response): void {
    const ctx = context();
    if (ctx.kind !== 'tenant') throw new NotFoundException();
    const state = this.tokens.randomToken();
    setCookie(res, 'handoffState', state, this.sessions.secure, HANDOFF_STATE_TTL_MS);
    res.setHeader('Cache-Control', 'no-store');
    const target = new URL(this.appOrigin + '/api/auth/handoff/issue');
    target.searchParams.set('tenant', ctx.tenant.slug);
    target.searchParams.set('state', state);
    res.redirect(303, target.href);
  }

  /**
   * Шаг 2, app.<домен>: при действующей центральной сессии (или успешном её обновлении) выдаём одноразовый код
   * для этой компании и этого state и отправляем его POST-формой — код не попадает в URL, историю и логи.
   */
  @Public() @Contexts('app') @Get('handoff/issue')
  async handoffIssue(@Query('tenant') slug: unknown, @Query('state') state: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    if (typeof slug !== 'string' || !SLUG_PATTERN.test(slug) || typeof state !== 'string' || !TOKEN_PATTERN.test(state)) {
      res.redirect(303, this.appOrigin + '/');
      return;
    }
    let principal: { userId: string; sessionId: string } | null = await this.sessions.authenticateApp(req);
    if (!principal) {
      const refreshed = await this.sessions.refresh(req, res, 'app');
      if (refreshed.status === 'ok') principal = { userId: refreshed.ownerId, sessionId: refreshed.sessionId };
    }
    if (!principal) {
      res.redirect(303, `${this.appOrigin}/login?tenant=${encodeURIComponent(slug)}`);
      return;
    }
    // Вход временным паролем: сначала смена пароля на app.<домен>, в компанию — после (B8).
    if ((await this.store.findUserById(principal.userId))?.passwordChangeRequired) {
      res.redirect(303, `${this.appOrigin}/`);
      return;
    }
    const tenant = await this.store.findActiveTenantBySlug(slug);
    const companies = await this.store.listCompanies(principal.userId);
    if (!tenant || !companies.some(c => c.slug === slug)) {
      res.redirect(303, `${this.appOrigin}/?error=no-access`);
      return;
    }
    const code = this.tokens.randomToken();
    await this.store.createHandoff({
      userId: principal.userId, tenantId: tenant.id, userSessionId: principal.sessionId,
      codeHash: this.tokens.hash(code), stateHash: this.tokens.hash(state), expiresAt: new Date(Date.now() + HANDOFF_CODE_TTL_MS),
    });
    const action = originFor(this.env, slug) + '/api/auth/handoff/complete';
    const nonce = randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action ${originFor(this.env, slug)}; base-uri 'none'; frame-ancestors 'none'`);
    // С no-referrer (по умолчанию helmet) браузер отправляет межсайтовую форму с Origin: null, и проверка Origin (A7)
    // её отклоняет. strict-origin передаёт только origin app.<домен> — без пути и параметров.
    res.setHeader('Referrer-Policy', 'strict-origin');
    const redirecting = escapeHtml(t('page.redirecting', { company: tenant.displayName }));
    res.type('html').send(`<!doctype html><html lang="${requestLocale()}"><head><meta charset="utf-8"><meta name="referrer" content="strict-origin"><title>${redirecting}</title></head>
<body style="font-family:Arial,sans-serif;padding:2rem"><form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="code" value="${escapeHtml(code)}"><input type="hidden" name="state" value="${escapeHtml(state)}">
<p>${redirecting}</p><noscript><button type="submit">${escapeHtml(t('common.continue'))}</button></noscript></form>
<script nonce="${nonce}">document.forms[0].submit()</script></body></html>`);
  }

  /**
   * Шаг 3, поддомен компании: принимает форму с app.<домен> и пересылает её на свой же хост (шаг 4).
   * Межсайтовый POST браузер отправляет без cookies SameSite=Lax (у *.localhost каждый поддомен — отдельный «сайт»),
   * поэтому сверить state здесь нельзя. Ничего не проверяет и не создаёт — только передаёт форму дальше.
   */
  @Public() @Contexts('tenant') @Post('handoff/complete') @HttpCode(200)
  handoffComplete(@Body() body: unknown, @Res() res: Response): void {
    const fields = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
    const { code, state } = fields;
    res.setHeader('Cache-Control', 'no-store');
    if (typeof code !== 'string' || !TOKEN_PATTERN.test(code) || typeof state !== 'string' || !TOKEN_PATTERN.test(state)) {
      res.redirect(303, '/?error=handoff');
      return;
    }
    const nonce = randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
    res.setHeader('Referrer-Policy', 'same-origin');
    res.type('html').send(`<!doctype html><html lang="${requestLocale()}"><head><meta charset="utf-8"><title>${escapeHtml(t('page.signInTitle'))}</title></head>
<body style="font-family:Arial,sans-serif;padding:2rem"><form method="post" action="/api/auth/handoff/finish">
<input type="hidden" name="code" value="${escapeHtml(code)}"><input type="hidden" name="state" value="${escapeHtml(state)}">
<p>${escapeHtml(t('common.signingIn'))}</p><noscript><button type="submit">${escapeHtml(t('common.continue'))}</button></noscript></form>
<script nonce="${nonce}">document.forms[0].submit()</script></body></html>`);
  }

  /** Шаг 4, поддомен компании, запрос со своего origin: state из формы сверяется с cookie этого браузера, код обменивается на сессию. */
  @Public() @Contexts('tenant') @Post('handoff/finish')
  async handoffFinish(@Body() body: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    const ctx = context();
    if (ctx.kind !== 'tenant') throw new NotFoundException();
    res.setHeader('Cache-Control', 'no-store');
    const fields = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
    const code = fields.code;
    const state = fields.state;
    const cookieState = readCookie(req, 'handoffState', this.sessions.secure);
    clearCookie(res, 'handoffState', this.sessions.secure);
    const ok = typeof code === 'string' && TOKEN_PATTERN.test(code) && typeof state === 'string' && TOKEN_PATTERN.test(state)
      && cookieState !== undefined && safeEqual(cookieState, state)
      && await this.sessions.startTenantFromHandoff(res, ctx.tenant, code, state);
    res.redirect(303, ok ? '/' : '/?error=handoff');
  }

  // ───────────── Google (3.9) ─────────────

  @Public() @Contexts('app') @Get('google')
  async googleStart(@Query('tenant') slug: unknown, @Res() res: Response): Promise<void> {
    if (!this.google.enabled) throw new NotFoundException();
    const tenant = typeof slug === 'string' && SLUG_PATTERN.test(slug) ? slug : '';
    let start;
    try { start = await this.google.start(); } catch {
      res.redirect(303, `${this.appOrigin}/login?error=google${tenant ? '&tenant=' + tenant : ''}`);
      return;
    }
    const cookie = await this.tokens.signState({ state: start.state, nonce: start.nonce, verifier: start.verifier, tenant }, OIDC_STATE_TTL_MS);
    setCookie(res, 'oidcState', cookie, this.sessions.secure, OIDC_STATE_TTL_MS);
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(303, start.url);
  }

  @Public() @Contexts('app') @Get('google/callback')
  async googleCallback(@Req() req: Request, @Res() res: Response): Promise<void> {
    if (!this.google.enabled) throw new NotFoundException();
    res.setHeader('Cache-Control', 'no-store');
    const saved = await this.tokens.verifyState(readCookie(req, 'oidcState', this.sessions.secure));
    clearCookie(res, 'oidcState', this.sessions.secure);
    const tenant = typeof saved?.tenant === 'string' && SLUG_PATTERN.test(saved.tenant) ? saved.tenant : '';
    const failure = `${this.appOrigin}/login?error=google${tenant ? '&tenant=' + tenant : ''}`;
    if (!saved || typeof saved.state !== 'string' || typeof saved.nonce !== 'string' || typeof saved.verifier !== 'string') {
      res.redirect(303, failure);
      return;
    }
    const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?') + 1) : '';
    const checks = { state: saved.state, nonce: saved.nonce, verifier: saved.verifier };
    const userId = typeof saved.invite === 'string'
      ? await this.acceptInvitationWithGoogle(saved.invite, query, checks)
      : (await this.google.finish(query, checks))?.id ?? null;
    if (!userId) {
      res.redirect(303, typeof saved.invite === 'string' ? `${this.appOrigin}/invite?error=google` : failure);
      return;
    }
    await this.sessions.startApp(res, userId);
    res.redirect(303, tenant ? originFor(this.env, tenant) + '/api/auth/handoff/start' : this.appOrigin + '/');
  }

  /**
   * Приглашение через Google (C2): Google должен подтвердить email, совпадающий с email приглашения.
   * Аккаунт есть — принимает он (Google привязывается при совпадении email); нет — создаётся с привязкой Google, без пароля.
   */
  private async acceptInvitationWithGoogle(inviteHash: string, query: string, checks: { state: string; nonce: string; verifier: string }): Promise<string | null> {
    const claims = await this.google.verify(query, checks);
    const info = await this.members.inspect(inviteHash);
    if (!claims || !info || !info.open || !claims.emailVerified || claims.email !== info.email) return null;
    const existing = await this.google.resolveUser(claims);
    const byEmail = existing ?? await this.store.findUserByEmail(info.email);
    const account = byEmail
      ? (byEmail.email === info.email ? { kind: 'existing' as const, userId: byEmail.id } : null)
      : { kind: 'new' as const, name: info.name, passwordHash: null, googleSubject: claims.sub };
    if (!account) return null;
    return (await this.members.accept(inviteHash, account, info.email))?.userId ?? null;
  }

  // ───────────── Восстановление пароля (5.6, C7) ─────────────

  /**
   * Ответ всегда одинаковый — по нему нельзя узнать, есть ли аккаунт. Письмо отправляется в фоне,
   * чтобы время ответа тоже не выдавало существование аккаунта. Лимиты: 20 запросов в час с IP, 3 письма в час на email.
   * Только для пользователей компаний: у администраторов платформы восстановление — командой на сервере.
   */
  @Public() @Contexts('app') @Post('password-reset/request') @HttpCode(202)
  async requestPasswordReset(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    const ctx = context();
    const email = (typeof body === 'object' && body !== null && typeof (body as Record<string, unknown>).email === 'string')
      ? ((body as Record<string, unknown>).email as string).trim().toLowerCase() : '';
    if (email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new BadRequestException(t('err.emailInvalid'));
    if (await this.throttle.exceeded(`reset-ip:${ctx.ip ?? 'unknown'}`, 20, 60 * 60_000)) {
      res.setHeader('Retry-After', '3600');
      throw new HttpException({ statusCode: 429, message: t('err.tooManyRequests') }, 429);
    }
    void this.sendPasswordReset(email).catch(() => undefined);
    return { ok: true };
  }

  private async sendPasswordReset(email: string): Promise<void> {
    if (await this.throttle.exceeded(`reset-email:${email}`, 3, 60 * 60_000)) return;
    const user = await this.store.findUserByEmail(email);
    if (!user || !user.isActive) return;
    const token = this.tokens.randomToken();
    await this.store.createPasswordReset(user.id, this.tokens.hash(token), new Date(Date.now() + 60 * 60_000));
    await this.mail.send(passwordResetMail({ to: email, link: `${this.appOrigin}/reset-password#${token}`, locale: user.locale }));
  }

  /** Новый пароль по ссылке: одноразово, 1 час; после смены все сессии человека завершаются. */
  @Public() @Contexts('app') @Post('password-reset/confirm') @HttpCode(204)
  async confirmPasswordReset(@Body() body: unknown, @Res({ passthrough: true }) res: Response): Promise<void> {
    const fields = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
    const token = fields.token;
    const password = typeof fields.newPassword === 'string' ? fields.newPassword : '';
    if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw new BadRequestException(t('err.linkInvalid'));
    const policy = passwordPolicyError(password);
    if (policy) throw new BadRequestException(policy);
    const userId = await this.store.resetPassword(this.tokens.hash(token), await this.passwords.hash(password));
    if (!userId) throw new BadRequestException(t('err.linkInvalidRequestNew'));
    await this.store.revokeAllUserSessions(userId);
    this.sessions.clear(res);
  }
}
