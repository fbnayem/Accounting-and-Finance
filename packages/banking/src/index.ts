/**
 * @acct/banking — bank feeds, matching, reconciliation, transfers and clearing.
 *
 * A package for the same reason @acct/ledger and @acct/subledger are: the worker
 * syncs feeds on a schedule and alerts on expiring connections, and its only
 * alternatives were an HTTP call back into its own API or its own INSERT.
 *
 * doc 21's dependency rule for this phase is the sharp one: "Phase 4 banking
 * consumes AR/AP payment allocation services instead of editing customer/vendor
 * balances." Matching a bank line to an invoice does not move `amount_paid` here
 * — it calls the same allocation path a manually-entered receipt does, so there
 * is one place that decides what settling an invoice means.
 */
export * from './adapters';
export * from './import.service';
export * from './reconciliation.service';
export * from './matching.service';
export * from './treasury.service';
export * from './accounts.service';
