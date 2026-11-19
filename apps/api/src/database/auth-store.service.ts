import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { Locale } from '@modulyn/i18n';
import type { TenantRole } from '../tenancy/request-context.js';
import { DatabaseService } from './database.service.js';
import { TenantDb } from './tenant-db.service.js';

/**
 * Доступ к аккаунтам, способам входа и сессиям (Phase 3). Единственное место, где читаются users,
 * user_identities, *_sessions, login_handoffs, platform_admins и auth_throttle. Бизнес-модули этот класс не используют.
 *
 * Таблицы аккаунта и центральных сессий — вне компаний и без RLS. tenant_sessions — под RLS:
 * создаются и проверяются в транзакции компании (TenantDb), а отзываются в контексте человека (app.user_id),
 * для которого политика tenant_session_self_revoke разрешает менять только свои сессии.
 */

export type SessionKind = 'app' | 'platform' | 'tenant';

export interface SessionTimes { expiresAt: Date; absoluteExpiresAt: Date }

export interface NewSession extends SessionTimes { ownerId: string; tokenHash: string; familyId: string }

/** Результат попытки обменять refresh-токен. */
export type RotationResult =
  | { status: 'rotated'; ownerId: string; sessionId: string; familyId: string; userSessionId?: string }
  | { status: 'retry' }      // токен только что обновлён другим запросом (две вкладки) — повторить с новой cookie
  | { status: 'reused' }     // старый токен предъявлен повторно после окна: цепочка отозвана
  | { status: 'invalid' };   // неизвестен, истёк или отозван

export interface LoginUser {
  id: string; email: string; name: string; passwordHash: string | null; isActive: boolean;
  /** B8: вход временным паролем — до смены пароля доступ ограничен. */
  passwordChangeRequired: boolean; tempPasswordExpiresAt: Date | null;
  /** Phase 10 (I2): язык интерфейса и писем. */
  locale: Locale;
}
export interface LoginAdmin extends LoginUser {
  passwordHash: string;
  totpSecretEnc: string | null; totpEnabledAt: Date | null; totpLastStep: bigint | null;
}
/** Состояние аккаунта для проверки каждого запроса: ограничения доступа (B8, B2). */
export interface AccountState { passwordChangeRequired: boolean; mfaSetupRequired: boolean; locale: Locale }

const USER_SELECT = { id: true, email: true, name: true, passwordHash: true, isActive: true, passwordChangeRequired: true, tempPasswordExpiresAt: true, locale: true } as const;
const ADMIN_SELECT = { ...USER_SELECT, totpSecretEnc: true, totpEnabledAt: true, totpLastStep: true } as const;
export interface CompanyEntry { slug: string; displayName: string; role: TenantRole }

/** Минимальный общий интерфейс делегатов Prisma для таблиц сессий (поля совпадают, кроме владельца). */
interface SessionRow {
  id: string; familyId: string; rotatedAt: Date | null; revokedAt: Date | null;
  expiresAt: Date; absoluteExpiresAt: Date; userId?: string; adminId?: string; userSessionId?: string;
}
interface SessionDelegate {
  create(args: { data: Record<string, unknown>; select: { id: true } }): Promise<{ id: string }>;
  findUnique(args: { where: { tokenHash: string } }): Promise<SessionRow | null>;
  updateManyAndReturn(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<SessionRow[]>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
}
type Tx = Prisma.TransactionClient;

const OWNER_FIELD: Record<SessionKind, 'userId' | 'adminId'> = { app: 'userId', tenant: 'userId', platform: 'adminId' };

@Injectable()
export class AuthStore {
  constructor(private readonly database: DatabaseService, private readonly tenantDb: TenantDb) {}

  private async client() {
    await this.database.assertRuntimeRole();
    return this.database.client;
  }

