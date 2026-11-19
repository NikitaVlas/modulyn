import { BadRequestException, Body, Controller, Get, HttpCode, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { t } from '../i18n.js';
import type {
  FormEndpointCreatedResponse, FormEndpointInfo, FormSecretResponse, FormSubmissionEntry,
} from '@modulyn/contracts';
import { Contexts, CurrentTenantUser, RequireModule, Roles } from '../auth/decorators.js';
import { TokensService } from '../auth/tokens.service.js';
import { originFor, parseEnvironment } from '../config/environment.js';
import { FormsStore, type EndpointRow } from '../database/forms-store.service.js';
import { requireTenant, type TenantPrincipal } from '../tenancy/request-context.js';
import { mappingError, type FieldMapping } from './mapping.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_DETAIL = /^[A-Za-z0-9_.-]{1,50}$/;

function object(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadRequestException(t('err.badRequest'));
  return body as Record<string, unknown>;
}

/** Разрешённые адреса сайта (BROWSER): только origin — схема, домен и порт, без пути. */
export function parseOrigins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10) throw new BadRequestException(t('err.originsMax'));
  return value.map(v => {
    let url: URL;
    try { url = new URL(String(v).trim()); } catch { throw new BadRequestException(t('err.originInvalid', { value: String(v).slice(0, 80) })); }
    const local = url.hostname === 'localhost' || url.hostname.endsWith('.localhost');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new BadRequestException(t('err.originHttps'));
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash || url.username) throw new BadRequestException(t('err.originNoPath'));
    return url.origin;
  });
}

/**
 * Раздел «Приём заявок» (8.9, W6): только администратор компании, при включённом модуле «Заявки».
 * Секрет SERVER-точки показывается один раз — в ответе на создание и на перевыпуск; в БД — только SHA-256.
 */
@Contexts('tenant')
@RequireModule('leads')
@Roles('TENANT_ADMIN')
@Controller('form-endpoints')
export class FormEndpointsController {
  private readonly env = parseEnvironment(process.env);

  constructor(private readonly forms: FormsStore, private readonly tokens: TokensService) {}

  private info(e: EndpointRow): FormEndpointInfo {
    return {
      ...e, intakeUrl: `${originFor(this.env, requireTenant().slug)}/api/webhooks/forms/${e.publicKey}`,
      lastUsedAt: e.lastUsedAt?.toISOString() ?? null, createdAt: e.createdAt.toISOString(),
    };
  }

  private newSecret(): { secret: string; secretHash: string; secretPrefix: string } {
    const secret = 'mdl_' + this.tokens.randomToken();
    return { secret, secretHash: this.tokens.hash(secret), secretPrefix: secret.slice(0, 10) };
  }

  @Get()
  async list(): Promise<FormEndpointInfo[]> {
    return (await this.forms.list()).map(e => this.info(e));
  }

  @Post() @HttpCode(201)
  async create(@Body() raw: unknown, @CurrentTenantUser() me: TenantPrincipal): Promise<FormEndpointCreatedResponse> {
    const body = object(raw);
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length === 0 || name.length > 100) throw new BadRequestException(t('err.endpointName'));
    if (body.mode !== 'SERVER' && body.mode !== 'BROWSER') throw new BadRequestException(t('err.endpointMode'));
    const sourceDetail = this.sourceDetail(body.sourceDetail);
    const allowedOrigins = body.allowedOrigins === undefined ? [] : parseOrigins(body.allowedOrigins);
    if (body.mode === 'BROWSER' && allowedOrigins.length === 0) throw new BadRequestException(t('err.endpointOriginRequired'));
    const mapError = mappingError(body.fieldMapping);
    if (mapError) throw new BadRequestException(mapError);
    const secret = body.mode === 'SERVER' ? this.newSecret() : null;
    const endpoint = await this.forms.create({
      name, mode: body.mode, publicKey: this.tokens.randomToken().slice(0, 32),
      secretHash: secret?.secretHash ?? null, secretPrefix: secret?.secretPrefix ?? null,
      allowedOrigins: body.mode === 'BROWSER' ? allowedOrigins : [], sourceDetail,
      fieldMapping: (body.fieldMapping as FieldMapping | undefined) ?? null,
    }, me.userId);
    return { endpoint: this.info(endpoint), secret: secret?.secret ?? null };
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() raw: unknown, @CurrentTenantUser() me: TenantPrincipal): Promise<FormEndpointInfo> {
    if (!UUID.test(id)) throw new NotFoundException();
    const body = object(raw);
    if (Object.keys(body).some(k => !['name', 'sourceDetail', 'allowedOrigins', 'fieldMapping', 'isActive'].includes(k))) {
      throw new BadRequestException(t('err.endpointImmutable'));
    }
    const changes: Parameters<FormsStore['update']>[1] = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.length > 100) throw new BadRequestException(t('err.endpointName'));
      changes.name = body.name.trim();
    }
    if (body.sourceDetail !== undefined) changes.sourceDetail = this.sourceDetail(body.sourceDetail);
    if (body.allowedOrigins !== undefined) changes.allowedOrigins = parseOrigins(body.allowedOrigins);
    if (body.fieldMapping !== undefined) {
      const mapError = mappingError(body.fieldMapping);
      if (mapError) throw new BadRequestException(mapError);
      changes.fieldMapping = body.fieldMapping as FieldMapping | null;
    }
    if (body.isActive !== undefined) {
      if (typeof body.isActive !== 'boolean') throw new BadRequestException(t('err.statusInvalid'));
      changes.isActive = body.isActive;
    }
    const updated = await this.forms.update(id, changes, me.userId);
    if (!updated) throw new NotFoundException();
    return this.info(updated);
  }

  /** Перевыпуск секрета (W2): старый перестаёт работать сразу. */
  @Post(':id/rotate-secret') @HttpCode(200)
  async rotate(@Param('id') id: string, @CurrentTenantUser() me: TenantPrincipal): Promise<FormSecretResponse> {
    if (!UUID.test(id)) throw new NotFoundException();
    const secret = this.newSecret();
    const result = await this.forms.rotateSecret(id, secret.secretHash, secret.secretPrefix, me.userId);
    if (result === 'not-found') throw new NotFoundException();
    if (result === 'not-server') throw new BadRequestException(t('err.browserNoSecret'));
    return { secret: secret.secret };
  }

  /** Журнал приёма (8.11, W7): последние 100 записей, без содержимого форм. */
  @Get('submissions')
  async submissions(@Query('endpointId') endpointId: unknown): Promise<FormSubmissionEntry[]> {
    if (endpointId !== undefined && (typeof endpointId !== 'string' || !UUID.test(endpointId))) throw new BadRequestException(t('err.endpointInvalid'));
    const rows = await this.forms.submissions((endpointId as string | undefined) ?? null);
    return rows.map(r => ({
      id: r.id, endpointId: r.endpoint.id, endpointName: r.endpoint.name, status: r.status, errorCode: r.errorCode,
      leadId: r.leadId, createdAt: r.createdAt.toISOString(),
    }));
  }

  private sourceDetail(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !SOURCE_DETAIL.test(value.trim())) throw new BadRequestException(t('err.sourceDetail'));
    return value.trim();
  }
}
