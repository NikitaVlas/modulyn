import { existsSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const path = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(path)) { console.log('.env already exists; kept unchanged.'); }
else {
  const password = randomBytes(24).toString('hex');
  writeFileSync(path, ['POSTGRES_USER=modulyn', 'POSTGRES_PASSWORD=' + password, 'POSTGRES_DB=modulyn', 'POSTGRES_PORT=5433', 'DATABASE_URL=postgresql://modulyn:' + password + '@127.0.0.1:5433/modulyn', 'API_PORT=3001', 'NODE_ENV=development', 'HTTP_PORT=8080', ''].join('\n'), { mode: 0o600, flag: 'wx' });
  console.log('Created local .env with a random password (not printed).');
}
