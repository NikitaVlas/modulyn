/**
 * Реестр модулей (Phase 6, решение M1) — источник истины о том, какие модули существуют в коде.
 * Каталог `modules` в БД заполняется миграцией из этого списка; при старте API сверяет их (ModulesCatalogCheck).
 * Новый модуль: код в общей кодовой базе + запись здесь + миграция каталога. Динамической загрузки нет (ТЗ).
 */
export const MODULES = [
  {
    key: 'leads',
    name: 'Заявки',
    description: 'Заявки с сайта и их обработка',
    /** M3: включается новой компании при создании. */
    enabledForNewTenants: true,
  },
] as const;

export type ModuleKey = (typeof MODULES)[number]['key'];

export const MODULE_KEYS: readonly ModuleKey[] = MODULES.map(m => m.key);

export function isModuleKey(value: unknown): value is ModuleKey {
  return typeof value === 'string' && (MODULE_KEYS as readonly string[]).includes(value);
}
