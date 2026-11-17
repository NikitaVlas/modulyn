// Резервная копия и проверка восстановления (Phase 9, подшаг 9.4, решение F4).
//   node backup.mjs backup                 — pg_dump (формат custom) в backups/modulyn-<время>.dump и сводка <то же>.json
//   node backup.mjs restore-check <файл>   — восстановление в ОТДЕЛЬНУЮ базу <POSTGRES_DB>_restore_check, сверка, удаление этой базы
// Запускается через pnpm db:backup / pnpm db:restore-check (загружают .env). Рабочая база не меняется.
// pg_dump/pg_restore выполняются в контейнере db (Docker Compose), поэтому их версия совпадает с сервером.
// Сводка содержит только числа и имена таблиц — без данных.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import pg from 'pg';

const root = resolve(import.meta.dirname, '../../..');
const user = process.env.POSTGRES_USER;
const database = process.env.POSTGRES_DB;
const adminUrl = process.env.DATABASE_ADMIN_URL;
if (!user || !database || !adminUrl) {
  console.error('db:backup requires POSTGRES_USER, POSTGRES_DB and DATABASE_ADMIN_URL (run pnpm env:init).');
  process.exit(1);
}
const CHECK_DB = `${database}_restore_check`;

function compose(args, { stdin, stdout } = {}) {
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'db', ...args], {
    cwd: root, stdio: [stdin ?? 'ignore', stdout ?? 'inherit', 'inherit'],
  });
  if (r.error) throw new Error(`docker is not available: ${r.error.code}`);
  if (r.status !== 0) throw new Error(`${args[0]} failed (exit ${r.status}). Is the stack running? pnpm stack:up`);
}

function urlFor(db) {
  const url = new URL(adminUrl);
  url.pathname = '/' + db;
  return url.toString();
}

async function withClient(url, fn) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

/** Что сверяем: число строк в каждой таблице, миграции, RLS, права runtime-роли. Без содержимого строк. */
async function inspect(url) {
  return withClient(url, async c => {
    const tables = (await c.query(`
      SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
             has_table_privilege('modulyn_app', c.oid, 'SELECT') AS app_select
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`)).rows;
    const counts = {};
    for (const t of tables) counts[t.name] = Number((await c.query(`SELECT count(*)::bigint AS n FROM ${c.escapeIdentifier(t.name)}`)).rows[0].n);
    const migrations = (await c.query('SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name')).rows.map(r => r.migration_name);
    const policies = Number((await c.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname = 'public'")).rows[0].n);
    const functions = (await c.query("SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' ORDER BY 1")).rows.map(r => r.proname);
    return {
      counts, migrations, policies, functions,
      rls: tables.filter(t => t.rls && t.force).map(t => t.name),
      appTables: tables.filter(t => t.app_select).map(t => t.name),
    };
  });
}

async function backup() {
  const dir = resolve(root, 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = resolve(dir, `modulyn-${stamp}.dump`);
  const summary = await inspect(adminUrl);
  const fd = openSync(file, 'w', 0o600);
  try { compose(['pg_dump', '-U', user, '-d', database, '--format=custom', '--no-password'], { stdout: fd }); }
  finally { closeSync(fd); }
  writeFileSync(file.replace(/\.dump$/, '.json'), JSON.stringify({ createdAt: new Date().toISOString(), database, ...summary }, null, 2), { mode: 0o600 });
  const rows = Object.values(summary.counts).reduce((a, b) => a + b, 0);
  console.log(`db:backup: ${basename(file)} — ${Object.keys(summary.counts).length} tables, ${rows} rows, ${summary.migrations.length} migrations.`);
  console.log('Keep the copy away from this server, together with the keys from .env (see docs/operations.md).');
}

async function restoreCheck(fileArg) {
  if (!fileArg) throw new Error('Usage: pnpm db:restore-check backups/<file>.dump');
  const file = resolve(root, fileArg);
  if (!existsSync(file)) throw new Error(`File not found: ${fileArg}`);
  const manifestFile = file.replace(/\.dump$/, '.json');
  const expected = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, '')) : null;

  compose(['dropdb', '-U', user, '--if-exists', CHECK_DB]);
  compose(['createdb', '-U', user, CHECK_DB]);
  const fd = openSync(file, 'r');
  try { compose(['pg_restore', '-U', user, '-d', CHECK_DB, '--exit-on-error', '--no-password'], { stdin: fd }); }
  finally { closeSync(fd); }

  const problems = [];
  try {
    const actual = await inspect(urlFor(CHECK_DB));
    if (expected) {
      for (const [table, n] of Object.entries(expected.counts)) {
        if (actual.counts[table] !== n) problems.push(`rows in ${table}: ${actual.counts[table]} restored, ${n} in the copy summary`);
      }
      for (const key of ['migrations', 'rls', 'appTables', 'functions']) {
        if (JSON.stringify(actual[key]) !== JSON.stringify(expected[key])) problems.push(`${key} differ`);
      }
      if (actual.policies !== expected.policies) problems.push(`policies: ${actual.policies} restored, ${expected.policies} expected`);
    } else {
      problems.push('no summary file next to the copy — only a structural check was possible');
    }
    if (actual.migrations.length === 0) problems.push('no applied migrations in the restored database');
    // RLS работает и после восстановления: runtime-роль без контекста компании не видит заявок.
    const appUrl = new URL(process.env.DATABASE_URL ?? '');
    if (appUrl.username === 'modulyn_app') {
      appUrl.pathname = '/' + CHECK_DB;
      const leadsWithoutContext = await withClient(appUrl.toString(), async c => Number((await c.query('SELECT count(*)::int AS n FROM leads')).rows[0].n));
      if (leadsWithoutContext !== 0) problems.push(`RLS: runtime role sees ${leadsWithoutContext} leads without company context`);
    }
    const rows = Object.values(actual.counts).reduce((a, b) => a + b, 0);
    if (problems.length === 0) {
      console.log(`db:restore-check: OK — ${basename(file)} restored into ${CHECK_DB}: ${Object.keys(actual.counts).length} tables, ${rows} rows, ${actual.migrations.length} migrations, RLS on ${actual.rls.length} tables; counts match the copy summary.`);
    }
  } finally {
    if (!process.argv.includes('--keep')) compose(['dropdb', '-U', user, '--if-exists', CHECK_DB]);
  }
  if (problems.length > 0) {
    console.error('db:restore-check: FAILED\n- ' + problems.join('\n- '));
    process.exitCode = 1;
  }
}

const [command, arg] = process.argv.slice(2);
try {
  if (command === 'backup') await backup();
  else if (command === 'restore-check') await restoreCheck(arg);
  else { console.error('Usage: node backup.mjs backup | restore-check <file>'); process.exitCode = 1; }
} catch (error) {
  console.error(`db:${command ?? 'backup'} failed: ${error.message}`);
  process.exitCode = 1;
}
