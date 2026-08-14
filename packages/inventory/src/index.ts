/**
 * @acct/inventory — items, warehouses, stock movements, costing and landed
 * cost: doc 08, built in Phase 5.
 *
 * A package for the same reason @acct/banking is: framework-free services over
 * a Pool, so the same code serves the API and any worker that moves stock on a
 * schedule. The costing arithmetic itself lives in @acct/domain (`consumeFifo`,
 * `weightedAverageIssue`, `allocateLandedCost`) where it is pure and
 * unit-tested as a specification; this package owns the persistence protocol
 * around it — the ADR-0004 §3 lock order, the consumption rows exit criterion
 * 3 reproduces COGS from, and the one place a stock document becomes POSTED.
 */
export * from './stock';
export * from './lookup';
export * from './items.service';
export * from './warehouses.service';
export * from './documents.service';
export * from './posting.service';
export * from './counts.service';
export * from './landed-cost.service';
export * from './reports.service';