  /** Транзакция в контексте человека: политики *_self разрешают читать/отзывать только его записи. */
  async runAsUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.client();
    return client.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.user_id', ${userId}, true)`;
      return fn(tx);
    });
  }

  private delegate(tx: Tx, kind: SessionKind): SessionDelegate {
    const map = { app: tx.userSession, platform: tx.platformSession, tenant: tx.tenantSession };
    return map[kind] as unknown as SessionDelegate;
  }

  // ───────────── Аккаунты ─────────────

  async findUserByEmail(email: string): Promise<LoginUser | null> {
    return (await this.client()).user.findUnique({ where: { email }, select: USER_SELECT });
  }

  async findUserById(id: string): Promise<LoginUser | null> {
    return (await this.client()).user.findUnique({ where: { id }, select: USER_SELECT });
  }

  /** Новый постоянный пароль снимает признак временного (B8). */
  async setUserPassword(userId: string, passwordHash: string): Promise<void> {
    await (await this.client()).user.update({
      where: { id: userId }, data: { passwordHash, passwordChangeRequired: false, tempPasswordExpiresAt: null },
    });
  }

  async findPlatformAdminByEmail(email: string): Promise<LoginAdmin | null> {
    return (await this.client()).platformAdmin.findUnique({ where: { email }, select: ADMIN_SELECT });
  }

  async findPlatformAdminById(id: string): Promise<LoginAdmin | null> {
    return (await this.client()).platformAdmin.findUnique({ where: { id }, select: ADMIN_SELECT });
  }

  /** Phase 10 (I2): язык своего аккаунта — только эта строка и только этот столбец. */
  async setUserLocale(userId: string, locale: Locale): Promise<void> {
    await (await this.client()).user.update({ where: { id: userId }, data: { locale } });
  }

  async setPlatformAdminLocale(adminId: string, locale: Locale): Promise<void> {
    await (await this.client()).platformAdmin.update({ where: { id: adminId }, data: { locale } });
  }

  async setPlatformAdminPassword(adminId: string, passwordHash: string): Promise<void> {
    await (await this.client()).platformAdmin.update({
      where: { id: adminId }, data: { passwordHash, passwordChangeRequired: false, tempPasswordExpiresAt: null },
    });
  }

  // ───────────── Восстановление пароля (5.6, C7) ─────────────

  /** Новая ссылка; прежние неиспользованные ссылки этого человека перестают работать. */
  async createPasswordReset(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    const client = await this.client();
    await client.$transaction([
      client.passwordReset.deleteMany({ where: { OR: [{ userId, usedAt: null }, { expiresAt: { lt: new Date() } }] } }),
      client.passwordReset.create({ data: { userId, tokenHash, expiresAt } }),
    ]);
  }

  /**
   * Одноразовый обмен ссылки на новый пароль: условный UPDATE used_at, новый пароль, подтверждённый email
   * (человек получил письмо). Возвращает userId или null без уточнения причины.
   */
  async resetPassword(tokenHash: string, passwordHash: string): Promise<string | null> {
    const client = await this.client();
    return client.$transaction(async tx => {
      const now = new Date();
      const claimed = await tx.passwordReset.updateManyAndReturn({ where: { tokenHash, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      const reset = claimed[0];
      if (!reset) return null;
      const { count } = await tx.user.updateMany({
        where: { id: reset.userId, isActive: true },
        data: { passwordHash, passwordChangeRequired: false, tempPasswordExpiresAt: null, emailVerifiedAt: now },
      });
      return count === 1 ? reset.userId : null;
    });
  }

  // ───────────── Второй фактор платформы (B2, B10) ─────────────

  /** Новый секрет при настройке. Пока второй фактор не подтверждён кодом, его можно перевыпускать. */
  async setPendingTotp(adminId: string, secretEnc: string): Promise<boolean> {
    const { count } = await (await this.client()).platformAdmin.updateMany({
      where: { id: adminId, totpEnabledAt: null }, data: { totpSecretEnc: secretEnc, totpLastStep: null },
    });
    return count === 1;
  }

  /** Подтверждение настройки: включает второй фактор и заменяет коды восстановления. */
  async enableTotp(adminId: string, step: number, recoveryHashes: string[]): Promise<boolean> {
    const client = await this.client();
    return client.$transaction(async tx => {
      const { count } = await tx.platformAdmin.updateMany({
        where: { id: adminId, totpEnabledAt: null, totpSecretEnc: { not: null } },
        data: { totpEnabledAt: new Date(), totpLastStep: BigInt(step) },
      });
      if (count !== 1) return false;
      await tx.platformRecoveryCode.deleteMany({ where: { adminId } });
      await tx.platformRecoveryCode.createMany({ data: recoveryHashes.map(codeHash => ({ adminId, codeHash })) });
      return true;
    });
  }

  /** Атомарно принимает шаг TOTP: тот же или более ранний шаг повторно не пройдёт даже при параллельных запросах. */
  async acceptTotpStep(adminId: string, step: number): Promise<boolean> {
    const { count } = await (await this.client()).platformAdmin.updateMany({
      where: { id: adminId, totpEnabledAt: { not: null }, OR: [{ totpLastStep: null }, { totpLastStep: { lt: BigInt(step) } }] },
      data: { totpLastStep: BigInt(step) },
    });
    return count === 1;
  }

  async useRecoveryCode(adminId: string, codeHash: string): Promise<boolean> {
    const { count } = await (await this.client()).platformRecoveryCode.updateMany({
      where: { adminId, codeHash, usedAt: null }, data: { usedAt: new Date() },
    });
    return count === 1;
  }

  async remainingRecoveryCodes(adminId: string): Promise<number> {
    return (await this.client()).platformRecoveryCode.count({ where: { adminId, usedAt: null } });
  }

  // ───────────── Аудит платформы (B7) ─────────────

  /** metadata — только названия полей и технические признаки, без персональных данных и секретов. */
  async platformAudit(action: string, actorAdminId: string | null, targetTenantId?: string, metadata?: Record<string, string | number | boolean | string[]>): Promise<void> {
    await (await this.client()).platformAuditLog.create({
      data: { action, actorAdminId, targetTenantId: targetTenantId ?? null, ...(metadata ? { metadata } : {}) },
    });
  }

  // ───────────── Google ─────────────

  async findUserByGoogleSubject(subject: string): Promise<LoginUser | null> {
    const identity = await (await this.client()).userIdentity.findUnique({
      where: { provider_providerSubject: { provider: 'GOOGLE', providerSubject: subject } },
      select: { id: true, user: { select: USER_SELECT } },
    });
    if (!identity) return null;
    await (await this.client()).userIdentity.update({ where: { id: identity.id }, data: { lastUsedAt: new Date() } });
    return identity.user;
  }

  /** Привязка Google к существующему аккаунту. false — у аккаунта уже другая привязка Google. */
  async linkGoogle(userId: string, subject: string, email: string): Promise<boolean> {
    try {
      await (await this.client()).userIdentity.create({
        data: { userId, provider: 'GOOGLE', providerSubject: subject, emailAtLink: email, lastUsedAt: new Date() },
      });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return false;
      throw error;
    }
  }

  // ───────────── Компании человека ─────────────

  /** Только активные участия в активных компаниях (политика membership_self_read). */
  async listCompanies(userId: string): Promise<CompanyEntry[]> {
    const rows = await this.runAsUser(userId, tx => tx.membership.findMany({
      where: { userId, isActive: true, tenant: { status: 'ACTIVE' } },
      select: { role: true, tenant: { select: { slug: true, displayName: true } } },
      orderBy: { tenant: { displayName: 'asc' } },
    }));
    return rows.map(r => ({ slug: r.tenant.slug, displayName: r.tenant.displayName, role: r.role }));
  }

  async findActiveTenantBySlug(slug: string) {
    const tenant = await (await this.client()).tenant.findUnique({ where: { slug }, select: { id: true, slug: true, displayName: true, status: true } });
    return tenant?.status === 'ACTIVE' ? tenant : null;
  }

  // ───────────── Сессии: создание, проверка, ротация ─────────────

  async createSession(kind: 'app' | 'platform', data: NewSession): Promise<string> {
    const client = await this.client();
    return (await this.delegate(client as unknown as Tx, kind).create({ data: this.rowData(kind, data), select: { id: true } })).id;
  }

  private rowData(kind: SessionKind, data: NewSession & { tenantId?: string; userSessionId?: string }) {
    const { ownerId, ...rest } = data;
    return { ...rest, [OWNER_FIELD[kind]]: ownerId };
  }

  /** Сессия центрального входа действительна и аккаунт активен. */
  async validAppSession(sessionId: string, userId: string): Promise<AccountState | null> {
    const now = new Date();
    const row = await (await this.client()).userSession.findFirst({
      where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now }, user: { isActive: true } },
      select: { user: { select: { passwordChangeRequired: true, locale: true } } },
    });
    return row ? { passwordChangeRequired: row.user.passwordChangeRequired, mfaSetupRequired: false, locale: row.user.locale } : null;
  }

  /** Сессия платформы действительна; ограничения: смена временного пароля, затем настройка второго фактора (B2, B8). */
  async validPlatformSession(sessionId: string, adminId: string): Promise<AccountState | null> {
    const now = new Date();
    const row = await (await this.client()).platformSession.findFirst({
      where: { id: sessionId, adminId, revokedAt: null, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now }, admin: { isActive: true } },
      select: { admin: { select: { passwordChangeRequired: true, totpEnabledAt: true, locale: true } } },
    });
    return row ? { passwordChangeRequired: row.admin.passwordChangeRequired, mfaSetupRequired: row.admin.totpEnabledAt === null, locale: row.admin.locale } : null;
  }

  /**
   * Сессия компании действительна: не отозвана и не истекла, участие в ЭТОЙ компании активно, аккаунт активен.
   * Возвращает актуальную роль из memberships (роль не хранится в токене).
   */
  async tenantSessionRole(tenantId: string, sessionId: string, userId: string): Promise<{ role: TenantRole; passwordChangeRequired: boolean; locale: Locale } | null> {
    const now = new Date();
    const row = await this.tenantDb.runInTenant(tenantId, tx => tx.tenantSession.findFirst({
      where: {
        id: sessionId, userId, tenantId, revokedAt: null, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now },
        membership: { isActive: true, user: { isActive: true } },
      },
      select: { membership: { select: { role: true, user: { select: { passwordChangeRequired: true, locale: true } } } } },
    }));
    return row ? { role: row.membership.role, passwordChangeRequired: row.membership.user.passwordChangeRequired, locale: row.membership.user.locale } : null;
  }

  async rotateAppOrPlatform(kind: 'app' | 'platform', tokenHash: string, next: (record: { familyId: string; absoluteExpiresAt: Date }) => Omit<NewSession, 'ownerId' | 'familyId' | 'absoluteExpiresAt'>, graceMs: number): Promise<RotationResult> {
    const client = await this.client();
    const result = await client.$transaction(tx => this.rotate(tx, kind, tokenHash, next, graceMs));
    if (result.status === 'reused-family') {
      await this.revokeFamily(kind, result.familyId, result.ownerId);
      return { status: 'reused' };
    }
    return result;
  }

  async rotateTenant(tenantId: string, tokenHash: string, next: (record: { familyId: string; absoluteExpiresAt: Date }) => Omit<NewSession, 'ownerId' | 'familyId' | 'absoluteExpiresAt'>, graceMs: number): Promise<RotationResult> {
    const result = await this.tenantDb.runInTenant(tenantId, tx => this.rotate(tx, 'tenant', tokenHash, next, graceMs, tenantId));
    if (result.status === 'reused-family') {
      await this.revokeFamily('tenant', result.familyId, result.ownerId);
      return { status: 'reused' };
    }
    return result;
  }

  /**
   * Ротация refresh-токена в одной транзакции. Старая запись «захватывается» условным UPDATE ... RETURNING
   * (rotated_at IS NULL), поэтому из двух одновременных запросов обновится только один.
   */
  private async rotate(tx: Tx, kind: SessionKind, tokenHash: string,
    next: (record: { familyId: string; absoluteExpiresAt: Date }) => Omit<NewSession, 'ownerId' | 'familyId' | 'absoluteExpiresAt'>,
    graceMs: number, tenantId?: string,
  ): Promise<RotationResult | { status: 'reused-family'; familyId: string; ownerId: string }> {
    const sessions = this.delegate(tx, kind);
    const now = new Date();
    const claimed = await sessions.updateManyAndReturn({
      where: { tokenHash, rotatedAt: null, revokedAt: null, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now } },
      data: { rotatedAt: now, lastUsedAt: now },
    });
    const old = claimed[0];
    if (old) {
      const ownerId = (old.userId ?? old.adminId) as string;
      const fresh = next({ familyId: old.familyId, absoluteExpiresAt: old.absoluteExpiresAt });
      const expiresAt = fresh.expiresAt < old.absoluteExpiresAt ? fresh.expiresAt : old.absoluteExpiresAt;
      const data: Record<string, unknown> = this.rowData(kind, {
        ownerId, tokenHash: fresh.tokenHash, familyId: old.familyId, expiresAt, absoluteExpiresAt: old.absoluteExpiresAt,
      });
      if (kind === 'tenant') { data.tenantId = tenantId; data.userSessionId = old.userSessionId; }
      const created = await sessions.create({ data, select: { id: true } });
      return {
        status: 'rotated', ownerId, sessionId: created.id, familyId: old.familyId,
        ...(old.userSessionId ? { userSessionId: old.userSessionId } : {}),
      };
    }
    const existing = await sessions.findUnique({ where: { tokenHash } });
    if (!existing || existing.revokedAt) return { status: 'invalid' };
    if (existing.rotatedAt) {
      if (now.getTime() - existing.rotatedAt.getTime() <= graceMs) return { status: 'retry' };
      return { status: 'reused-family', familyId: existing.familyId, ownerId: (existing.userId ?? existing.adminId) as string };
    }
    return { status: 'invalid' }; // истекла
  }

  /** Сессия по refresh-токену (для logout, когда access-токен уже истёк). */
  async findSessionByToken(kind: SessionKind, tokenHash: string, tenantId?: string): Promise<{ id: string; ownerId: string; familyId: string } | null> {
    const find = (tx: Tx) => this.delegate(tx, kind).findUnique({ where: { tokenHash } });
    const row = kind === 'tenant'
      ? await this.tenantDb.runInTenant(tenantId as string, find)
      : await find((await this.client()) as unknown as Tx);
    if (!row) return null;
    return { id: row.id, ownerId: (row.userId ?? row.adminId) as string, familyId: row.familyId };
  }

  // ───────────── Отзыв ─────────────

  /**
   * Отзывает цепочку сессий. Для центрального входа — вместе со всеми сессиями компаний, открытыми из неё.
   * ownerId — владелец (для контекста app.user_id при отзыве сессий компаний).
   */
  async revokeFamily(kind: SessionKind, familyId: string, ownerId: string): Promise<void> {
    const now = new Date();
    if (kind === 'platform') {
      await (await this.client()).platformSession.updateMany({ where: { familyId, revokedAt: null }, data: { revokedAt: now } });
      return;
    }
    await this.runAsUser(ownerId, async tx => {
      if (kind === 'app') {
        await tx.userSession.updateMany({ where: { familyId, userId: ownerId, revokedAt: null }, data: { revokedAt: now } });
        await tx.tenantSession.updateMany({ where: { userId: ownerId, userSession: { familyId }, revokedAt: null }, data: { revokedAt: now } });
      } else {
        await tx.tenantSession.updateMany({ where: { familyId, userId: ownerId, revokedAt: null }, data: { revokedAt: now } });
      }
    });
  }

  /** Полный выход в браузере из компании: сессия компании, родительская центральная сессия и все её сессии компаний. */
  async revokeTenantLogout(userId: string, tenantSessionId: string): Promise<void> {
    const now = new Date();
    await this.runAsUser(userId, async tx => {
      const current = await tx.tenantSession.findFirst({
        where: { id: tenantSessionId, userId }, select: { familyId: true, userSession: { select: { familyId: true } } },
      });
      if (!current) return;
      await tx.tenantSession.updateMany({ where: { familyId: current.familyId, userId, revokedAt: null }, data: { revokedAt: now } });
      await tx.userSession.updateMany({ where: { familyId: current.userSession.familyId, userId, revokedAt: null }, data: { revokedAt: now } });
      await tx.tenantSession.updateMany({ where: { userId, userSession: { familyId: current.userSession.familyId }, revokedAt: null }, data: { revokedAt: now } });
    });
  }

  /** Отзыв всех сессий человека, кроме цепочки keepUserFamilyId (текущий браузер) и её сессий компаний. */
  async revokeAllUserSessions(userId: string, keepUserFamilyId?: string): Promise<void> {
    const now = new Date();
    await this.runAsUser(userId, async tx => {
      const keep = keepUserFamilyId ? { NOT: { familyId: keepUserFamilyId } } : {};
      await tx.userSession.updateMany({ where: { userId, revokedAt: null, ...keep }, data: { revokedAt: now } });
      const keepChildren = keepUserFamilyId ? { NOT: { userSession: { familyId: keepUserFamilyId } } } : {};
      await tx.tenantSession.updateMany({ where: { userId, revokedAt: null, ...keepChildren }, data: { revokedAt: now } });
    });
  }

  async revokeAllPlatformSessions(adminId: string, keepFamilyId?: string): Promise<void> {
    const keep = keepFamilyId ? { NOT: { familyId: keepFamilyId } } : {};
    await (await this.client()).platformSession.updateMany({ where: { adminId, revokedAt: null, ...keep }, data: { revokedAt: new Date() } });
  }

  async userSessionFamily(sessionId: string): Promise<string | null> {
    return (await (await this.client()).userSession.findUnique({ where: { id: sessionId }, select: { familyId: true } }))?.familyId ?? null;
  }

  async platformSessionFamily(sessionId: string): Promise<string | null> {
    return (await (await this.client()).platformSession.findUnique({ where: { id: sessionId }, select: { familyId: true } }))?.familyId ?? null;
  }

  /** Цепочка центральной сессии, из которой открыта сессия компании. */
  async parentFamilyOfTenantSession(tenantId: string, tenantSessionId: string): Promise<string | null> {
    const row = await this.tenantDb.runInTenant(tenantId, tx => tx.tenantSession.findUnique({
      where: { id: tenantSessionId }, select: { userSession: { select: { familyId: true } } },
    }));
    return row?.userSession.familyId ?? null;
  }

  // ───────────── Переход app → компания (A6) ─────────────

  async createHandoff(data: { userId: string; tenantId: string; userSessionId: string; codeHash: string; stateHash: string; expiresAt: Date }): Promise<void> {
    const client = await this.client();
    await client.loginHandoff.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await client.loginHandoff.create({ data });
  }

  /**
   * Обмен кода на сессию компании в одной транзакции компании: код одноразовый (условный UPDATE used_at),
   * не истёк, выдан для этой компании и этого state; центральная сессия ещё действует; участие и аккаунт активны.
   * Возвращает userId или null — без уточнения причины.
   */
  async consumeHandoff(tenantId: string, codeHash: string, stateHash: string, session: (userId: string) => Omit<NewSession, 'ownerId'>): Promise<{ userId: string; sessionId: string } | null> {
    return this.tenantDb.runInTenant(tenantId, async tx => {
      const now = new Date();
      const claimed = await tx.loginHandoff.updateManyAndReturn({
        where: { codeHash, stateHash, tenantId, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      const handoff = claimed[0];
      if (!handoff) return null;
      const parent = await tx.userSession.findFirst({
        where: { id: handoff.userSessionId, userId: handoff.userId, revokedAt: null, expiresAt: { gt: now }, absoluteExpiresAt: { gt: now }, user: { isActive: true } },
        select: { id: true },
      });
      if (!parent) return null;
      const membership = await tx.membership.findFirst({ where: { tenantId, userId: handoff.userId, isActive: true }, select: { id: true } });
      if (!membership) return null;
      const data = session(handoff.userId);
      const created = await tx.tenantSession.create({
        data: { ...data, tenantId, userId: handoff.userId, userSessionId: handoff.userSessionId },
        select: { id: true },
      });
      return { userId: handoff.userId, sessionId: created.id };
    });
  }

  // ───────────── Ограничение входа (A9) ─────────────

  /** Текущее значение счётчика в окне; 0, если окно истекло. */
  async throttleCount(keyHash: string, windowMs: number): Promise<number> {
    const row = await (await this.client()).authThrottle.findUnique({ where: { keyHash } });
    if (!row || row.windowStart.getTime() < Date.now() - windowMs) return 0;
    return row.count;
  }

  /** Атомарно увеличивает счётчик; истёкшее окно начинается заново. */
  async throttleHit(keyHash: string, windowMs: number): Promise<number> {
    const client = await this.client();
    const seconds = Math.round(windowMs / 1000);
    const rows = await client.$queryRaw<{ count: number }[]>`
      INSERT INTO auth_throttle (key_hash, window_start, count) VALUES (${keyHash}, now(), 1)
      ON CONFLICT (key_hash) DO UPDATE SET
        count = CASE WHEN auth_throttle.window_start < now() - make_interval(secs => ${seconds}) THEN 1 ELSE auth_throttle.count + 1 END,
        window_start = CASE WHEN auth_throttle.window_start < now() - make_interval(secs => ${seconds}) THEN now() ELSE auth_throttle.window_start END
      RETURNING count`;
    return rows[0]?.count ?? 1;
  }

  async throttleReset(keyHash: string): Promise<void> {
    await (await this.client()).authThrottle.deleteMany({ where: { keyHash } });
  }
}
