import { Injectable } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { originFor, parseEnvironment } from '../config/environment.js';
import { currentRequestContext } from '../tenancy/request-context.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Единственный маршрут, принимающий запрос с другого поддомена: форма перехода с app.<домен> (A6). */
export const HANDOFF_COMPLETE_PATH = '/api/auth/handoff/complete';
/** Второй шаг перехода: та же форма, но уже со своего origin — чтобы браузер приложил cookie state. */
export const HANDOFF_FINISH_PATH = '/api/auth/handoff/finish';

/**
 * CSRF-защита изменяющих запросов (A7, подшаг 3.6).
 * Поддомены одного домена браузер считает «same-site», поэтому одной SameSite недостаточно.
 * Требуем: Origin точно совпадает с адресом хоста запроса, тело только application/json.
 * Сайт злоумышленника не может отправить такой запрос без CORS-разрешения, а CORS выключен.
 * Исключение — приём кода перехода: там Origin = app.<домен>, тело — форма, а защиту даёт проверка state (A6).
 */
@Injectable()
export class OriginMiddleware {
  private readonly config = parseEnvironment(process.env);
  private readonly appOrigin = originFor(this.config, 'app');

  readonly handle = (req: Request, res: Response, next: NextFunction): void => {
    if (SAFE_METHODS.has(req.method)) { next(); return; }
    const context = currentRequestContext();
    if (!context?.host) { next(); return; } // health-маршруты без контекста только читают
    const origin = req.headers.origin;
    const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
    const handoff = req.path === HANDOFF_COMPLETE_PATH && context.kind === 'tenant';
    const finish = req.path === HANDOFF_FINISH_PATH && context.kind === 'tenant';
    const expectedOrigin = handoff ? this.appOrigin : `${this.config.publicScheme}://${context.host}`;
    const expectedType = handoff || finish ? 'application/x-www-form-urlencoded' : 'application/json';
    if (origin !== expectedOrigin || type !== expectedType) {
      res.status(403).json({ message: 'Forbidden', statusCode: 403 });
      return;
    }
    next();
  };
}
