import { randomBytes } from 'node:crypto';
import { t } from '../i18n.js';
import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { PASSWORD_MAX, PASSWORD_MIN, TEMP_PASSWORD_LENGTH } from './auth.constants.js';

/** Параметры OWASP для Argon2id: 19 MiB памяти, 2 прохода, 1 поток (A8). */
const OPTIONS = { algorithm: Algorithm.Argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/**
 * Хеширование и проверка паролей (подшаг 3.2).
 * Для несуществующего аккаунта выполняется проверка с фиктивным хешем: время ответа одинаково,
 * и по нему нельзя узнать, зарегистрирован ли email.
 */
@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    try { return await verify(passwordHash, password); } catch { return false; }
  }

  /** Та же работа, что и verify, для отсутствующего аккаунта. Всегда false. */
  async verifyDummy(password: string): Promise<false> {
    this.dummyHash ??= hash('modulyn-dummy-password-for-timing', OPTIONS);
    await this.verify(await this.dummyHash, password);
    return false;
  }
}

/**
 * Временный пароль (B8): 20 случайных символов без похожих (0/O, 1/l/I) — его передают человеку вручную.
 * Алфавит из 32 символов: выбор по байту & 31 даёт равномерное распределение.
 */
export function temporaryPassword(length = TEMP_PASSWORD_LENGTH): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789A'; // ровно 32 символа
  return Array.from(randomBytes(length), byte => alphabet[byte & 31]).join('');
}

/** Ошибка политики нового пароля или null. Без требований к составу символов (A8). */
export function passwordPolicyError(password: string): string | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN) return t('err.passwordTooShort', { min: PASSWORD_MIN });
  if (length > PASSWORD_MAX) return t('err.passwordTooLong', { max: PASSWORD_MAX });
  if (password.trim().length === 0) return t('err.passwordBlank');
  return null;
}
