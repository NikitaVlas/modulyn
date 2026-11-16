import { Injectable, Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { parseEnvironment } from '../config/environment.js';
import { TenantDirectory } from '../database/tenant-directory.service.js';
import { resolveHost } from './hostname.js';
import { runWithRequestContext, type RequestContext } from './request-context.js';

/** Технические маршруты без компании: liveness/readiness должны работать на любом hostname прокси. */
function isHealthPath(path: string): boolean {
  return path === '/api/health' || path.startsWith('/api/health/');
}

function isLoopback(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * Определяет компанию по Host до маршрутизации Nest (подшаг 2.3) и кладёт контекст в AsyncLocalStorage (2.4).
 * Неизвестный, отключённый, зарезервированный или некорректный hostname получает одинаковый 404 (D9):
 * по ответу нельзя узнать, существует ли компания.
 */
@Injectable()
export class TenancyMiddleware {
  private readonly logger = new Logger('Tenancy');
  private readonly config = parseEnvironment(process.env);

  constructor(private readonly directory: TenantDirectory) {}

  readonly handle = (req: Request, res: Response, next: NextFunction): void => {
    if (isHealthPath(req.path)) { next(); return; }
    const resolution = resolveHost(this.originalHost(req), this.config.appBaseDomain);

    if (resolution.kind === 'invalid') { notFound(res); return; }
    if (resolution.kind === 'platform' || resolution.kind === 'app') {
      this.enter({ kind: resolution.kind }, next);
      return;
    }

    this.directory.findActiveBySlug(resolution.slug).then(tenant => {
      if (!tenant) { notFound(res); return; }
      this.enter({ kind: 'tenant', tenant }, next);
    }, () => {
      this.logger.error('Tenant lookup failed');
      if (!res.headersSent) res.status(503).json({ message: 'Service unavailable', statusCode: 503 });
    });
  };

  /**
   * Host запроса. X-Forwarded-Host учитывается только в режиме pnpm dev (TRUST_DEV_PROXY_HOST) и только
   * для соединений с loopback, то есть от локального Next.js dev-сервера, который сам перезаписывает этот заголовок.
   */
  private originalHost(req: Request): string | undefined {
    const forwarded = req.headers['x-forwarded-host'];
    if (this.config.trustDevProxyHost && isLoopback(req.socket.remoteAddress) && typeof forwarded === 'string') return forwarded;
    return req.headers.host;
  }

  private enter(context: RequestContext, next: NextFunction): void {
    runWithRequestContext(context, () => next());
  }
}

function notFound(res: Response): void {
  res.status(404).json({ message: 'Not Found', statusCode: 404 });
}
