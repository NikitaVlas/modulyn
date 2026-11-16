import { Controller, Get, NotFoundException } from '@nestjs/common';
import type { TenantInfoResponse } from '@modulyn/contracts';
import { Public } from '../auth/decorators.js';
import { currentTenant } from './request-context.js';

/**
 * GET /api/tenant — публичная информация о компании текущего поддомена (для проверки 2.3 и будущей страницы входа).
 * Возвращает только slug и displayName; на admin/app-поддоменах компании нет, поэтому 404.
 */
@Public()
@Controller('tenant')
export class TenantController {
  @Get()
  current(): TenantInfoResponse {
    const tenant = currentTenant();
    if (!tenant) throw new NotFoundException();
    return { slug: tenant.slug, displayName: tenant.displayName };
  }
}
