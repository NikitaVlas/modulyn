import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import type { CreateTenantResponse, InvitationSentResponse, PlatformTenant } from '@modulyn/contracts';
import { Contexts, CurrentPlatformAdmin } from '../auth/decorators.js';
import { InvitationsService } from '../members/invitations.service.js';
import { inviteFields } from '../members/members.controller.js';
import { PlatformStore, SlugTakenError, type TenantRow } from '../database/platform-store.service.js';
import { RESERVED_SUBDOMAINS, SLUG_PATTERN } from '../tenancy/hostname.js';
import type { PlatformPrincipal } from '../tenancy/request-context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fields(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadRequestException('Некорректный запрос');
  return body as Record<string, unknown>;
}

function label(body: Record<string, unknown>, key: string, title: string, required: boolean): string | undefined {
  const value = body[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) throw new BadRequestException(`Заполните поле «${title}»`);
  const trimmed = value.trim();
  if (trimmed.length > 200) throw new BadRequestException(`Поле «${title}» длиннее 200 символов`);
  return trimmed;
}

function toResponse(row: TenantRow): PlatformTenant {
  return {
    id: row.id, slug: row.slug, name: row.name, displayName: row.displayName, status: row.status,
    activeMembers: row.activeMembers, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Компании на admin.<домен> (подшаги 4.2, 4.3). Только для вошедшего администратора платформы с настроенным
 * вторым фактором: @Contexts('platform') + глобальный guard (ограниченные сессии получают 403).
 * Ответы не содержат лидов, имён и email участников (B6) — кроме первого администратора в ответе на создание.
 */
@Contexts('platform')
@Controller('platform/tenants')
export class PlatformTenantsController {
  constructor(private readonly store: PlatformStore, private readonly invitations: InvitationsService) {}

  @Get()
  async list(): Promise<PlatformTenant[]> {
    return (await this.store.listTenants()).map(toResponse);
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<PlatformTenant> {
    if (!UUID.test(id)) throw new NotFoundException();
    const tenant = await this.store.getTenant(id);
    if (!tenant) throw new NotFoundException();
    return toResponse(tenant);
  }

  /** Создание компании и приглашение первому администратору по email (C3). */
  @Post() @HttpCode(201)
  async create(@Body() raw: unknown, @CurrentPlatformAdmin() admin: PlatformPrincipal): Promise<CreateTenantResponse> {
    const body = fields(raw);
    const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
    if (!SLUG_PATTERN.test(slug)) {
      throw new BadRequestException('Поддомен: латинские буквы, цифры и дефис, от 1 до 63 символов, без дефиса в начале и в конце');
    }
    if (RESERVED_SUBDOMAINS.has(slug)) throw new BadRequestException(`Поддомен «${slug}» зарезервирован платформой`);
    const name = label(body, 'name', 'Название', true) as string;
    const displayName = label(body, 'displayName', 'Имя в интерфейсе', true) as string;
    const adminName = label(body, 'adminName', 'Имя администратора', true) as string;
    const adminEmail = typeof body.adminEmail === 'string' ? body.adminEmail.trim().toLowerCase() : '';
    if (adminEmail.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) throw new BadRequestException('Укажите корректный email администратора');

    const { token, tokenHash, expiresAt } = this.invitations.newToken();
    try {
      const created = await this.store.createTenant({ slug, name, displayName, admin: { email: adminEmail, name: adminName, tokenHash, expiresAt } }, admin.adminId);
      // Письмо — после фиксации транзакции: при сбое почты компания и приглашение остаются, письмо можно отправить повторно.
      const invitationSent = await this.invitations.sendInvitation(adminEmail, displayName, null, token);
      return { tenant: toResponse(created.tenant), firstAdmin: { email: adminEmail, name: adminName }, invitationSent };
    } catch (error) {
      if (error instanceof SlugTakenError) throw new ConflictException(`Поддомен «${slug}» уже занят`);
      throw error;
    }
  }

  /**
   * Приглашение администратора компании платформой (C3 — повторная отправка первому администратору, C4 — новый
   * администратор, если в компании их не осталось). Платформа не видит участников и не узнаёт, есть ли аккаунт.
   */
  @Post(':id/admin-invitations') @HttpCode(201)
  async inviteAdmin(@Param('id') id: string, @Body() raw: unknown, @CurrentPlatformAdmin() admin: PlatformPrincipal): Promise<InvitationSentResponse> {
    if (!UUID.test(id)) throw new NotFoundException();
    const tenant = await this.store.getTenant(id);
    if (!tenant) throw new NotFoundException();
    if (tenant.status !== 'ACTIVE') throw new ConflictException('Компания отключена');
    const { email, name } = inviteFields(raw);
    const invitationSent = await this.invitations.issue(tenant.id, tenant.displayName, { email, name, role: 'TENANT_ADMIN' }, null);
    await this.store.auditAdminInvitation(tenant.id, admin.adminId);
    return { invitationSent };
  }

  /** Названия и статус (B4, B5). Поддомен не меняется — поле slug отклоняется явно. */
  @Patch(':id')
  async update(@Param('id') id: string, @Body() raw: unknown, @CurrentPlatformAdmin() admin: PlatformPrincipal): Promise<PlatformTenant> {
    if (!UUID.test(id)) throw new NotFoundException();
    const body = fields(raw);
    if ('slug' in body) throw new BadRequestException('Поддомен после создания компании не меняется');
    const unknownKeys = Object.keys(body).filter(k => !['name', 'displayName', 'status'].includes(k));
    if (unknownKeys.length > 0) throw new BadRequestException('Некорректный запрос');
    const status = body.status;
    if (status !== undefined && status !== 'ACTIVE' && status !== 'SUSPENDED') throw new BadRequestException('Некорректный статус');
    const name = label(body, 'name', 'Название', false);
    const displayName = label(body, 'displayName', 'Имя в интерфейсе', false);
    const updated = await this.store.updateTenant(id, {
      ...(name !== undefined ? { name } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
      ...(status !== undefined ? { status } : {}),
    }, admin.adminId);
    if (!updated) throw new NotFoundException();
    return toResponse(updated);
  }
}
