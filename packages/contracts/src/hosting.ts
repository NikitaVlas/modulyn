/**
 * Адреса установки (Phase 11, E2, E3). Общие правила для API и интерфейса — чтобы они одинаково понимали,
 * какой хост что означает и какие ссылки строить.
 *
 * Два режима:
 * - по умолчанию — «метка + базовый домен»: nova.<домен> — компания, app.<домен> — вход, admin.<домен> — платформа
 *   (локальная разработка, тесты, общая многоклиентская платформа);
 * - явные адреса выделенной установки у клиента: APP_HOST, PLATFORM_HOST и TENANT_HOSTS («crm.example.de=nova»).
 *   Принимаются только перечисленные хосты; всё остальное — как неизвестный хост (404).
 * Одна компания в TENANT_HOSTS — режим одной компании (E3).
 */

export interface Hosting {
  /** Базовый домен (APP_BASE_DOMAIN): режим «метка + домен» и запасной вариант для ссылок. */
  baseDomain: string;
  /** Явные адреса — только у выделенной установки. */
  explicit?: { app: string; platform: string; tenants: Record<string, string> };
}

export type HostKind =
  | { kind: 'tenant'; slug: string }
  | { kind: 'platform' }
  | { kind: 'app' }
  | { kind: 'invalid' };

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const SLUG = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Читает настройку адресов из окружения. Ошибка настройки — исключение: установка не должна запуститься «наполовину». */
export function parseHosting(env: Record<string, string | undefined>): Hosting {
  const baseDomain = (env.APP_BASE_DOMAIN || 'localhost').toLowerCase();
  const app = env.APP_HOST?.trim().toLowerCase() || '';
  const platform = env.PLATFORM_HOST?.trim().toLowerCase() || '';
  const tenantsRaw = env.TENANT_HOSTS?.trim() || '';
  if (!app && !platform && !tenantsRaw) return { baseDomain };
  if (!app || !platform || !tenantsRaw) throw new Error('APP_HOST, PLATFORM_HOST and TENANT_HOSTS must be set together');
  const tenants: Record<string, string> = {};
  for (const pair of tenantsRaw.split(',').map(s => s.trim()).filter(Boolean)) {
    const [host = '', slug = ''] = pair.split('=').map(s => s.trim().toLowerCase());
    if (!HOSTNAME.test(host) || !SLUG.test(slug)) throw new Error(`TENANT_HOSTS: expected host=slug, got "${pair}"`);
    if (tenants[host]) throw new Error(`TENANT_HOSTS: duplicate host ${host}`);
    tenants[host] = slug;
  }
  const all = [app, platform, ...Object.keys(tenants)];
  for (const host of [app, platform]) if (!HOSTNAME.test(host)) throw new Error(`Invalid host name: ${host}`);
  if (new Set(all).size !== all.length) throw new Error('APP_HOST, PLATFORM_HOST and company hosts must all be different');
  if (Object.keys(tenants).length === 0) throw new Error('TENANT_HOSTS: at least one company host is required');
  return { baseDomain, explicit: { app, platform, tenants } };
}

/** Что означает имя хоста (без порта). */
export function hostKind(hosting: Hosting, hostname: string, reserved: ReadonlySet<string> = new Set()): HostKind {
  const name = hostname.toLowerCase();
  if (hosting.explicit) {
    if (name === hosting.explicit.app) return { kind: 'app' };
    if (name === hosting.explicit.platform) return { kind: 'platform' };
    const slug = hosting.explicit.tenants[name];
    return slug ? { kind: 'tenant', slug } : { kind: 'invalid' };
  }
  const suffix = '.' + hosting.baseDomain;
  if (!name.endsWith(suffix)) return { kind: 'invalid' };
  const label = name.slice(0, -suffix.length);
  if (!SLUG.test(label)) return { kind: 'invalid' };
  if (label === 'admin') return { kind: 'platform' };
  if (label === 'app') return { kind: 'app' };
  if (reserved.has(label)) return { kind: 'invalid' };
  return { kind: 'tenant', slug: label };
}

/** Имя хоста для входа ('app'), платформы ('admin') или компании (slug). */
export function hostFor(hosting: Hosting, label: string): string {
  if (hosting.explicit) {
    if (label === 'app') return hosting.explicit.app;
    if (label === 'admin') return hosting.explicit.platform;
    const found = Object.entries(hosting.explicit.tenants).find(([, slug]) => slug === label);
    if (found) return found[0];
  }
  return `${label}.${hosting.baseDomain}`;
}

/** Режим одной компании (E3): выделенная установка ровно с одной компанией. */
export function singleCompany(hosting: Hosting): string | null {
  const slugs = hosting.explicit ? Object.values(hosting.explicit.tenants) : [];
  return slugs.length === 1 ? slugs[0]! : null;
}
