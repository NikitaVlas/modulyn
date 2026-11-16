import { Injectable } from '@nestjs/common';
import { TenantDb } from './tenant-db.service.js';

export const LEAD_STATUSES = ['NEW', 'IN_PROGRESS', 'CONTACTED', 'CONVERTED', 'CLOSED'] as const;
export type LeadStatusKey = (typeof LEAD_STATUSES)[number];

/**
 * Данные модуля «Заявки». Всё — в транзакции компании текущего запроса (TenantDb.run, RLS):
 * в запросах нет фильтра по tenant_id, и он не нужен — чужие строки PostgreSQL не вернёт.
 * Phase 6 — только сводка (M8); список, карточка и изменения — Phase 7.
 */
@Injectable()
export class LeadsStore {
  constructor(private readonly tenantDb: TenantDb) {}

  async summary(): Promise<{ total: number; byStatus: Record<LeadStatusKey, number> }> {
    const groups = await this.tenantDb.run(tx => tx.lead.groupBy({ by: ['status'], _count: { _all: true } }));
    const byStatus = Object.fromEntries(LEAD_STATUSES.map(s => [s, 0])) as Record<LeadStatusKey, number>;
    for (const g of groups) byStatus[g.status] = g._count._all;
    return { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus };
  }
}
