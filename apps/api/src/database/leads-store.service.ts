import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { requireTenant, type TenantRole } from '../tenancy/request-context.js';
import { TenantDb } from './tenant-db.service.js';

export const LEAD_STATUSES = ['NEW', 'IN_PROGRESS', 'CONTACTED', 'CONVERTED', 'CLOSED'] as const;
export type LeadStatusKey = (typeof LEAD_STATUSES)[number];

export interface LeadFilters {
  statuses: LeadStatusKey[];
  /** 'me' — назначенные на текущего пользователя; 'none' — без ответственного; иначе userId. */
  assignee: { kind: 'any' } | { kind: 'none' } | { kind: 'user'; userId: string };
  q: string | null;
  sort: 'created_desc' | 'created_asc';
  page: number;
  pageSize: number;
}

export interface PersonRow { userId: string; name: string }
export interface LeadRow {
  id: string; name: string; email: string | null; phone: string | null; source: 'WEB_FORM' | 'MANUAL';
  sourceDetail: string | null; status: LeadStatusKey; assignee: PersonRow | null; createdAt: Date;
}
export interface LeadDetailRow extends LeadRow {
  message: string | null; updatedAt: Date;
  history: { id: string; previousStatus: LeadStatusKey | null; newStatus: LeadStatusKey; changedBy: PersonRow | null; createdAt: Date }[];
}

export class LeadConflictError extends Error {
  constructor(readonly current: LeadStatusKey) { super('Lead status changed'); this.name = 'LeadConflictError'; }
}

const LIST_SELECT = {
  id: true, name: true, email: true, phone: true, source: true, sourceDetail: true, status: true, createdAt: true,
  assignedToId: true, assignee: { select: { user: { select: { name: true } } } },
} as const;

type ListRow = Prisma.LeadGetPayload<{ select: typeof LIST_SELECT }>;

function toRow(l: ListRow): LeadRow {
  return {
    id: l.id, name: l.name, email: l.email, phone: l.phone, source: l.source, sourceDetail: l.sourceDetail, status: l.status,
    assignee: l.assignedToId && l.assignee ? { userId: l.assignedToId, name: l.assignee.user.name } : null, createdAt: l.createdAt,
  };
}

