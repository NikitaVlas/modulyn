import { Controller, HttpCode, Logger, Options, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Contexts, Public } from '../auth/decorators.js';
import { ThrottleService } from '../auth/throttle.service.js';
import { TokensService, safeEqual } from '../auth/tokens.service.js';
import { FormsStore, type IntakeEndpoint } from '../database/forms-store.service.js';
import { ModulesStore } from '../database/modules-store.service.js';
import { currentRequestContext, requireTenant } from '../tenancy/request-context.js';
import { PROVIDED_KEY, idempotencyKey, mapSubmission } from './mapping.js';

const PUBLIC_KEY = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_BODY_BYTES = 32 * 1024;
const PER_ENDPOINT_PER_MINUTE = 60;
const BROWSER_PER_IP_PER_MINUTE = 10;
/** Поля-ловушки для ботов (BROWSER): человек их не видит и не заполняет. */
const HONEYPOT_FIELDS = ['_hp', 'website'];

type Outcome = { status: number; body: Record<string, unknown> };
const NOT_FOUND: Outcome = { status: 404, body: { ok: false, error: 'NOT_FOUND' } };

/**
 * Приём заявок с сайтов (Phase 8, W1–W9): POST https://<компания>.<домен>/api/webhooks/forms/<publicKey>.
 *
 * Маршрут публичный (без входа), но:
 * - компания определяется по hostname (отключённая компания — 404 ещё в tenancy-middleware);
 * - модуль «Заявки» должен быть включён, точка — существовать в ЭТОЙ компании и быть активной — иначе одинаковый 404 (W9);
 * - SERVER: секрет в Authorization: Bearer или X-CRM-Integration-Key (так отправляет сайт Nova), сравнение по хешу;
 * - BROWSER: Origin из списка точки, CORS только для него, ловушка для ботов, лимит с одного IP;
 * - лимиты размера и частоты; дубли по ключу повтора (W3).
 * Тело запроса не пишется в логи и не хранится — только в созданной заявке (W7).
 */
@Contexts('tenant')
@Public()
@Controller('webhooks/forms')
export class IntakeController {
  private readonly logger = new Logger('FormIntake');

  constructor(
    private readonly forms: FormsStore,
    private readonly modules: ModulesStore,
    private readonly throttle: ThrottleService,
    private readonly tokens: TokensService,
  ) {}

  /** Предварительный запрос браузера (CORS) для BROWSER-точки. */
  @Options(':publicKey')
  async preflight(@Param('publicKey') publicKey: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const endpoint = await this.endpoint(publicKey);
    const origin = req.headers.origin;
    if (!endpoint || endpoint.mode !== 'BROWSER' || typeof origin !== 'string' || !endpoint.allowedOrigins.includes(origin)) {
      res.status(404).json(NOT_FOUND.body);
      return;
    }
    this.cors(res, origin);
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Idempotency-Key');
    res.setHeader('Access-Control-Max-Age', '600');
    res.status(204).end();
  }

  @Post(':publicKey') @HttpCode(202)
  async receive(@Param('publicKey') publicKey: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const outcome = await this.handle(publicKey, req, res).catch(error => {
      this.logger.error(`Form intake failed: ${(error as { code?: string }).code ?? (error as Error).name}`);
      return { status: 503, body: { ok: false, error: 'UNAVAILABLE' } } as Outcome;
    });
    res.status(outcome.status).json(outcome.body);
  }

  private async endpoint(publicKey: string): Promise<IntakeEndpoint | null> {
    if (!PUBLIC_KEY.test(publicKey)) return null;
    const { tenantId } = requireTenant();
    if (!(await this.modules.isEnabled(tenantId, 'leads'))) return null; // W9: модуль отключён — приём закрыт
    const endpoint = await this.forms.findForIntake(tenantId, publicKey);
    return endpoint?.isActive ? endpoint : null;
  }

