// Конфигурация Prisma CLI (generate, validate, migrate).
// Миграции выполняет владелец схемы (MIGRATION_DATABASE_URL), а не runtime-роль API.
// URL необязателен для generate/validate, поэтому process.env, а не env() (который бросает ошибку).
import { defineConfig } from 'prisma/config';

const url = process.env.MIGRATION_DATABASE_URL;

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(url ? { datasource: { url } } : {}),
});
