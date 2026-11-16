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
}

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

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
  return { port, databaseUrl: env.DATABASE_URL, nodeEnv: nodeEnv as Environment['nodeEnv'], appBaseDomain, trustDevProxyHost };
}
