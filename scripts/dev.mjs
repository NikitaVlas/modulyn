import { spawn, spawnSync } from 'node:child_process';
import { loadEnvFile } from 'node:process';
loadEnvFile('.env');
const windows = process.platform === 'win32';
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('Start development with pnpm dev');
const isScript = /\.[cm]?js$/.test(pnpmCli);
const pnpmCommand = isScript ? process.execPath : pnpmCli;
const pnpmPrefix = isScript ? [pnpmCli] : [];
function pnpm(args) { return spawn(pnpmCommand, [...pnpmPrefix, ...args], { stdio: 'inherit' }); }
for (const name of ['@modulyn/contracts', '@modulyn/api']) {
  const result = spawnSync(pnpmCommand, [...pnpmPrefix, '--filter', name, 'build'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const children = [
  pnpm(['--filter', '@modulyn/contracts', 'exec', 'tsc', '--watch', '--preserveWatchOutput']),
  pnpm(['--filter', '@modulyn/api', 'exec', 'tsc', '--watch', '--preserveWatchOutput']),
  // Next.js dev проксирует /api и передаёт исходный Host в X-Forwarded-Host (только для разработки).
  // Публичные адреса в режиме dev — Next.js на :3000 (перенаправления между app.localhost и поддоменами).
  spawn(process.execPath, ['--watch', 'apps/api/dist/main.js'], { stdio: 'inherit', env: { ...process.env, TRUST_DEV_PROXY_HOST: 'true', PUBLIC_PORT: '3000' } }),
  pnpm(['--filter', '@modulyn/web', 'dev']),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid) continue;
    if (windows) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  process.exitCode = code;
}
for (const child of children) { child.on('error', () => stop(1)); child.on('exit', code => { if (!stopping) stop(code ?? 1); }); }
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

