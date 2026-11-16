import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { TenantDb } from './tenant-db.service.js';

/**
 * Данные для администратора платформы (Phase 4, решения B3–B7).
 *
 * Здесь намеренно НЕТ методов чтения лидов, истории, аудита компании и списка участников:
 * администратор платформы видит о компании только её настройки и ЧИСЛО активных участников (B6).
 * Операции с таблицами компании (первое участие, отзыв сессий) выполняются в контексте целевой компании (runInTenant).
 */

export interface TenantRow {
  id: string; slug: string; name: string; displayName: string; status: 'ACTIVE' | 'SUSPENDED';
  createdAt: Date; updatedAt: Date; activeMembers: number;
}

export interface NewTenant {
  slug: string; name: string; displayName: string;
  admin: { email: string; name: string };
  /** Хеш временного пароля и срок — если для первого администратора нужен новый аккаунт (B3, B8). */
  newAccount: { passwordHash: string; tempPasswordExpiresAt: Date };
}

export class SlugTakenError extends Error {
  constructor() { super('Slug is already taken'); this.name = 'SlugTakenError'; }
}

const TENANT_SELECT = { id: true, slug: true, name: true, displayName: true, status: true, createdAt: true, updatedAt: true } as const;

@Injectable()
export class PlatformStore {
  constructor(private readonly database: DatabaseService, private readonly tenantDb: TenantDb) {}

  private async client() {
    await this.database.assertRuntimeRole();
    return this.database.client;
  }

  /** Число активных участников — в контексте каждой компании (memberships под RLS). Только число, без записей. */
  private activeMembers(tenantId: string): Promise<number> {
    return this.tenantDb.runInTenant(tenantId, tx => tx.membership.count({ where: { isActive: true } }));
  }

  async listTenants(): Promise<TenantRow[]> {
    const tenants = await (await this.client()).tenant.findMany({ select: TENANT_SELECT, orderBy: { createdAt: 'desc' } });
    return Promise.all(tenants.map(async t => ({ ...t, activeMembers: await this.activeMembers(t.id) })));
  }

  async getTenant(id: string): Promise<TenantRow | null> {
    const tenant = await (await this.client()).tenant.findUnique({ where: { id }, select: TENANT_SELECT });
    return tenant ? { ...tenant, activeMembers: await this.activeMembers(tenant.id) } : null;
  }

  /**
   * Компания и её первый администратор в ОДНОЙ транзакции: при любой ошибке не остаётся компании без администратора.
   * Существующий аккаунт (по email) получает участие; иначе создаётся аккаунт с временным паролем.
   */
  async createTenant(input: NewTenant, actorAdminId: string): Promise<{ tenant: TenantRow; existingAccount: boolean; adminName: string }> {
    const client = await this.client();
    try {
      return await client.$transaction(async tx => {
        const tenant = await tx.tenant.create({
          data: { slug: input.slug, name: input.name, displayName: input.displayName }, select: TENANT_SELECT,
        });
        let user = await tx.user.findUnique({ where: { email: input.admin.email }, select: { id: true, name: true } });
        const existingAccount = user !== null;
        user ??= await tx.user.create({
          data: {
            email: input.admin.email, name: input.admin.name, passwordHash: input.newAccount.passwordHash,
            passwordChangeRequired: true, tempPasswordExpiresAt: input.newAccount.tempPasswordExpiresAt,
          },
          select: { id: true, name: true },
        });
        // Участие — запись компании: контекст компании внутри той же транзакции (RLS WITH CHECK).
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
        await tx.membership.create({ data: { tenantId: tenant.id, userId: user.id, role: 'TENANT_ADMIN' } });
        await tx.tenantAuditLog.create({ data: { tenantId: tenant.id, action: 'membership.created_by_platform', entityType: 'membership' } });
        await tx.platformAuditLog.create({
          data: { action: 'tenant.created', actorAdminId, targetTenantId: tenant.id, metadata: { firstAdmin: existingAccount ? 'existing-account' : 'new-account' } },
        });
        return { tenant: { ...tenant, activeMembers: 1 }, existingAccount, adminName: user.name };
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new SlugTakenError();
      throw error;
    }
  }

  /**
   * Изменение названий и статуса (B4, B5). При отключении — в той же транзакции отзыв всех сессий компании
   * и неиспользованных кодов перехода в неё. Возвращает список изменённых полей для аудита.
   */
  async updateTenant(id: string, changes: { name?: string; displayName?: string; status?: 'ACTIVE' | 'SUSPENDED' }, actorAdminId: string): Promise<TenantRow | null> {
    const client = await this.client();
    const updated = await client.$transaction(async tx => {
      const before = await tx.tenant.findUnique({ where: { id }, select: TENANT_SELECT });
      if (!before) return null;
      const changed = (Object.keys(changes) as (keyof typeof changes)[]).filter(k => changes[k] !== undefined && changes[k] !== before[k]);
      if (changed.length === 0) return before;
      const after = await tx.tenant.update({ where: { id }, data: changes, select: TENANT_SELECT });
      if (changes.status === 'SUSPENDED' && before.status !== 'SUSPENDED') {
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${id}, true)`;
        await tx.tenantSession.updateMany({ where: { tenantId: id, revokedAt: null }, data: { revokedAt: new Date() } });
        await tx.loginHandoff.deleteMany({ where: { tenantId: id, usedAt: null } });
      }
      const action = changes.status && changes.status !== before.status
        ? (changes.status === 'SUSPENDED' ? 'tenant.suspended' : 'tenant.activated')
        : 'tenant.updated';
      await tx.platformAuditLog.create({ data: { action, actorAdminId, targetTenantId: id, metadata: { fields: changed } } });
      return after;
    });
    return updated ? { ...updated, activeMembers: await this.activeMembers(id) } : null;
  }
}
