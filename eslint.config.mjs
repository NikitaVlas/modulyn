import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextVitals from 'eslint-config-next/core-web-vitals';
export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/next-env.d.ts', 'apps/api/src/generated/**'] },
  { ...js.configs.recommended, files: ['**/*.{js,mjs,ts,tsx}'] },
  ...tseslint.configs.recommended.map(config => ({ ...config, files: ['**/*.{ts,tsx}'] })),
  ...nextVitals.map(config => ({ ...config, files: ['apps/web/**/*.{ts,tsx}'] })),
  { files: ['apps/web/**/*.{ts,tsx}'], settings: { next: { rootDir: 'apps/web/' } } },
  { files: ['**/*.{js,mjs,ts,tsx}'], languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', fetch: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', Buffer: 'readonly', AbortSignal: 'readonly', NodeJS: 'readonly', React: 'readonly' } } },
  // Изоляция данных (2.4): сгенерированный Prisma-клиент и pg доступны только модулю database.
  // Остальной код работает с данными компании через TenantDb, который ставит контекст для RLS.
  {
    files: ['apps/api/src/**/*.ts'],
    ignores: ['apps/api/src/database/**'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{ group: ['**/generated/prisma/**', '**/generated/prisma'], message: 'Use TenantDb or a repository in src/database; direct Prisma access bypasses tenant context.' }],
        paths: [
          { name: '@prisma/client', message: 'Use TenantDb or a repository in src/database.' },
          { name: '@prisma/adapter-pg', message: 'Database connections are created only in src/database.' },
          { name: 'pg', message: 'Database connections are created only in src/database.' },
        ],
      }],
    },
  },
  // Аккаунты и сессии (таблицы без RLS) читает только модуль auth (Phase 3). Бизнес-модули получают пользователя от guard.
  {
    files: ['apps/api/src/**/*.ts'],
    // app.module.ts — корень композиции, только регистрирует провайдеры.
    ignores: ['apps/api/src/database/**', 'apps/api/src/auth/**', 'apps/api/src/app.module.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['**/generated/prisma/**', '**/generated/prisma'], message: 'Use TenantDb or a repository in src/database; direct Prisma access bypasses tenant context.' },
          { group: ['**/database/auth-store.service.js'], message: 'Accounts and sessions are accessed only by src/auth; use the principal set by AuthGuard.' },
        ],
        paths: [
          { name: '@prisma/client', message: 'Use TenantDb or a repository in src/database.' },
          { name: '@prisma/adapter-pg', message: 'Database connections are created only in src/database.' },
          { name: 'pg', message: 'Database connections are created only in src/database.' },
        ],
      }],
    },
  },
];
