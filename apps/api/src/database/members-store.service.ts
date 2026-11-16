import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { TenantRole } from '../tenancy/request-context.js';
import { DatabaseService } from './database.service.js';
import { TenantDb } from './tenant-db.service.js';

/**
 * Участники компании и приглашения (Phase 5: 5.2, 5.3, C2–C8).
 *
 * Операции администратора компании — в транзакции его компании (RLS). Принятие приглашения по ссылке —
 * в контексте app.invite_token_hash: политика invitation_by_token даёт доступ ровно к одной строке,
 * а затем в той же транзакции включается контекст компании этого приглашения, чтобы создать участие.
 */

type Tx = Prisma.TransactionClient;

export interface MemberRow { userId: string; name: string; email: string; role: TenantRole; isActive: boolean }
export interface InvitationRow { id: string; email: string; name: string; role: TenantRole; expiresAt: Date; createdAt: Date }
export interface InvitationInfo {
  id: string; tenantId: string; tenantSlug: string; tenantName: string; tenantActive: boolean;
  email: string; name: string; role: TenantRole; open: boolean;
}
export type NewMemberAccount =
  | { kind: 'existing'; userId: string }
  | { kind: 'new'; name: string; passwordHash: string | null; googleSubject?: string };

export class MemberRuleError extends Error {
  constructor(readonly reason: 'self' | 'last-admin' | 'not-found') { super(reason); this.name = 'MemberRuleError'; }
}

@Injectable()
export class MembersStore {
  constructor(private readonly database: DatabaseService, private readonly tenantDb: TenantDb) {}

  // ───────────── Администратор компании ─────────────

