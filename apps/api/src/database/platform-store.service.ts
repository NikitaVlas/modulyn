import { Injectable } from '@nestjs/common';
import { DatabaseService } from './database.service.js';
import { ModulesStore } from './modules-store.service.js';
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
  /** C3: приглашение первому администратору (вместо временного пароля B3). */
  admin: { email: string; name: string; tokenHash: string; expiresAt: Date };
}

export class SlugTakenError extends Error {
  constructor() { super('Slug is already taken'); this.name = 'SlugTakenError'; }
}

const TENANT_SELECT = { id: true, slug: true, name: true, displayName: true, status: true, createdAt: true, updatedAt: true } as const;

@Injectable()
export class PlatformStore {
  constructor(private readonly database: DatabaseService, private readonly tenantDb: TenantDb, private readonly modules: ModulesStore) {}

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
   * Компания и приглашение её первому администратору в ОДНОЙ транзакции (C3). Аккаунт и участие появятся,
   * когда человек примет приглашение; платформа не узнаёт, был ли у него аккаунт (C2).
   */
  async createTenant(input: NewTenant, actorAdminId: string): Promise<{ tenant: TenantRow }> {
    const client = await this.client();
    try {
      return await client.$transaction(async tx => {
        const tenant = await tx.tenant.create({
          data: { slug: input.slug, name: input.name, displayName: input.displayName }, select: TENANT_SELECT,
        });
        // Приглашение — запись компании: контекст компании внутри той же транзакции (RLS WITH CHECK).
        await tx.$queryRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;
        const invitation = await tx.invitation.create({
          data: { tenantId: tenant.id, email: input.admin.email, name: input.admin.name, role: 'TENANT_ADMIN', tokenHash: input.admin.tokenHash, expiresAt: input.admin.expiresAt },
          select: { id: true },
        });
        await tx.tenantAuditLog.create({ data: { tenantId: tenant.id, action: 'invitation.created_by_platform', entityType: 'invitation', entityId: invitation.id } });
        await this.modules.enableDefaults(tx, tenant.id); // M3: «Заявки» включены сразу
        await tx.platformAuditLog.create({ data: { action: 'tenant.created', actorAdminId, targetTenantId: tenant.id, metadata: { firstAdmin: 'invited' } } });
        return { tenant: { ...tenant, activeMembers: 0 } };
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw new SlugTakenError();
      throw error;
    }
  }

  /** Аудит приглашения администратора компании платформой (C4: например, если администраторов не осталось). */
  async auditAdminInvitation(tenantId: string, actorAdminId: string): Promise<void> {
    await (await this.client()).platformAuditLog.create({ data: { action: 'tenant.admin_invited', actorAdminId, targetTenantId: tenantId } });
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
