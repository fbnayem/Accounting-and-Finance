/**
 * @acct/close — period close, the close checklist, account reconciliation and the
 * immutable statement snapshot.
 *
 * A package rather than a controller-level service for the same reason
 * @acct/banking and @acct/inventory are: the rules here are read by things that
 * are not HTTP handlers. `assertPeriodReadyForHardClose` is called by
 * finance-setup's period transition, `periodCloseReadiness` is what a dashboard
 * and a scheduled close-status job both want, and none of it may be a second
 * definition of "complete" living beside the first.
 *
 * What this package refuses to do is compose a journal. Period-end accruals,
 * prepayments and deferrals (F-1004) live here in `PeriodEndEntryService`, and
 * every one of their postings goes through `DocumentPostingService` under a named
 * catalog rule — EXPENSE_ACCRUAL, PREPAID_PURCHASE, DEFERRED_REVENUE_BILLING,
 * PREPAID_AMORTIZATION, REVENUE_RECOGNIZED — so nothing in this package writes to
 * journal_entries or journal_lines. What it writes is the schedule those postings
 * serve; the ledger is read only to compute the GL side of a reconciliation.
 */
export * from './readiness';
export * from './internals';
export * from './approvals';
export * from './close-run.service';
export * from './checklist.service';
export * from './reconciliation.service';
export * from './reconciling-items.service';
export * from './period-end.service';
export * from './snapshot.service';
export * from './period-gate';
