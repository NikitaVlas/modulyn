import { HttpException, Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { AuthStore } from '../database/auth-store.service.js';
import { THROTTLE_MAX_FAILED_PER_EMAIL, THROTTLE_MAX_PER_IP, THROTTLE_WINDOW_MS } from './auth.constants.js';
import { TokensService } from './tokens.service.js';

/**
 * Ограничение перебора паролей (A9, подшаг 3.6). Счётчики в PostgreSQL: переживают перезапуск API
 * и работают при нескольких экземплярах. Постоянной блокировки аккаунта нет — её мог бы вызвать злоумышленник.
 * По IP считаются все попытки, по email — только неудачные; успешный вход сбрасывает счётчик email.
 */
@Injectable()
export class ThrottleService {
  constructor(private readonly store: AuthStore, private readonly tokens: TokensService) {}

  private keys(scope: string, ip: string | undefined, account: string) {
    return {
      ip: this.tokens.throttleKey(`ip:${scope}:${ip ?? 'unknown'}`),
      account: this.tokens.throttleKey(`account:${scope}:${account}`),
    };
  }

  /** Перед проверкой пароля. Превышение — 429 с Retry-After. */
  async before(res: Response, scope: string, ip: string | undefined, account: string): Promise<void> {
    const keys = this.keys(scope, ip, account);
    const perIp = await this.store.throttleHit(keys.ip, THROTTLE_WINDOW_MS);
    const failed = await this.store.throttleCount(keys.account, THROTTLE_WINDOW_MS);
    if (perIp > THROTTLE_MAX_PER_IP || failed >= THROTTLE_MAX_FAILED_PER_EMAIL) {
      res.setHeader('Retry-After', String(Math.round(THROTTLE_WINDOW_MS / 1000)));
      throw new HttpException({ message: 'Слишком много попыток входа. Попробуйте позже.', statusCode: 429 }, 429);
    }
  }

  async failed(scope: string, ip: string | undefined, account: string): Promise<void> {
    await this.store.throttleHit(this.keys(scope, ip, account).account, THROTTLE_WINDOW_MS);
  }

  async succeeded(scope: string, ip: string | undefined, account: string): Promise<void> {
    await this.store.throttleReset(this.keys(scope, ip, account).account);
  }

  /** Общий счётчик: учитывает попытку и сообщает, превышен ли лимит в окне (письма восстановления пароля, C7). */
  async exceeded(key: string, max: number, windowMs: number): Promise<boolean> {
    return (await this.store.throttleHit(this.tokens.throttleKey(key), windowMs)) > max;
  }
}
