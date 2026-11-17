import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post, Put, Query } from '@nestjs/common';
import type {
  LeadAssignee, LeadDetail, LeadListItem, LeadListResponse, LeadsSummaryResponse,
} from '@modulyn/contracts';
import { Contexts, CurrentTenantUser, RequireModule, Roles } from '../auth/decorators.js';
import { LEAD_STATUSES, LeadConflictError, LeadsStore, type LeadFilters, type LeadRow, type LeadStatusKey } from '../database/leads-store.service.js';
import type { TenantPrincipal } from '../tenancy/request-context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZES = [25, 50, 100];
const PHONE = /^[0-9+()\-\s./]{3,50}$/;

function isStatus(value: unknown): value is LeadStatusKey {
  return typeof value === 'string' && (LEAD_STATUSES as readonly string[]).includes(value);
}

function item(row: LeadRow): LeadListItem {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

/** Один параметр адреса. Повторённый параметр (?status=A&status=B) — 400: несколько статусов передаются через запятую. */
function one(value: unknown): string | undefined {
  if (Array.isArray(value) || (value !== undefined && typeof value !== 'string')) throw new BadRequestException('Параметр списка указан несколько раз');
  return value;
}

/** Разбор параметров списка из адреса (L2). Неверные значения — понятная 400, а не тихое игнорирование. */
export function parseFilters(query: Record<string, unknown>, me: string): LeadFilters {
  const statusParam = one(query.status);
  const statuses = statusParam ? statusParam.split(',').filter(Boolean) : [];
  if (!statuses.every(isStatus)) throw new BadRequestException('Неизвестный статус в фильтре');
  const assigneeParam = one(query.assignee);
  let assignee: LeadFilters['assignee'] = { kind: 'any' };
  if (assigneeParam === 'me') assignee = { kind: 'user', userId: me };
  else if (assigneeParam === 'none') assignee = { kind: 'none' };
  else if (assigneeParam) {
    if (!UUID.test(assigneeParam)) throw new BadRequestException('Некорректный фильтр ответственного');
    assignee = { kind: 'user', userId: assigneeParam };
  }
  const q = one(query.q)?.trim() ?? '';
  if (q.length > 100) throw new BadRequestException('Слишком длинный поисковый запрос');
  const sort = one(query.sort) ?? 'created_desc';
  if (sort !== 'created_desc' && sort !== 'created_asc') throw new BadRequestException('Некорректная сортировка');
  const page = Number(one(query.page) ?? '1');
  if (!Number.isInteger(page) || page < 1 || page > 100_000) throw new BadRequestException('Некорректный номер страницы');
  const pageSize = Number(one(query.pageSize) ?? '25');
  if (!PAGE_SIZES.includes(pageSize)) throw new BadRequestException('Размер страницы: 25, 50 или 100');
  return { statuses: statuses as LeadStatusKey[], assignee, q: q || null, sort, page, pageSize };
}

function object(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadRequestException('Некорректный запрос');
  return body as Record<string, unknown>;
}

function optionalText(body: Record<string, unknown>, key: string, max: number): string | null {
  const value = body[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new BadRequestException(`Поле ${key} заполнено неверно`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new BadRequestException(`Поле ${key} длиннее ${max} символов`);
  return trimmed || null;
}

/**
 * Модуль «Заявки» (Phase 6–7). @RequireModule на классе: при отключённом модуле закрыт любой маршрут.
 * Права (A2): обе роли видят все заявки компании, создают и меняют статусы; назначает только администратор.
 * Заявка другой компании и несуществующая — одинаковый 404 (RLS: чужой строки для запроса просто нет).
 */
@Contexts('tenant')
@RequireModule('leads')
@Controller('leads')
export class LeadsController {
  constructor(private readonly leads: LeadsStore) {}

  @Get('summary')
  summary(): Promise<LeadsSummaryResponse> {
    return this.leads.summary();
  }

  @Get('assignees')
  assignees(): Promise<LeadAssignee[]> {
    return this.leads.assignees();
  }

  @Get()
  async list(@Query() query: Record<string, unknown>, @CurrentTenantUser() me: TenantPrincipal): Promise<LeadListResponse> {
    const filters = parseFilters(query, me.userId);
    const { items, total } = await this.leads.list(filters);
    return { items: items.map(item), total, page: filters.page, pageSize: filters.pageSize };
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<LeadDetail> {
    if (!UUID.test(id)) throw new NotFoundException();
    const lead = await this.leads.get(id);
    if (!lead) throw new NotFoundException();
    return {
      ...item(lead), message: lead.message, updatedAt: lead.updatedAt.toISOString(),
      history: lead.history.map(h => ({ ...h, createdAt: h.createdAt.toISOString() })),
    };
  }

  /** Ручная заявка (L4): имя и хотя бы один контакт. */
  @Post() @HttpCode(201)
  async create(@Body() raw: unknown, @CurrentTenantUser() me: TenantPrincipal): Promise<{ id: string }> {
    const body = object(raw);
    const name = optionalText(body, 'name', 200);
    if (!name) throw new BadRequestException('Укажите имя');
    const email = optionalText(body, 'email', 320)?.toLowerCase() ?? null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException('Некорректный email');
    const phone = optionalText(body, 'phone', 50);
    if (phone && !PHONE.test(phone)) throw new BadRequestException('Некорректный телефон');
    if (!email && !phone) throw new BadRequestException('Укажите email или телефон');
    const message = optionalText(body, 'message', 5000);
    return { id: await this.leads.create({ name, email, phone, message }, me.userId) };
  }

  /** Смена статуса (L1, L3): from — статус, который видел пользователь; если заявку уже изменили — 409. */
  @Post(':id/status') @HttpCode(204)
  async changeStatus(@Param('id') id: string, @Body() raw: unknown, @CurrentTenantUser() me: TenantPrincipal): Promise<void> {
    if (!UUID.test(id)) throw new NotFoundException();
    const body = object(raw);
    if (!isStatus(body.from) || !isStatus(body.to)) throw new BadRequestException('Некорректный статус');
    if (body.from === body.to) throw new BadRequestException('Заявка уже в этом статусе');
    try {
      if ((await this.leads.changeStatus(id, body.from, body.to, me.userId)) === 'not-found') throw new NotFoundException();
    } catch (error) {
      if (error instanceof LeadConflictError) {
        throw new ConflictException({ statusCode: 409, message: 'Заявку уже изменили. Обновлённые данные загружены.', code: 'LEAD_CHANGED', current: error.current });
      }
      throw error;
    }
  }

  /** Назначение ответственного (L5) — только администратор компании. null — снять назначение. */
  @Roles('TENANT_ADMIN')
  @Put(':id/assignee') @HttpCode(204)
  async assign(@Param('id') id: string, @Body() raw: unknown, @CurrentTenantUser() me: TenantPrincipal): Promise<void> {
    if (!UUID.test(id)) throw new NotFoundException();
    const userId = object(raw).userId;
    if (userId !== null && (typeof userId !== 'string' || !UUID.test(userId))) throw new BadRequestException('Некорректный сотрудник');
    const result = await this.leads.assign(id, userId, me.userId);
    if (result === 'not-found') throw new NotFoundException();
    if (result === 'bad-assignee') throw new BadRequestException('Назначить можно только активного сотрудника компании');
  }

  /** Удаление заявки (Phase 9, F6) — только администратор компании; необратимо. */
  @Roles('TENANT_ADMIN')
  @Delete(':id') @HttpCode(204)
  async remove(@Param('id') id: string, @CurrentTenantUser() me: TenantPrincipal): Promise<void> {
    if (!UUID.test(id)) throw new NotFoundException();
    if ((await this.leads.remove(id, me.userId)) === 'not-found') throw new NotFoundException();
  }
}
