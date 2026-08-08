/**
 * @acct/database — the transactional core named by doc 21 Phase 0:
 * "Transaction helper, idempotency middleware, audit helper and transactional
 * outbox base implementation."
 *
 * ADR-0008 §2 draws the Prisma / raw SQL boundary and this package sits on the
 * raw-SQL side of it, deliberately: everything here is either inside a
 * transaction that takes row locks, or is the thing that manages those
 * transactions. "If Gate C, D, E or G tests it, it is raw SQL."
 */
export * from './pool';
export * from './errors';
export * from './transaction';
export * from './tenant';
export * from './migrator';
export * from './outbox';
export * from './idempotency';
export * from './audit';
export * from './health';
