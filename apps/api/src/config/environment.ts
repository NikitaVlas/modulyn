export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  /** https://accounts.google.com; в тестах — локальный поддельный OIDC-провайдер по http. */
  issuer: string;
}

export interface Environment {
  port: number;
  databaseUrl: string;
  nodeEnv: 'development' | 'test' | 'production';
  /** Базовый домен, под которым живут поддомены компаний: localhost локально, modulyn.app в production. */
  appBaseDomain: string;
  /**
   * Только для pnpm dev: Next.js dev-сервер проксирует /api на 127.0.0.1:3001 и подменяет Host,
   * а исходный Host передаёт в X-Forwarded-Host. В production флаг запрещён: там Host сохраняет nginx.
   */
  trustDevProxyHost: boolean;
  /** API доступен только через nginx, который сам записывает X-Forwarded-For: IP клиента для ограничения входа (A9). */
  trustProxy: boolean;
  /** Схема и порт публичных адресов (http://app.localhost:8080). http разрешён только для базового домена localhost. */
  publicScheme: 'http' | 'https';
  publicPort: number | undefined;
  /** Отдельный ключ подписи JWT для каждого контекста (A3): токен одного контекста не проходит проверку в другом. */
  jwtSecrets: { tenant: string; app: string; platform: string };
  /** Вход через Google (3.9). Не задан — кнопка и маршруты Google выключены. */
  google: GoogleConfig | undefined;
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.length < 32) throw new Error(`${name} must be at least 32 characters (run pnpm env:init)`);
  return value;
}

export function parseEnvironment(env: NodeJS.ProcessEnv): Environment {
  const nodeEnv = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(nodeEnv)) throw new Error('Invalid NODE_ENV');
  const rawPort = env.API_PORT ?? '3001';
  if (!/^\d+$/.test(rawPort)) throw new Error('API_PORT must be an integer');
  const port = Number(rawPort);
  if (port < 1 || port > 65535) throw new Error('API_PORT must be between 1 and 65535');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  try {
    const url = new URL(env.DATABASE_URL);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || !url.password || url.pathname.length < 2) throw new Error();
  } catch { throw new Error('DATABASE_URL must be a PostgreSQL URL with database and credentials'); }
  const appBaseDomain = env.APP_BASE_DOMAIN ?? 'localhost';
  if (!HOSTNAME.test(appBaseDomain)) throw new Error('APP_BASE_DOMAIN must be a lower-case hostname without port or scheme');
  const trustDevProxyHost = env.TRUST_DEV_PROXY_HOST === 'true';
  if (trustDevProxyHost && nodeEnv === 'production') throw new Error('TRUST_DEV_PROXY_HOST is not allowed in production');
  const trustProxy = env.TRUST_PROXY === 'true';

  const localOnly = appBaseDomain === 'localhost';
  const publicScheme = env.PUBLIC_SCHEME ?? (localOnly ? 'http' : 'https');
  if (publicScheme !== 'http' && publicScheme !== 'https') throw new Error('PUBLIC_SCHEME must be http or https');
  // Без https cookies нельзя пометить Secure: допустимо только на локальной машине.
  if (publicScheme === 'http' && !localOnly) throw new Error('PUBLIC_SCHEME=http is allowed only with APP_BASE_DOMAIN=localhost');
  let publicPort: number | undefined;
  if (env.PUBLIC_PORT) {
    if (!/^\d+$/.test(env.PUBLIC_PORT) || Number(env.PUBLIC_PORT) < 1 || Number(env.PUBLIC_PORT) > 65535) throw new Error('PUBLIC_PORT must be a port number');
    publicPort = Number(env.PUBLIC_PORT);
  }

  const jwtSecrets = {
    tenant: secret(env, 'JWT_SECRET_TENANT'),
    app: secret(env, 'JWT_SECRET_APP'),
    platform: secret(env, 'JWT_SECRET_PLATFORM'),
  };
  if (new Set(Object.values(jwtSecrets)).size !== 3) throw new Error('JWT_SECRET_TENANT, JWT_SECRET_APP and JWT_SECRET_PLATFORM must differ');

  let google: GoogleConfig | undefined;
  if (env.GOOGLE_CLIENT_ID || env.GOOGLE_CLIENT_SECRET) {
    if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together');
    const issuer = env.GOOGLE_ISSUER ?? 'https://accounts.google.com';
    let issuerUrl: URL;
    try { issuerUrl = new URL(issuer); } catch { throw new Error('GOOGLE_ISSUER must be a URL'); }
    if (issuerUrl.protocol !== 'https:' && (nodeEnv === 'production' || !localOnly)) throw new Error('GOOGLE_ISSUER must use https');
    google = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, issuer };
  }

  return {
    port, databaseUrl: env.DATABASE_URL, nodeEnv: nodeEnv as Environment['nodeEnv'], appBaseDomain, trustDevProxyHost,
    trustProxy, publicScheme, publicPort, jwtSecrets, google,
  };
}

/** Публичный адрес поддомена: originFor(env, 'app') → http://app.localhost:8080. */
export function originFor(env: Environment, label: string): string {
  const port = env.publicPort && !((env.publicScheme === 'http' && env.publicPort === 80) || (env.publicScheme === 'https' && env.publicPort === 443))
    ? ':' + env.publicPort : '';
  return `${env.publicScheme}://${label}.${env.appBaseDomain}${port}`;
}
