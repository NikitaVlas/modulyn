/**
 * Переводы Modulyn (Phase 10): один словарь для интерфейса, API и писем.
 * Каждая фраза — сразу на трёх языках (entry.ts); пропущенный язык или неизвестный ключ — ошибка сборки.
 */
import type { Entry } from './entry.js';
import { DEFAULT_LOCALE, type Locale } from './locale.js';
import { account } from './messages/account.js';
import { common } from './messages/common.js';
import { crm } from './messages/crm.js';
import { intake } from './messages/intake.js';
import { platform } from './messages/platform.js';
import { server } from './messages/server.js';

export * from './locale.js';
export type { Entry } from './entry.js';

/** Разделы словаря — по отдельности, чтобы unit-тест проверил, что ключи разделов не пересекаются. */
export const SECTIONS = { common, account, crm, intake, platform, server } as const;

const MESSAGES = { ...common, ...account, ...crm, ...intake, ...platform, ...server };

export type MessageKey = keyof typeof MESSAGES;
export type Params = Readonly<Record<string, string | number>>;

/** Все фразы — для проверок (полнота, подстановки). */
export const MESSAGE_ENTRIES: Readonly<Record<MessageKey, Entry>> = MESSAGES;

/** Перевод с подстановками {имя}. Неизвестная подстановка остаётся как есть — это видно в тестах и на экране. */
export function translate(locale: Locale, key: MessageKey, params?: Params): string {
  const entry = MESSAGES[key];
  const text = entry[locale] ?? entry[DEFAULT_LOCALE];
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** Имена подстановок в тексте — для проверки, что во всех языках они одинаковые. */
export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1] ?? '').sort();
}
