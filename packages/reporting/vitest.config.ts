import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * The package's own vitest config exists for ONE reason, and it is temporary.
 *
 * `@acct/domain`'s `exports` map admits only the package root, and
 * `packages/domain/src/index.ts` — integrator-owned — does not re-export
 * `./statements` yet. Until it does, `import { composeProfitAndLoss } from
 * '@acct/domain'` cannot resolve at runtime, so nothing in this package could be
 * tested at all. The alias below points that specifier at `verify/domain.ts`,
 * which re-exports the SAME compiled modules `@acct/database` and `@acct/ledger`
 * already load, so there is one `Decimal` and one `AppError` in the process.
 *
 * DELETE THIS FILE together with `verify/` and `tsconfig.verify.json` when
 * INTEGRATION NOTE 1 lands. `src/` imports `@acct/domain` and nothing else; the
 * shipped `tsconfig.json` has no alias, so the published build never sees this.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@acct/domain': resolve(__dirname, 'verify/domain.ts'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 240_000,
  },
});
