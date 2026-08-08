import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['./src/integration/global-setup.ts'],
    // Integration tests take real row locks and deliberately provoke deadlocks
    // and lock timeouts. Running files in parallel would have them interfere with
    // each other's timing, so the suite is serial by design rather than by accident.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
