import { headers } from 'next/headers';
import { hostKind, parseHosting, type Hosting } from '@modulyn/contracts';

/**
 * Какой раздел показать по hostname (одна сборка Next.js для всех хостов, A5).
 * Это только выбор интерфейса: права и данные проверяет API. Ошибка здесь даёт не ту страницу, но не доступ к данным.
 * Адреса — по тем же правилам, что в API (Phase 11, E2): «метка + домен» или явные адреса выделенной установки.
 */
export type Site =
  | { kind: 'app'; hosting: Hosting }
  | { kind: 'platform'; hosting: Hosting }
  | { kind: 'tenant'; slug: string; hosting: Hosting }
  | { kind: 'unknown'; hosting: Hosting };

export async function currentSite(): Promise<Site> {
  const hosting = parseHosting(process.env);
  const host = ((await headers()).get('host') ?? '').toLowerCase().split(':')[0] ?? '';
  const found = hostKind(hosting, host, new Set(['admin', 'api', 'www', 'app', 'mail', 'static', 'assets', 'status', 'help', 'support']));
  if (found.kind === 'invalid') return { kind: 'unknown', hosting };
  return found.kind === 'tenant' ? { kind: 'tenant', slug: found.slug, hosting } : { kind: found.kind, hosting };
}

export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
