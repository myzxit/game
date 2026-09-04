import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15000,
    pool: 'forks',
  },
  resolve: {
    alias: {
      '@titan/shared': new URL('./packages/shared/src/index.ts', import.meta.url).pathname,
      '@titan/server': new URL('./packages/server/src/index.ts', import.meta.url).pathname,
    },
  },
});
