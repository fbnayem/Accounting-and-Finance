import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['**/src/**/*.test.ts', '**/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    // Integration tests take real row locks against a real PostgreSQL; running
    // them in parallel across files would have them deadlock on each other.
    poolOptions: { threads: { singleThread: false } },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['**/dist/**', '**/*.test.ts', '**/generated/**'],
    },
  },
});
