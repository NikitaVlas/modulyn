import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { PASSWORD_MAX, PASSWORD_MIN } from './auth.constants.js';

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

/** Ошибка политики нового пароля или null. Без требований к составу символов (A8). */
export function passwordPolicyError(password: string): string | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN) return `Пароль должен содержать не меньше ${PASSWORD_MIN} символов`;
  if (length > PASSWORD_MAX) return `Пароль должен содержать не больше ${PASSWORD_MAX} символов`;
  if (password.trim().length === 0) return 'Пароль не может состоять из пробелов';
  return null;
}
