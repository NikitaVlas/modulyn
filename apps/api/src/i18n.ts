import { DEFAULT_LOCALE, translate, type Locale, type MessageKey, type Params } from '@modulyn/i18n';
import { currentRequestContext } from './tenancy/request-context.js';

/**
 * Язык текущего запроса (Phase 10, I2, I5): после входа — язык аккаунта, до входа — cookie, иначе немецкий.
 * Вне HTTP-запроса (команды, фоновые задачи, unit-тесты) — немецкий.
 */
export function requestLocale(): Locale {
  return currentRequestContext()?.locale ?? DEFAULT_LOCALE;
}

/** Текст для пользователя на языке текущего запроса. Для писем другим людям язык передаётся явно (I4). */
export function t(key: MessageKey, params?: Params): string {
  return translate(requestLocale(), key, params);
}