  async list(tenantId: string): Promise<{ members: MemberRow[]; invitations: InvitationRow[] }> {
    return this.tenantDb.runInTenant(tenantId, async tx => {
      const memberships = await tx.membership.findMany({
        select: { userId: true, role: true, isActive: true, user: { select: { name: true, email: true } } },
        orderBy: { createdAt: 'asc' },
      });
      const invitations = await tx.invitation.findMany({
        where: { acceptedAt: null, revokedAt: null },
        select: { id: true, email: true, name: true, role: true, expiresAt: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
      });
      return {
        members: memberships.map(m => ({ userId: m.userId, name: m.user.name, email: m.user.email, role: m.role, isActive: m.isActive })),
        invitations,
      };
    });
  }

  /** Имя участника компании для текста письма («Анна приглашает вас…»). */
  async memberName(tenantId: string, userId: string): Promise<string> {
    return this.tenantDb.runInTenant(tenantId, async tx =>
      (await tx.membership.findUnique({ where: { tenantId_userId: { tenantId, userId } }, select: { user: { select: { name: true } } } }))?.user.name ?? '');
  }

  async invitationsSince(tenantId: string, since: Date): Promise<number> {
    return this.tenantDb.runInTenant(tenantId, tx => tx.invitation.count({ where: { createdAt: { gte: since } } }));
  }

  /** Активный участник компании с этим email (видно администратору в списке, поэтому не тайна внутри компании). */
  async isActiveMember(tenantId: string, email: string): Promise<boolean> {
    return this.tenantDb.runInTenant(tenantId, async tx => (await tx.membership.count({ where: { isActive: true, user: { email } } })) > 0);
  }

  /** Новое приглашение; открытое приглашение на тот же email отзывается в той же транзакции (C8). */
  createInvitation(tenantId: string, data: { email: string; name: string; role: TenantRole; tokenHash: string; expiresAt: Date; invitedById: string | null }): Promise<string> {
    return this.tenantDb.runInTenant(tenantId, tx => this.insertInvitation(tx, tenantId, data));
  }

  /** То же внутри уже открытой транзакции компании (создание компании платформой, C3). */
  async insertInvitation(tx: Tx, tenantId: string, data: { email: string; name: string; role: TenantRole; tokenHash: string; expiresAt: Date; invitedById: string | null }): Promise<string> {
    await tx.invitation.updateMany({ where: { email: data.email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    const created = await tx.invitation.create({ data: { tenantId, ...data }, select: { id: true } });
    await tx.tenantAuditLog.create({
      data: { tenantId, actorUserId: data.invitedById, action: 'invitation.created', entityType: 'invitation', entityId: created.id, metadata: { role: data.role } },
    });
    return created.id;
  }

  /** Повторная отправка: новая ссылка и срок, старая ссылка перестаёт работать. */
  async reissueInvitation(tenantId: string, id: string, tokenHash: string, expiresAt: Date, actorUserId: string | null): Promise<{ email: string; name: string } | null> {
    return this.tenantDb.runInTenant(tenantId, async tx => {
      const rows = await tx.invitation.updateManyAndReturn({
        where: { id, acceptedAt: null, revokedAt: null }, data: { tokenHash, expiresAt },
      });
      const row = rows[0];
      if (!row) return null;
      await tx.tenantAuditLog.create({ data: { tenantId, actorUserId, action: 'invitation.resent', entityType: 'invitation', entityId: id } });
      return { email: row.email, name: row.name };
    });
  }

  async revokeInvitation(tenantId: string, id: string, actorUserId: string): Promise<boolean> {
    return this.tenantDb.runInTenant(tenantId, async tx => {
      const { count } = await tx.invitation.updateMany({ where: { id, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
      if (count === 1) await tx.tenantAuditLog.create({ data: { tenantId, actorUserId, action: 'invitation.revoked', entityType: 'invitation', entityId: id } });
      return count === 1;
    });
  }

  /**
   * Смена роли и включение/отключение участия (5.3) с правилами C5 в одной транзакции:
   * нельзя менять себя, нельзя оставить компанию без активного администратора.
   * При отключении отзываются сессии человека в ЭТОЙ компании (C6).
   */
  async updateMember(tenantId: string, actorUserId: string, userId: string, changes: { role?: TenantRole; isActive?: boolean }): Promise<MemberRow> {
    if (userId === actorUserId) throw new MemberRuleError('self');
    return this.tenantDb.runInTenant(tenantId, async tx => {
      // Блокировка строк администраторов: два параллельных понижения не оставят компанию без администратора.
      await tx.$queryRaw`SELECT 1 FROM memberships WHERE role = 'TENANT_ADMIN' AND is_active FOR UPDATE`;
      const current = await tx.membership.findUnique({
        where: { tenantId_userId: { tenantId, userId } },
        select: { role: true, isActive: true, user: { select: { name: true, email: true } } },
      });
      if (!current) throw new MemberRuleError('not-found');
      const role = changes.role ?? current.role;
      const isActive = changes.isActive ?? current.isActive;
      const losesAdmin = current.role === 'TENANT_ADMIN' && current.isActive && (role !== 'TENANT_ADMIN' || !isActive);
      if (losesAdmin) {
        const admins = await tx.membership.count({ where: { role: 'TENANT_ADMIN', isActive: true } });
        if (admins <= 1) throw new MemberRuleError('last-admin');
      }
      await tx.membership.update({ where: { tenantId_userId: { tenantId, userId } }, data: { role, isActive } });
      if (current.isActive && !isActive) {
        await tx.tenantSession.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      }
      const actions: string[] = [];
      if (role !== current.role) actions.push('membership.role_changed');
      if (isActive !== current.isActive) actions.push(isActive ? 'membership.enabled' : 'membership.disabled');
      for (const action of actions) {
        await tx.tenantAuditLog.create({
          data: { tenantId, actorUserId, action, entityType: 'membership', entityId: userId, metadata: action === 'membership.role_changed' ? { from: current.role, to: role } : {} },
        });
      }
      return { userId, name: current.user.name, email: current.user.email, role, isActive };
    });
  }

  // ───────────── Приглашение по ссылке (C2, C10) ─────────────

  private inToken<T>(tokenHash: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.database.assertRuntimeRole().then(() => this.database.client.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('app.invite_token_hash', ${tokenHash}, true)`;
      return fn(tx);
    }));
  }

  /** Что видит человек по ссылке: компания, email и имя из приглашения. null — ссылки нет. */
  async inspect(tokenHash: string): Promise<InvitationInfo | null> {
    return this.inToken(tokenHash, async tx => {
      const inv = await tx.invitation.findUnique({
        where: { tokenHash },
        select: { id: true, tenantId: true, email: true, name: true, role: true, expiresAt: true, acceptedAt: true, revokedAt: true, tenant: { select: { slug: true, displayName: true, status: true } } },
      });
      if (!inv) return null;
      return {
        id: inv.id, tenantId: inv.tenantId, tenantSlug: inv.tenant.slug, tenantName: inv.tenant.displayName, tenantActive: inv.tenant.status === 'ACTIVE',
        email: inv.email, name: inv.name, role: inv.role,
        open: inv.acceptedAt === null && inv.revokedAt === null && inv.expiresAt > new Date(),
      };
    });
  }

  /**
   * Принятие одной транзакцией: приглашение «захватывается» условным UPDATE (одноразовость), затем — в контексте
   * компании приглашения — создаётся или включается участие с ролью из приглашения. Для нового человека
   * создаётся аккаунт с подтверждённым email (он получил письмо). Возвращает userId или null без уточнения причины.
   */
  async accept(tokenHash: string, account: NewMemberAccount, inviteEmail: string): Promise<{ userId: string; tenantSlug: string } | null> {
    return this.inToken(tokenHash, async tx => {
      const now = new Date();
      const claimed = await tx.invitation.updateManyAndReturn({
        where: { tokenHash, email: inviteEmail, acceptedAt: null, revokedAt: null, expiresAt: { gt: now }, tenant: { status: 'ACTIVE' } },
        data: { acceptedAt: now },
      });
      const inv = claimed[0];
      if (!inv) return null;

      let userId: string;
      if (account.kind === 'existing') {
        const user = await tx.user.findUnique({ where: { id: account.userId }, select: { email: true, isActive: true } });
        if (!user || !user.isActive || user.email !== inv.email) return null; // принять может только аккаунт с тем же email
        userId = account.userId;
        await tx.user.updateMany({ where: { id: userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
      } else {
        if (await tx.user.findUnique({ where: { email: inv.email }, select: { id: true } })) return null; // аккаунт появился — нужен вход
        userId = (await tx.user.create({
          data: { email: inv.email, name: account.name, passwordHash: account.passwordHash, emailVerifiedAt: now },
          select: { id: true },
        })).id;
        if (account.googleSubject) {
          await tx.userIdentity.create({ data: { userId, provider: 'GOOGLE', providerSubject: account.googleSubject, emailAtLink: inv.email, lastUsedAt: now } });
        }
      }

      await tx.$queryRaw`SELECT set_config('app.tenant_id', ${inv.tenantId}, true)`;
      await tx.membership.upsert({
        where: { tenantId_userId: { tenantId: inv.tenantId, userId } },
        create: { tenantId: inv.tenantId, userId, role: inv.role },
        update: { role: inv.role, isActive: true },
      });
      await tx.tenantAuditLog.create({ data: { tenantId: inv.tenantId, actorUserId: userId, action: 'invitation.accepted', entityType: 'invitation', entityId: inv.id } });
      const tenant = await tx.tenant.findUniqueOrThrow({ where: { id: inv.tenantId }, select: { slug: true } });
      return { userId, tenantSlug: tenant.slug };
    });
  }
}
