// Идемпотентная подготовка ролей PostgreSQL (D8). Запускается суперпользователем перед миграциями.
//   modulyn_owner — владелец схемы, выполняет миграции (MIGRATION_DATABASE_URL).
//   modulyn_app   — runtime API (DATABASE_URL): без SUPERUSER и BYPASSRLS, не владелец таблиц, поэтому RLS действует.
// Пароли берутся из DB_OWNER_PASSWORD / DB_APP_PASSWORD и не выводятся. Повторный запуск безопасен:
// роли создаются, если их нет, иначе только обновляются пароль и атрибуты.
import pg from 'pg';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const ownerPassword = process.env.DB_OWNER_PASSWORD;
const appPassword = process.env.DB_APP_PASSWORD;
if (!adminUrl || !ownerPassword || !appPassword) {
  console.error('db:roles requires DATABASE_ADMIN_URL, DB_OWNER_PASSWORD and DB_APP_PASSWORD (run pnpm env:init).');
  process.exit(1);
}

const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 5000 });

async function ensureRole(name, password) {
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [name]);
  const verb = exists.rowCount ? 'ALTER' : 'CREATE';
  // Имя роли — константа из этого файла; пароль передаётся как литерал с экранированием pg.
  await client.query(`${verb} ROLE ${client.escapeIdentifier(name)} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION PASSWORD ${client.escapeLiteral(password)}`);
}

try {
  await client.connect();
  const database = (await client.query('SELECT current_database() AS db')).rows[0].db;
  const db = client.escapeIdentifier(database);
  await client.query('BEGIN');
  // Сериализация параллельных запусков (например, два контейнера migrate).
  await client.query("SELECT pg_advisory_xact_lock(hashtext('modulyn:db-roles'))");
  await ensureRole('modulyn_owner', ownerPassword);
  await ensureRole('modulyn_app', appPassword);
  await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
  await client.query(`GRANT CONNECT, TEMPORARY ON DATABASE ${db} TO modulyn_owner, modulyn_app`);
  // Схемой public владеет modulyn_owner: он создаёт таблицы и становится их владельцем.
  await client.query('ALTER SCHEMA public OWNER TO modulyn_owner');
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await client.query('GRANT USAGE ON SCHEMA public TO modulyn_app');
  await client.query('COMMIT');
  console.log('db:roles: roles modulyn_owner and modulyn_app are ready.');
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  // Не печатаем объект ошибки целиком: он может содержать параметры подключения.
  console.error('db:roles failed:', error && typeof error === 'object' && 'code' in error ? `PostgreSQL error ${error.code}` : 'connection or permission problem');
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
