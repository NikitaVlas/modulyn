/**
 * Разбор заголовка Host в контекст запроса (подшаг 2.3). Чистая функция без ввода-вывода.
 *
 * nova.localhost:8080  → { kind: 'tenant', slug: 'nova' }
 * admin.localhost      → { kind: 'platform' }   — административный контекст (Phase 4)
 * app.localhost        → { kind: 'app' }        — центральный вход и выбор компании (Phase 3)
 * localhost, a.b.localhost, www.localhost, evil.com, NOVA..localhost → { kind: 'invalid' }
 *
 * Используется только Host. X-Forwarded-Host от клиента не читается: nginx перезаписывает Host сам.
 */

import { hostKind, type Hosting } from '@modulyn/contracts';

/** Зарезервированные поддомены (D10). Тот же список проверяется CHECK-ограничением tenants_slug_not_reserved. */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  'admin', 'api', 'www', 'app', 'mail', 'static', 'assets', 'status', 'help', 'support',
]);

/** DNS-метка: 1–63 символа, a-z, 0-9 и дефис не по краям. Совпадает с CHECK tenants_slug_format. */
export const SLUG_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export type HostResolution =
  | { kind: 'tenant'; slug: string }
  | { kind: 'platform' }
  | { kind: 'app' }
  | { kind: 'invalid' };

const INVALID: HostResolution = { kind: 'invalid' };

/**
 * hosting — базовый домен (режим «метка + домен») или настройка адресов установки (Phase 11, E2):
 * у выделенной установки принимаются только явные адреса входа, платформы и компании.
 */
export function resolveHost(hostHeader: string | undefined, hosting: string | Hosting): HostResolution {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0 || hostHeader.length > 300) return INVALID;
  if (/\s/.test(hostHeader)) return INVALID;

  const lower = hostHeader.toLowerCase();
  const parts = lower.split(':');
  if (parts.length > 2) return INVALID; // IPv6 и мусор
  const hostname = parts[0] ?? '';
  const port = parts[1];
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return INVALID;

  // Пусто, точки (вложенные поддомены), не-ASCII, неверный формат, зарезервированные метки — INVALID.
  const result = hostKind(typeof hosting === 'string' ? { baseDomain: hosting } : hosting, hostname, RESERVED_SUBDOMAINS);
  return result.kind === 'invalid' ? INVALID : result;
}
