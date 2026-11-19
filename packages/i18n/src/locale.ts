/** Языки Modulyn (Phase 10, I1): немецкий — по умолчанию, английский, русский. */
export const LOCALES = ['de', 'en', 'ru'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'de';

/**
 * Cookie с выбранным языком (I2): нужен до входа (страница входа, приглашение, сброс пароля) и для первой отрисовки.
 * Не секрет и не признак входа: только 'de' | 'en' | 'ru'. Своя на каждом поддомене (без Domain).
 */
export const LOCALE_COOKIE = 'modulyn_lang';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/** Значение из cookie или заголовка → язык; всё непонятное — язык по умолчанию (I3: браузер не угадываем). */
export function toLocale(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

/** Названия языков — на самом языке: так их узнают в переключателе при любом текущем языке. */
export const LOCALE_NAMES: Record<Locale, string> = { de: 'Deutsch', en: 'English', ru: 'Русский' };

const INTL: Record<Locale, string> = { de: 'de-DE', en: 'en-GB', ru: 'ru-RU' };

/** Дата и время по языку (I8); часовой пояс — среды выполнения (в интерфейсе — браузера). */
export function formatDateTime(locale: Locale, value: string | Date): string {
  return new Date(value).toLocaleString(INTL[locale], { dateStyle: 'short', timeStyle: 'short' });
}

export function formatDate(locale: Locale, value: string | Date): string {
  return new Date(value).toLocaleDateString(INTL[locale]);
}
