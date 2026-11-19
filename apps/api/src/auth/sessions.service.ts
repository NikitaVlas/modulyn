import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { parseEnvironment } from '../config/environment.js';
import { AuthStore } from '../database/auth-store.service.js';
import { restrictionOf, type AppPrincipal, type PlatformPrincipal, type TenantPrincipal, type TenantRef } from '../tenancy/request-context.js';
import { ACCESS_TTL_MS, REFRESH_ABSOLUTE_MS, REFRESH_IDLE_MS, ROTATION_GRACE_MS } from './auth.constants.js';
import { clearCookie, readCookie, setCookie } from './cookies.js';
import { TokensService } from './tokens.service.js';

export type RefreshOutcome =
  | { status: 'ok'; ownerId: string; sessionId: string }
  | { status: 'retry' }
  | { status: 'invalid' };

/**
 * Жизненный цикл сессий (подшаги 3.3, 3.4, 3.10): создание, проверка на каждом запросе, ротация, cookies.
 * Access JWT содержит sid, а guard на каждом запросе проверяет запись сессии в БД, поэтому отзыв
 * (logout, блокировка, отключение участия, смена пароля) действует сразу, а не через 10 минут.
 */
@Injectable()
export class SessionsService {
  readonly secure: boolean;

  constructor(private readonly store: AuthStore, private readonly tokens: TokensService) {
    this.secure = parseEnvironment(process.env).publicScheme === 'https';
  }

  private freshRefresh(kind: 'app' | 'tenant' | 'platform') {
    const token = this.tokens.randomToken();
    const now = Date.now();
    return {
      token,
      row: {
        tokenHash: this.tokens.hash(token), familyId: randomUUID(),
        expiresAt: new Date(now + REFRESH_IDLE_MS[kind]), absoluteExpiresAt: new Date(now + REFRESH_ABSOLUTE_MS[kind]),
      },
    };
  }

  private async setCookies(res: Response, kind: 'app' | 'tenant' | 'platform', claims: { sub: string; sid: string; tid?: string }, refreshToken: string, refreshExpiresAt: Date) {
    const access = await this.tokens.signAccess(kind, claims);
    setCookie(res, 'access', access, this.secure, ACCESS_TTL_MS[kind]);
    setCookie(res, 'refresh', refreshToken, this.secure, Math.max(0, refreshExpiresAt.getTime() - Date.now()));
  }

  clear(res: Response): void {
    clearCookie(res, 'access', this.secure);
    clearCookie(res, 'refresh', this.secure);
  }

  // ───────────── Создание ─────────────

  async startApp(res: Response, userId: string): Promise<string> {
    const { token, row } = this.freshRefresh('app');
    const sid = await this.store.createSession('app', { ...row, ownerId: userId });
    await this.setCookies(res, 'app', { sub: userId, sid }, token, row.expiresAt);
    return sid;
  }

  async startPlatform(res: Response, adminId: string): Promise<string> {
    const { token, row } = this.freshRefresh('platform');
    const sid = await this.store.createSession('platform', { ...row, ownerId: adminId });
    await this.setCookies(res, 'platform', { sub: adminId, sid }, token, row.expiresAt);
    return sid;
  }

  /** Обмен одноразового кода перехода на сессию компании (A6). false — без уточнения причины. */
  async startTenantFromHandoff(res: Response, tenant: TenantRef, code: string, state: string): Promise<boolean> {
    const { token, row } = this.freshRefresh('tenant');
    const result = await this.store.consumeHandoff(tenant.tenantId, this.tokens.hash(code), this.tokens.hash(state), () => row);
    if (!result) return false;
    await this.setCookies(res, 'tenant', { sub: result.userId, sid: result.sessionId, tid: tenant.tenantId }, token, row.expiresAt);
    return true;
  }

  // ───────────── Проверка на каждом запросе ─────────────

  async authenticateTenant(req: Request, tenant: TenantRef): Promise<TenantPrincipal | null> {
    const claims = await this.tokens.verifyAccess('tenant', readCookie(req, 'access', this.secure));
    if (!claims || claims.tid !== tenant.tenantId) return null; // токен другой компании
    const state = await this.store.tenantSessionRole(tenant.tenantId, claims.sid, claims.sub);
    if (!state) return null;
    const restricted = restrictionOf({ passwordChangeRequired: state.passwordChangeRequired, mfaSetupRequired: false });
    return { userId: claims.sub, sessionId: claims.sid, role: state.role, locale: state.locale, ...(restricted ? { restricted } : {}) };
  }

  async authenticateApp(req: Request): Promise<AppPrincipal | null> {
    const claims = await this.tokens.verifyAccess('app', readCookie(req, 'access', this.secure));
    if (!claims) return null;
    const state = await this.store.validAppSession(claims.sid, claims.sub);
    if (!state) return null;
    const restricted = restrictionOf(state);
    return { userId: claims.sub, sessionId: claims.sid, locale: state.locale, ...(restricted ? { restricted } : {}) };
  }

  async authenticatePlatform(req: Request): Promise<PlatformPrincipal | null> {
    const claims = await this.tokens.verifyAccess('platform', readCookie(req, 'access', this.secure));
    if (!claims) return null;
    const state = await this.store.validPlatformSession(claims.sid, claims.sub);
    if (!state) return null;
    const restricted = restrictionOf(state);
    return { adminId: claims.sub, sessionId: claims.sid, locale: state.locale, ...(restricted ? { restricted } : {}) };
  }

  // ───────────── Ротация ─────────────

  async refresh(req: Request, res: Response, kind: 'app' | 'platform' | 'tenant', tenant?: TenantRef): Promise<RefreshOutcome> {
    const presented = readCookie(req, 'refresh', this.secure);
    if (!presented || presented.length > 256) return { status: 'invalid' };
    const { token, row } = this.freshRefresh(kind);
    const next = () => ({ tokenHash: row.tokenHash, expiresAt: row.expiresAt });
    const hash = this.tokens.hash(presented);
    const result = kind === 'tenant'
      ? await this.store.rotateTenant((tenant as TenantRef).tenantId, hash, next, ROTATION_GRACE_MS)
      : await this.store.rotateAppOrPlatform(kind, hash, next, ROTATION_GRACE_MS);
    if (result.status === 'retry') return { status: 'retry' };
    if (result.status !== 'rotated') return { status: 'invalid' };
    // Новая запись не дольше абсолютного предела цепочки; срок cookie — по записи в БД.
    const expiresAt = row.expiresAt;
    await this.setCookies(res, kind, { sub: result.ownerId, sid: result.sessionId, ...(tenant ? { tid: tenant.tenantId } : {}) }, token, expiresAt);
    // Аккаунт или участие могли быть отключены после выдачи refresh: проверяем как обычный запрос.
    const stillValid = kind === 'tenant'
      ? (await this.store.tenantSessionRole((tenant as TenantRef).tenantId, result.sessionId, result.ownerId)) !== null
      : kind === 'app'
        ? await this.store.validAppSession(result.sessionId, result.ownerId)
        : await this.store.validPlatformSession(result.sessionId, result.ownerId);
    if (!stillValid) { this.clear(res); return { status: 'invalid' }; }
    return { status: 'ok', ownerId: result.ownerId, sessionId: result.sessionId };
  }
}
