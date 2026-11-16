import { Injectable } from '@nestjs/common';
import type { TenantRef } from '../tenancy/request-context.js';
import { DatabaseService } from './database.service.js';

/**
 * Справочник компаний для разбора hostname (подшаг 2.3).
 * Таблица tenants не под RLS: она нужна до появления контекста. Runtime-роль может её только читать.
 * Отключённая компания возвращается как null — так же, как несуществующая (D9).
 */
@Injectable()
export class TenantDirectory {
  constructor(private readonly database: DatabaseService) {}

  async findActiveBySlug(slug: string): Promise<TenantRef | null> {
    await this.database.assertRuntimeRole();
    const tenant = await this.database.client.tenant.findUnique({
      where: { slug },
      select: { id: true, slug: true, displayName: true, status: true },
    });
    if (!tenant || tenant.status !== 'ACTIVE') return null;
    return { tenantId: tenant.id, slug: tenant.slug, displayName: tenant.displayName };
  }
}
