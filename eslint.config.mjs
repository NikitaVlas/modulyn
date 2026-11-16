import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nextVitals from 'eslint-config-next/core-web-vitals';
export default [
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/next-env.d.ts'] },
  { ...js.configs.recommended, files: ['**/*.{js,mjs,ts,tsx}'] },
  ...tseslint.configs.recommended.map(config => ({ ...config, files: ['**/*.{ts,tsx}'] })),
  ...nextVitals.map(config => ({ ...config, files: ['apps/web/**/*.{ts,tsx}'] })),
  { files: ['apps/web/**/*.{ts,tsx}'], settings: { next: { rootDir: 'apps/web/' } } },
  { files: ['**/*.{js,mjs,ts,tsx}'], languageOptions: { globals: { process: 'readonly', console: 'readonly', URL: 'readonly', fetch: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', Buffer: 'readonly', AbortSignal: 'readonly', NodeJS: 'readonly', React: 'readonly' } } },
];

