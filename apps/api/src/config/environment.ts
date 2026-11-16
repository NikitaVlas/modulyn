export interface Environment { port: number; databaseUrl: string; nodeEnv: 'development' | 'test' | 'production' }
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
  return { port, databaseUrl: env.DATABASE_URL, nodeEnv: nodeEnv as Environment['nodeEnv'] };
}
