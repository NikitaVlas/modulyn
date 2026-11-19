import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, HttpException, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { t } from '../i18n.js';
import type { InvitationSentResponse, MemberEntry, MembersResponse } from '@modulyn/contracts';
import { Contexts, CurrentTenantUser, Roles } from '../auth/decorators.js';
import { MemberRuleError, MembersStore } from '../database/members-store.service.js';
import { requireTenant, type TenantPrincipal, type TenantRole } from '../tenancy/request-context.js';
import { INVITATIONS_PER_DAY, InvitationsService } from './invitations.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES: TenantRole[] = ['TENANT_ADMIN', 'MANAGER'];

function object(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadRequestException(t('err.badRequest'));
  return body as Record<string, unknown>;
}

export function inviteFields(raw: unknown): { email: string; name: string } {
  const body = object(raw);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new BadRequestException(t('err.emailInvalid'));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length === 0 || name.length > 200) throw new BadRequestException(t('err.nameRequired200'));
  return { email, name };
}

/**
 * Пользователи компании (5.2, 5.3, C4). Только администратор компании (@Roles) на поддомене компании;
 * все операции — в транзакции этой компании, поэтому участники других компаний недоступны (RLS).
 */
@Contexts('tenant')
@Roles('TENANT_ADMIN')
@Controller('members')
export class MembersController {
  constructor(private readonly store: MembersStore, private readonly invitations: InvitationsService) {}

  @Get()
  async list(@CurrentTenantUser() me: TenantPrincipal): Promise<MembersResponse> {
    const { members, invitations } = await this.store.list(requireTenant().tenantId);
    const now = Date.now();
    return {
      members: members.map(m => ({ ...m, isSelf: m.userId === me.userId })),
      invitations: invitations.map(i => ({
        id: i.id, email: i.email, name: i.name, role: i.role,
        expiresAt: i.expiresAt.toISOString(), createdAt: i.createdAt.toISOString(), expired: i.expiresAt.getTime() < now,
      })),
    };
  }

  /**
   * Приглашение (5.2, C2). Ответ одинаковый для нового и существующего аккаунта — администратор не узнаёт,
   * зарегистрирован ли человек в системе. Уже активный участник этой компании — 409 (он и так виден в списке).
   */
  @Post('invitations') @HttpCode(201)
  async invite(@Body() raw: unknown, @CurrentTenantUser() me: TenantPrincipal): Promise<InvitationSentResponse> {
    const tenant = requireTenant();
    const { email, name } = inviteFields(raw);
    const role = object(raw).role;
    if (!ROLES.includes(role as TenantRole)) throw new BadRequestException(t('err.roleRequired'));
    if (await this.store.isActiveMember(tenant.tenantId, email)) throw new ConflictException(t('err.alreadyMember'));
    if (await this.store.invitationsSince(tenant.tenantId, new Date(Date.now() - 24 * 60 * 60 * 1000)) >= INVITATIONS_PER_DAY) {
      throw new HttpException({ statusCode: 429, message: t('err.invitesPerDay', { count: INVITATIONS_PER_DAY }) }, 429);
    }
    const inviterName = await this.store.memberName(tenant.tenantId, me.userId);
    const invitationSent = await this.invitations.issue(tenant.tenantId, tenant.displayName, { email, name, role: role as TenantRole }, { userId: me.userId, name: inviterName });
    return { invitationSent };
  }

  /** Повторная отправка: новая ссылка, старая перестаёт работать (C8). */
  @Post('invitations/:id/resend') @HttpCode(200)
  async resend(@Param('id') id: string, @CurrentTenantUser() me: TenantPrincipal): Promise<InvitationSentResponse> {
    if (!UUID.test(id)) throw new NotFoundException();
    const tenant = requireTenant();
    const { token, tokenHash, expiresAt } = this.invitations.newToken();
    const invitation = await this.store.reissueInvitation(tenant.tenantId, id, tokenHash, expiresAt, me.userId);
    if (!invitation) throw new NotFoundException();
    return { invitationSent: await this.invitations.sendInvitation(invitation.email, tenant.displayName, null, token, invitation.locale) };
  }

  @Post('invitations/:id/revoke') @HttpCode(204)
  async revoke(@Param('id') id: string, @CurrentTenantUser() me: TenantPrincipal): Promise<void> {
    if (!UUID.test(id)) throw new NotFoundException();
    if (!(await this.store.revokeInvitation(requireTenant().tenantId, id, me.userId))) throw new NotFoundException();
  }

  /** Роль и доступ участника (5.3, C5, C6). */
  @Patch(':userId')
  async update(@Param('userId') userId: string, @Body() raw: unknown, @CurrentTenantUser() me: TenantPrincipal): Promise<MemberEntry> {
    if (!UUID.test(userId)) throw new NotFoundException();
    const body = object(raw);
    const extra = Object.keys(body).filter(k => k !== 'role' && k !== 'isActive');
    if (extra.length > 0) throw new BadRequestException(t('err.badRequest'));
    if (body.role !== undefined && !ROLES.includes(body.role as TenantRole)) throw new BadRequestException(t('err.roleInvalid'));
    if (body.isActive !== undefined && typeof body.isActive !== 'boolean') throw new BadRequestException(t('err.statusInvalid'));
    try {
      const updated = await this.store.updateMember(requireTenant().tenantId, me.userId, userId, {
        ...(body.role !== undefined ? { role: body.role as TenantRole } : {}),
        ...(body.isActive !== undefined ? { isActive: body.isActive as boolean } : {}),
      });
      return { ...updated, isSelf: false };
    } catch (error) {
      if (error instanceof MemberRuleError) {
        if (error.reason === 'self') throw new BadRequestException(t('err.selfChange'));
        if (error.reason === 'last-admin') throw new ConflictException(t('err.lastAdmin'));
        throw new NotFoundException();
      }
      throw error;
    }
  }
}
