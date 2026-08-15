/**
 * @acct/reporting — the Phase 6 statements, the drill, custom report definitions,
 * the export job and the auditor workspace.
 *
 * A package rather than a controller directory for the same reason @acct/ledger
 * is one: the close worker, the report-run executor and the snapshot path all
 * need to compose a statement, and their alternatives were an HTTP call back into
 * their own API or a second implementation of the arithmetic.
 *
 * The one rule this package is organised around: it composes NOTHING. Profit and
 * loss, balance sheet, cash flow, retained earnings and every tie check come from
 * the pure engine in `@acct/domain/statements`. This package loads a trial
 * balance, hands it over, and serves or persists what comes back. There is no SQL
 * here that adds a revenue to an expense.
 */
export * from './semantic-model';
export * from './trial-balance.loader';
export * from './reconciliation';
export * from './definition-runtime';
export * from './statements.service';
export * from './drill.service';
export * from './definitions.service';
export * from './runs.service';
export * from './audit-workspace.service';
export * as reportingWire from './serialization';
