import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Brings the test database up to the current schema and creates the runtime
    // login role, so `pnpm test` works from a clean database rather than assuming
    // someone ran `pnpm stack:up` in the right order.
    globalSetup: ['./src/integration/global-setup.ts'],
    setupFiles: ['./src/integration/setup-file.ts'],
    // The isolation tests take real locks and close real periods against one
    // shared database. Serial by design, not by accident.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