/**
 * Данные модуля «Заявки» (Phase 6–7). Всё — в транзакции компании текущего запроса (TenantDb.run, RLS):
 * в запросах нет фильтра по tenant_id — чужие строки PostgreSQL не вернёт, а id чужой заявки ведёт себя как несуществующий.
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

  /** Список с фильтрами, сортировкой и страницами (7.2, L2). */
  async list(filters: LeadFilters): Promise<{ items: LeadRow[]; total: number }> {
    const where: Prisma.LeadWhereInput = {};
    if (filters.statuses.length > 0) where.status = { in: [...filters.statuses] };
    if (filters.assignee.kind === 'none') where.assignedToId = null;
    if (filters.assignee.kind === 'user') where.assignedToId = filters.assignee.userId;
    if (filters.q) {
      where.OR = [
        { name: { contains: filters.q, mode: 'insensitive' } },
        { email: { contains: filters.q, mode: 'insensitive' } },
        { phone: { contains: filters.q, mode: 'insensitive' } },
      ];
    }
    const direction = filters.sort === 'created_asc' ? 'asc' : 'desc';
    return this.tenantDb.run(async tx => {
      const [rows, total] = await Promise.all([
        tx.lead.findMany({
          where, select: LIST_SELECT, orderBy: [{ createdAt: direction }, { id: direction }],
          skip: (filters.page - 1) * filters.pageSize, take: filters.pageSize,
        }),
        tx.lead.count({ where }),
      ]);
      return { items: rows.map(toRow), total };
    });
  }

  /** Карточка с историей статусов (7.2). null — нет такой заявки в этой компании. */
  async get(id: string): Promise<LeadDetailRow | null> {
    return this.tenantDb.run(async tx => {
      const lead = await tx.lead.findUnique({
        where: { id },
        select: {
          ...LIST_SELECT, message: true, updatedAt: true,
          statusHistory: {
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, previousStatus: true, newStatus: true, createdAt: true, changedById: true, changedBy: { select: { user: { select: { name: true } } } } },
          },
        },
      });
      if (!lead) return null;
      return {
        ...toRow(lead), message: lead.message, updatedAt: lead.updatedAt,
        history: lead.statusHistory.map(h => ({
          id: h.id, previousStatus: h.previousStatus, newStatus: h.newStatus, createdAt: h.createdAt,
          changedBy: h.changedById && h.changedBy ? { userId: h.changedById, name: h.changedBy.user.name } : null,
        })),
      };
    });
  }

  /** Ручная заявка (L4): заявка и первая запись истории — одной транзакцией. */
  async create(data: { name: string; email: string | null; phone: string | null; message: string | null }, actorUserId: string): Promise<string> {
    const { tenantId } = requireTenant();
    return this.tenantDb.run(async tx => {
      const lead = await tx.lead.create({ data: { tenantId, ...data, source: 'MANUAL', status: 'NEW' }, select: { id: true } });
      await tx.leadStatusHistory.create({ data: { tenantId, leadId: lead.id, previousStatus: null, newStatus: 'NEW', changedById: actorUserId } });
      return lead.id;
    });
  }

  /**
   * Смена статуса (7.3, L1, L3): условный UPDATE «только если статус всё ещё from» и запись истории — одной транзакцией.
   * Статус без записи истории невозможен; из двух одновременных смен проходит одна, вторая получает конфликт.
   */
  async changeStatus(id: string, from: LeadStatusKey, to: LeadStatusKey, actorUserId: string): Promise<'ok' | 'not-found'> {
    return this.tenantDb.run(async tx => {
      const updated = await tx.lead.updateManyAndReturn({ where: { id, status: from }, data: { status: to }, select: { tenantId: true } });
      const row = updated[0];
      if (!row) {
        const current = await tx.lead.findUnique({ where: { id }, select: { status: true } });
        if (!current) return 'not-found';
        throw new LeadConflictError(current.status);
      }
      await tx.leadStatusHistory.create({ data: { tenantId: row.tenantId, leadId: id, previousStatus: from, newStatus: to, changedById: actorUserId } });
      return 'ok';
    });
  }

  /**
   * Назначение ответственного (7.4, L5). Составной FK пускает только участника этой компании; здесь же — только активного.
   * Снятие — запись null (не disconnect: иначе Prisma обнулит и tenant_id).
   */
  async assign(id: string, userId: string | null, actorUserId: string): Promise<'ok' | 'not-found' | 'bad-assignee'> {
    return this.tenantDb.run(async tx => {
      if (userId && (await tx.membership.count({ where: { userId, isActive: true } })) === 0) return 'bad-assignee';
      const updated = await tx.lead.updateManyAndReturn({ where: { id }, data: { assignedToId: userId }, select: { tenantId: true } });
      const row = updated[0];
      if (!row) return 'not-found';
      await tx.tenantAuditLog.create({
        data: { tenantId: row.tenantId, actorUserId, action: userId ? 'lead.assigned' : 'lead.unassigned', entityType: 'lead', entityId: id, ...(userId ? { metadata: { assigneeUserId: userId } } : {}) },
      });
      return 'ok';
    });
  }

  /** Активные участники компании — для фильтра «ответственный» и выбора при назначении. */
  async assignees(): Promise<{ userId: string; name: string; role: TenantRole }[]> {
    const rows = await this.tenantDb.run(tx => tx.membership.findMany({
      where: { isActive: true }, select: { userId: true, role: true, user: { select: { name: true } } }, orderBy: { user: { name: 'asc' } },
    }));
    return rows.map(r => ({ userId: r.userId, name: r.user.name, role: r.role }));
  }
}
