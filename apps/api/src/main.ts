import 'reflect-metadata';
import { parseEnvironment } from './config/environment.js';
import { createApplication } from './bootstrap.js';
async function main() {
  const config = parseEnvironment(process.env);
  const app = await createApplication();
  await app.listen(config.port, config.nodeEnv === 'production' ? '0.0.0.0' : '127.0.0.1');
}
main().catch(() => { console.error('API startup failed. Check required environment variables and port availability.'); process.exitCode = 1; });

