import { headers } from 'next/headers';

/**
 * Какой раздел показать по hostname (одна сборка Next.js для всех хостов, A5).
 * Это только выбор интерфейса: права и данные проверяет API. Ошибка здесь даёт не ту страницу, но не доступ к данным.
 */
export type Site =
  | { kind: 'app'; baseDomain: string }
  | { kind: 'platform'; baseDomain: string }
  | { kind: 'tenant'; slug: string; baseDomain: string }
  | { kind: 'unknown'; baseDomain: string };

export async function currentSite(): Promise<Site> {
  const baseDomain = process.env.APP_BASE_DOMAIN ?? 'localhost';
  const host = ((await headers()).get('host') ?? '').toLowerCase().split(':')[0] ?? '';
  const suffix = '.' + baseDomain;
  if (!host.endsWith(suffix)) return { kind: 'unknown', baseDomain };
  const label = host.slice(0, -suffix.length);
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) return { kind: 'unknown', baseDomain };
  if (label === 'app') return { kind: 'app', baseDomain };
  if (label === 'admin') return { kind: 'platform', baseDomain };
  return { kind: 'tenant', slug: label, baseDomain };
}

export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