  private cors(res: Response, origin: string): void {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  private async handle(publicKey: string, req: Request, res: Response): Promise<Outcome> {
    const { tenantId } = requireTenant();
    const length = Number(req.headers['content-length'] ?? '0');
    if (length > MAX_BODY_BYTES) return { status: 413, body: { ok: false, error: 'TOO_LARGE' } };
    const endpoint = await this.endpoint(publicKey);
    if (!endpoint) return NOT_FOUND;
    const reject = async (status: number, error: string, code: string, extra: Record<string, unknown> = {}): Promise<Outcome> => {
      await this.forms.record(tenantId, endpoint.id, `rejected:${Date.now()}`, 'REJECTED', code);
      return { status, body: { ok: false, error, ...extra } };
    };

    // Лимит точки — до проверки секрета: перебор секретов тоже ограничен и не засоряет журнал без конца.
    if (await this.throttle.exceeded(`intake-endpoint:${endpoint.id}`, PER_ENDPOINT_PER_MINUTE, 60_000)) {
      res.setHeader('Retry-After', '60');
      return { status: 429, body: { ok: false, error: 'RATE_LIMITED' } };
    }

    // Аутентификация отправителя.
    if (endpoint.mode === 'SERVER') {
      const bearer = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
      const header = req.headers['x-crm-integration-key'];
      const secret = bearer ?? (typeof header === 'string' ? header.trim() : undefined);
      if (!secret || secret.length > 200 || !endpoint.secretHash || !safeEqual(this.tokens.hash(secret), endpoint.secretHash)) {
        return reject(401, 'UNAUTHORIZED', 'unauthorized');
      }
    } else {
      const origin = req.headers.origin;
      if (typeof origin !== 'string' || !endpoint.allowedOrigins.includes(origin)) return reject(403, 'ORIGIN_NOT_ALLOWED', 'origin_not_allowed');
      this.cors(res, origin);
      const ip = currentRequestContext()?.ip ?? 'unknown';
      if (await this.throttle.exceeded(`intake-ip:${endpoint.id}:${ip}`, BROWSER_PER_IP_PER_MINUTE, 60_000)) {
        res.setHeader('Retry-After', '60');
        return { status: 429, body: { ok: false, error: 'RATE_LIMITED' } };
      }
    }

    const type = String(req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    const body = req.body as unknown;
    if (type !== 'application/json' || typeof body !== 'object' || body === null || Array.isArray(body)) {
      return reject(400, 'VALIDATION', 'invalid_json', { field: null, reason: 'json_object_required' });
    }
    const fields = body as Record<string, unknown>;
    if (Buffer.byteLength(JSON.stringify(fields)) > MAX_BODY_BYTES) return { status: 413, body: { ok: false, error: 'TOO_LARGE' } };

    // Ловушка для ботов: отвечаем «принято», но заявку не создаём.
    if (endpoint.mode === 'BROWSER' && HONEYPOT_FIELDS.some(f => typeof fields[f] === 'string' && (fields[f] as string).trim() !== '')) {
      await this.forms.record(tenantId, endpoint.id, `spam:${Date.now()}`, 'REJECTED', 'spam');
      return { status: 202, body: { ok: true } };
    }

    const mapped = mapSubmission(fields, endpoint.fieldMapping);
    if (!mapped.ok) return reject(400, 'VALIDATION', `invalid_${mapped.field}`.slice(0, 100), { field: mapped.field, reason: mapped.reason });

    const headerKey = req.headers['idempotency-key'];
    const provided = typeof headerKey === 'string' && PROVIDED_KEY.test(headerKey) ? headerKey
      : typeof fields.submissionId === 'string' && PROVIDED_KEY.test(fields.submissionId) ? fields.submissionId : null;
    const result = await this.forms.importLead(tenantId, endpoint, idempotencyKey(provided, mapped.lead), mapped.lead);
    return { status: 202, body: result.status === 'duplicate' ? { ok: true, duplicate: true } : { ok: true } };
  }
}
