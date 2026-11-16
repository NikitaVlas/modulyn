import { Controller, Get } from '@nestjs/common';
import type { TenantCapabilitiesResponse } from '@modulyn/contracts';
import { Contexts, CurrentTenantUser } from '../auth/decorators.js';
import { ModulesStore } from '../database/modules-store.service.js';
import { requireTenant, type TenantPrincipal } from '../tenancy/request-context.js';

/**
 * Что доступно в CRM компании (6.4, M7): включённые модули и роль — для меню.
 * Меню — только удобство: доступ к модулю всё равно проверяет guard на каждом его маршруте.
 */
@Contexts('tenant')
@Controller('tenant/capabilities')
export class CapabilitiesController {
  constructor(private readonly modules: ModulesStore) {}

  @Get()
  async get(@CurrentTenantUser() me: TenantPrincipal): Promise<TenantCapabilitiesResponse> {
    return { modules: await this.modules.enabledKeys(requireTenant().tenantId), role: me.role };
  }
}
