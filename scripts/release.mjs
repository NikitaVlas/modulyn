// Выпуск версии Modulyn (Phase 11, E8): четыре образа с номером версии из текущего кода.
//   pnpm release 0.11.0            — собрать локально: <registry>/modulyn-{api,migrate,web,backup}:0.11.0
//   pnpm release 0.11.0 --push     — собрать и отправить в закрытое хранилище образов (нужен docker login)
// Хранилище — MODULYN_REGISTRY (например ghcr.io/<owner>); по умолчанию modulyn.local (только эта машина).
// Сервер клиента скачивает ровно эту версию (MODULYN_VERSION в его .env); повторно ту же версию не выпускают.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const [version, ...flags] = process.argv.slice(2);
const push = flags.includes('--push');
const registry = (process.env.MODULYN_REGISTRY || 'modulyn.local').replace(/\/+$/, '');
if (!version || !/^\d+\.\d+\.\d+(-[0-9a-z.]+)?$/i.test(version)) {
  console.error('Usage: pnpm release <version> [--push]   (version like 0.11.0)');
  process.exit(1);
}
if (push && registry === 'modulyn.local') {
  console.error('Set MODULYN_REGISTRY (e.g. ghcr.io/<owner>) to push.');
  process.exit(1);
}

function run(args) {
  console.log(`$ docker ${args.join(' ')}`);
  const r = spawnSync('docker', args, { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.trim();
if (dirty) console.warn('release: WARNING — uncommitted changes are included in the images. Release from a commit.');
const commit = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim() || 'unknown';

const images = [
  { name: 'api', dockerfile: 'apps/api/Dockerfile', target: 'runtime' },
  { name: 'migrate', dockerfile: 'apps/api/Dockerfile', target: 'migrate' },
  { name: 'backup', dockerfile: 'apps/api/Dockerfile', target: 'backup' },
  { name: 'web', dockerfile: 'apps/web/Dockerfile', target: 'runtime' },
];
for (const image of images) {
  const tag = `${registry}/modulyn-${image.name}:${version}`;
  run(['build', '-f', image.dockerfile, '--target', image.target, '-t', tag,
    '--label', `org.opencontainers.image.version=${version}`, '--label', `org.opencontainers.image.revision=${commit}`, '.']);
  if (push) run(['push', tag]);
}
console.log(`release: ${version} (${commit}) — ${images.map(i => `modulyn-${i.name}`).join(', ')} ${push ? `pushed to ${registry}` : `built locally as ${registry}/…`}`);
