// Ручной запуск очистки устаревших технических записей (Phase 9, F7): pnpm db:cleanup.
// Вызывает ту же функцию БД, что и API раз в час, под runtime-ролью (DATABASE_URL). Печатает только числа.
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) { console.error('db:cleanup requires DATABASE_URL (run pnpm env:init)'); process.exit(1); }
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
try {
  await client.connect();
  const { rows } = await client.query('SELECT modulyn_cleanup() AS result');
  console.log('db:cleanup:', JSON.stringify(rows[0].result));
} catch (error) {
  console.error('db:cleanup failed:', error?.code ?? error?.message ?? 'unknown error');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
