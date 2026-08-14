/**
 * @acct/domain — the shared vocabulary named by doc 21 Phase 0:
 * "Shared money, date, currency, pagination, API error and identifier libraries."
 *
 * Everything here is pure. No database, no HTTP, no clock beyond what is passed in.
 * That is what lets the ADR-0006 rounding chain be unit-tested as a specification
 * rather than as an integration.
 */
export * from './decimal';
export * from './currency';
export * from './money';
export * from './rounding';
export * from './posting';
export * from './posting-rules';
export * from './dates';
export * from './errors';
export * from './ids';
export * from './pagination';
export * from './context';
export * from './principal';
export * from './concurrency';
export * from './documents';
export * from './banking';
export * from './costing';
export * from './depreciation';
export * from './budgeting';
