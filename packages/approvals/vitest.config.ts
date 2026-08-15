import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['./src/integration/global-setup.ts'],
    // The engine tests take row locks, provoke deferred constraint triggers at
    // COMMIT and deliberately race two approvers at one quorum. Serial by design.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
