/**
 * @acct/projects — projects, project billing, budgets, commitments and
 * forecasts (doc 10).
 *
 * Framework-free for the same reason @acct/banking is: management accounting is
 * consumed by the API, by reports and eventually by the worker, and a NestJS
 * dependency here would make two of those three impossible without HTTP.
 *
 * The three rules that shape the package:
 *
 *   - Budget actuals derive from posted `journal_lines` at read time (Phase 5
 *     exit criterion 6). No budget row stores an actual; the ledger is the only
 *     source that cannot drift from itself.
 *   - "Never overwrite approved budget" (doc 10). Revision copies to a new
 *     version; the 0043 guards make the old amounts physically uneditable.
 *   - Nothing here posts. Project billing produces an AR invoice DRAFT through
 *     @acct/subledger, forecasts never touch the ledger at all, and budget
 *     control returns verdicts for the spending mutation to enforce.
 */
export * from './billing';
export * from './variance';
export * from './projects.service';
export * from './budgets.service';
export * from './budget-control.service';
export * from './commitments.service';
export * from './forecasts.service';
