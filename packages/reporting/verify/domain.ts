/**
 * TEMPORARY BUILD SCAFFOLD — DELETE THIS DIRECTORY, `tsconfig.verify.json` AND THE
 * ALIAS IN `vitest.config.ts` AS SOON AS THE INTEGRATOR LANDS INTEGRATION NOTE 1.
 *
 * `packages/domain/src/statements.ts` exists and is built into
 * `packages/domain/dist/statements.js`, but `packages/domain/src/index.ts` — an
 * integrator-owned file no agent may edit — does not re-export it yet, and
 * `@acct/domain`'s package.json `exports` map admits only the package root. So
 * `import { composeProfitAndLoss } from '@acct/domain'` is the correct import,
 * the one every source file in this package uses, and it does not resolve today.
 *
 * Rather than leave the package unbuildable and untested until that one line
 * lands, this module re-exports the same two compiled modules under one name, and
 * `tsconfig.verify.json` / `vitest.config.ts` point `@acct/domain` at it. Nothing
 * in `src/` imports it, `tsconfig.json` does not know it exists, and the shipped
 * build is the unaliased one — so this scaffold cannot change what the package
 * compiles to, only whether it could be checked before the blocker cleared.
 *
 * It re-exports from `dist/` rather than from `src/` on purpose: `@acct/database`
 * and `@acct/ledger` resolve `@acct/domain` to those same compiled files, so
 * there is exactly one `Decimal` class and one `AppError` class in the process.
 * A second copy would make `Decimal.from(decimal)`'s `instanceof` check fail and
 * turn an exact amount into a parse error, which is precisely the class of bug a
 * test harness must not introduce.
 *
 * Once `export * from './statements';` is in the domain index, the two `export *`
 * below export the same names, TypeScript drops the ambiguous ones, and every use
 * of `composeProfitAndLoss` in this package stops compiling under the verify
 * config. That is deliberate: the scaffold fails loudly rather than lingering.
 */
export * from '../../domain/dist/index';
export * from '../../domain/dist/statements';
