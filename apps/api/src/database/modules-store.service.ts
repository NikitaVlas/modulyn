import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { MODULES, type ModuleKey } from '../modules/registry.js';
import { DatabaseService } from './database.service.js';
import { TenantDb } from './tenant-db.service.js';

type Tx = Prisma.TransactionClient;

export interface TenantModuleState { key: ModuleKey; name: string; description: string; enabled: boolean }

/**
 * Модули компаний (Phase 6). tenant_modules — под RLS: чтение и изменение только в транзакции компании.
 * Модуль считается включённым, только если он есть в реестре кода, в каталоге БД и включён для компании.
 */
@Injectable()
export class ModulesStore {
  constructor(private readonly database: DatabaseService, private readonly tenantDb: TenantDb) {}

  /** Ключи каталога БД — для сверки с реестром при старте (M1). */
  async catalogKeys(): Promise<string[]> {
    await this.database.assertRuntimeRole();
    return (await this.database.client.module.findMany({ select: { key: true } })).map(m => m.key);
  }

  /** Включённые модули компании (для guard и меню). */
  async enabledKeys(tenantId: string): Promise<ModuleKey[]> {
    const rows = await this.tenantDb.runInTenant(tenantId, tx => tx.tenantModule.findMany({
      where: { enabled: true }, select: { module: { select: { key: true } } },
    }));
    const keys = new Set(rows.map(r => r.module.key));
    return MODULES.filter(m => keys.has(m.key)).map(m => m.key);
  }

  async isEnabled(tenantId: string, key: ModuleKey): Promise<boolean> {
    return this.tenantDb.runInTenant(tenantId, async tx =>
      (await tx.tenantModule.count({ where: { enabled: true, module: { key } } })) > 0);
  }

  /** Состояние всех модулей реестра для карточки компании на платформе. */
  async stateForTenant(tenantId: string): Promise<TenantModuleState[]> {
    const enabled = new Set(await this.enabledKeys(tenantId));
    return MODULES.map(m => ({ key: m.key, name: m.name, description: m.description, enabled: enabled.has(m.key) }));
  }

  /**
   * Включение или отключение модуля компании (6.2). Данные модуля не трогаются (M5).
   * false — модуля нет в каталоге БД (нельзя включить то, чего нет).
   */
  async setEnabled(tenantId: string, key: ModuleKey, enabled: boolean, actorAdminId: string): Promise<boolean> {
    await this.database.assertRuntimeRole();
    const client = this.database.client;
    const module = await client.module.findUnique({ where: { key }, select: { id: true } });
    if (!module) return false;
    await this.tenantDb.runInTenant(tenantId, async tx => {
      const before = await tx.tenantModule.findUnique({ where: { tenantId_moduleId: { tenantId, moduleId: module.id } }, select: { enabled: true } });
      if ((before?.enabled ?? false) === enabled) return;
      await tx.tenantModule.upsert({
        where: { tenantId_moduleId: { tenantId, moduleId: module.id } },
        create: { tenantId, moduleId: module.id, enabled }, update: { enabled },
      });
      const action = enabled ? 'module.enabled' : 'module.disabled';
      await tx.tenantAuditLog.create({ data: { tenantId, action, entityType: 'module', metadata: { module: key } } });
      await tx.platformAuditLog.create({ data: { action, actorAdminId, targetTenantId: tenantId, metadata: { module: key } } });
    });
    return true;
  }

  /** M3: модули по умолчанию для новой компании — внутри транзакции её создания (контекст компании уже установлен). */
  async enableDefaults(tx: Tx, tenantId: string): Promise<void> {
    const keys = MODULES.filter(m => m.enabledForNewTenants).map(m => m.key as string);
    const modules = await tx.module.findMany({ where: { key: { in: keys } }, select: { id: true } });
    if (modules.length > 0) {
      await tx.tenantModule.createMany({ data: modules.map(m => ({ tenantId, moduleId: m.id, enabled: true })) });
    }
  }
}
