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

export function resolveHost(hostHeader: string | undefined, baseDomain: string): HostResolution {
  if (typeof hostHeader !== 'string' || hostHeader.length === 0 || hostHeader.length > 300) return INVALID;
  if (/\s/.test(hostHeader)) return INVALID;

  const lower = hostHeader.toLowerCase();
  const parts = lower.split(':');
  if (parts.length > 2) return INVALID; // IPv6 и мусор
  const hostname = parts[0] ?? '';
  const port = parts[1];
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return INVALID;

  const suffix = '.' + baseDomain;
  if (!hostname.endsWith(suffix)) return INVALID;
  const label = hostname.slice(0, -suffix.length);
  if (!SLUG_PATTERN.test(label)) return INVALID; // пусто, точки (вложенные поддомены), не-ASCII, неверный формат

  if (label === 'admin') return { kind: 'platform' };
  if (label === 'app') return { kind: 'app' };
  if (RESERVED_SUBDOMAINS.has(label)) return INVALID;
  return { kind: 'tenant', slug: label };
}
