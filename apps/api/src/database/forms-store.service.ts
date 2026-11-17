import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { FieldMapping, MappedLead } from '../forms/mapping.js';
import { requireTenant } from '../tenancy/request-context.js';
import { TenantDb } from './tenant-db.service.js';

/**
 * Точки приёма и журнал приёма (Phase 8). Всё — в транзакции компании (RLS):
 * точка ищется по публичному ключу в контексте компании из hostname, поэтому ключ одной компании
 * на поддомене другой просто не найдётся.
 */

export interface EndpointRow {
  id: string; name: string; mode: 'SERVER' | 'BROWSER'; publicKey: string; secretPrefix: string | null;
  allowedOrigins: string[]; sourceDetail: string | null; fieldMapping: FieldMapping | null;
  isActive: boolean; lastUsedAt: Date | null; createdAt: Date;
}
export interface IntakeEndpoint extends EndpointRow { secretHash: string | null }
export type ImportResult = { status: 'imported'; leadId: string } | { status: 'duplicate' };

const ENDPOINT_SELECT = {
  id: true, name: true, mode: true, publicKey: true, secretPrefix: true, allowedOrigins: true, sourceDetail: true,
  fieldMapping: true, isActive: true, lastUsedAt: true, createdAt: true,
} as const;

/** Сопоставление полей в JSON-столбец; «нет сопоставления» — SQL NULL. */
function json(mapping: FieldMapping | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return mapping ? (mapping as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
}

function row<T extends { fieldMapping: Prisma.JsonValue }>(r: T): Omit<T, 'fieldMapping'> & { fieldMapping: FieldMapping | null } {
  return { ...r, fieldMapping: (r.fieldMapping as FieldMapping | null) ?? null };
}

@Injectable()
export class FormsStore {
  constructor(private readonly tenantDb: TenantDb) {}

  // ───────────── Настройка (8.9) — администратор компании ─────────────

  async list(): Promise<EndpointRow[]> {
    return (await this.tenantDb.run(tx => tx.formEndpoint.findMany({ select: ENDPOINT_SELECT, orderBy: { createdAt: 'asc' } }))).map(row);
  }

  async create(data: {
    name: string; mode: 'SERVER' | 'BROWSER'; publicKey: string; secretHash: string | null; secretPrefix: string | null;
    allowedOrigins: string[]; sourceDetail: string | null; fieldMapping: FieldMapping | null;
  }, actorUserId: string): Promise<EndpointRow> {
    const { tenantId } = requireTenant();
    return row(await this.tenantDb.run(async tx => {
      const created = await tx.formEndpoint.create({
        data: { tenantId, ...data, fieldMapping: json(data.fieldMapping) },
        select: ENDPOINT_SELECT,
      });
      await tx.tenantAuditLog.create({ data: { tenantId, actorUserId, action: 'form_endpoint.created', entityType: 'form_endpoint', entityId: created.id, metadata: { mode: data.mode } } });
      return created;
    }));
  }

  async update(id: string, changes: { name?: string; sourceDetail?: string | null; allowedOrigins?: string[]; fieldMapping?: FieldMapping | null; isActive?: boolean }, actorUserId: string): Promise<EndpointRow | null> {
    const { tenantId } = requireTenant();
    const result = await this.tenantDb.run(async tx => {
      const current = await tx.formEndpoint.findUnique({ where: { id }, select: { mode: true } });
      if (!current) return null;
      const data: Prisma.FormEndpointUpdateInput = {
        ...(changes.name !== undefined ? { name: changes.name } : {}),
        ...(changes.sourceDetail !== undefined ? { sourceDetail: changes.sourceDetail } : {}),
        ...(changes.allowedOrigins !== undefined ? { allowedOrigins: changes.allowedOrigins } : {}),
        ...(changes.fieldMapping !== undefined ? { fieldMapping: json(changes.fieldMapping) } : {}),
        ...(changes.isActive !== undefined ? { isActive: changes.isActive } : {}),
      };
      const updated = await tx.formEndpoint.update({ where: { id }, data, select: ENDPOINT_SELECT });
      await tx.tenantAuditLog.create({ data: { tenantId, actorUserId, action: 'form_endpoint.updated', entityType: 'form_endpoint', entityId: id, metadata: { fields: Object.keys(changes) } } });
      return updated;
    });
    return result ? row(result) : null;
  }

  /** Новый секрет (только SERVER): старый перестаёт работать сразу. */
  async rotateSecret(id: string, secretHash: string, secretPrefix: string, actorUserId: string): Promise<'ok' | 'not-found' | 'not-server'> {
    const { tenantId } = requireTenant();
    return this.tenantDb.run(async tx => {
      const current = await tx.formEndpoint.findUnique({ where: { id }, select: { mode: true } });
      if (!current) return 'not-found';
      if (current.mode !== 'SERVER') return 'not-server';
      await tx.formEndpoint.update({ where: { id }, data: { secretHash, secretPrefix } });
      await tx.tenantAuditLog.create({ data: { tenantId, actorUserId, action: 'form_endpoint.secret_rotated', entityType: 'form_endpoint', entityId: id } });
      return 'ok';
    });
  }

  /** Журнал приёма (W7): без содержимого форм. */
  async submissions(endpointId: string | null, limit = 100) {
    return this.tenantDb.run(tx => tx.formSubmission.findMany({
      where: endpointId ? { endpointId } : {}, orderBy: { createdAt: 'desc' }, take: limit,
      select: { id: true, status: true, errorCode: true, leadId: true, createdAt: true, endpoint: { select: { id: true, name: true } } },
    }));
  }

  // ───────────── Приём (8.10) ─────────────

  async findForIntake(tenantId: string, publicKey: string): Promise<IntakeEndpoint | null> {
    const found = await this.tenantDb.runInTenant(tenantId, tx => tx.formEndpoint.findUnique({
      where: { publicKey }, select: { ...ENDPOINT_SELECT, secretHash: true },
    }));
    return found ? row(found) : null;
  }

  /**
   * Заявка, первая запись истории и запись журнала — одной транзакцией. Повтор ключа (W3) — запись «Дубль» без заявки.
   * Две одновременные одинаковые отправки: частичный уникальный индекс пропустит только одну, вторая станет дублем.
   */
  async importLead(tenantId: string, endpoint: IntakeEndpoint, key: string, lead: MappedLead): Promise<ImportResult> {
    try {
      return await this.tenantDb.runInTenant(tenantId, async tx => {
        const existing = await tx.formSubmission.findFirst({ where: { endpointId: endpoint.id, idempotencyKey: key, status: 'IMPORTED' }, select: { id: true } });
        if (existing) {
          await tx.formSubmission.create({ data: { tenantId, endpointId: endpoint.id, idempotencyKey: key, status: 'DUPLICATE' } });
          return { status: 'duplicate' as const };
        }
        const created = await tx.lead.create({
          data: { tenantId, ...lead, source: 'WEB_FORM', sourceDetail: endpoint.sourceDetail, status: 'NEW' }, select: { id: true },
        });
        await tx.leadStatusHistory.create({ data: { tenantId, leadId: created.id, previousStatus: null, newStatus: 'NEW', changedById: null } });
        await tx.formSubmission.create({ data: { tenantId, endpointId: endpoint.id, idempotencyKey: key, status: 'IMPORTED', leadId: created.id } });
        await tx.formEndpoint.update({ where: { id: endpoint.id }, data: { lastUsedAt: new Date() } });
        return { status: 'imported' as const, leadId: created.id };
      });
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') throw error;
      await this.record(tenantId, endpoint.id, key, 'DUPLICATE', null);
      return { status: 'duplicate' };
    }
  }

  /** Запись журнала об отклонённой отправке: только код причины. */
  async record(tenantId: string, endpointId: string, key: string, status: 'REJECTED' | 'DUPLICATE', errorCode: string | null): Promise<void> {
    await this.tenantDb.runInTenant(tenantId, tx => tx.formSubmission.create({ data: { tenantId, endpointId, idempotencyKey: key.slice(0, 160), status, errorCode } }));
  }
}
