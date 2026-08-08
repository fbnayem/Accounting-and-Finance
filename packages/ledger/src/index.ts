/**
 * @acct/ledger — the accounting kernel.
 *
 * doc 21 opens the phase plan with: "Later modules must call the accounting kernel
 * through commands/services; they must not create ledger rows directly." That is a
 * statement about module boundaries, and it is only true if there is a module.
 *
 * These classes are the only writers of `journal_entries` and `journal_lines`
 * anywhere in the platform. They are framework-free on purpose: `apps/api` wraps
 * them as Nest providers, and `apps/worker` — which posts scheduled reversals and
 * generates recurring journals with no HTTP request in sight — constructs them
 * directly. Before this package existed the worker's only options were to call the
 * API over the network or to write its own INSERT, and the second one is how a
 * second posting path is born.
 */
export * from './numbering';
export * from './projection.service';
export * from './posting.service';
export * from './journal.service';
export * from './rules.service';
export * from './reports.service';
export * from './chart.service';
export * from './scheduler';
