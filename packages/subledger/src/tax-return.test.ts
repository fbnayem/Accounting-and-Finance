import { describe, it, expect } from 'vitest';
import { AppError } from '@acct/domain';
import {
  partitionForReturn,
  buildReturnSnapshot,
  assertReturnPreparable,
  type ReturnTransactionRow,
  type FiledCoverage,
} from './tax-return.service';
import { decideInstallation, compareLocalizationVersions } from './localization.service';

/**
 * doc 07's return preparation, as executable assertions.
 *
 * These are the functions that decide which subledger rows a return reports and
 * what its boxes say, so they are where "no transaction is reported twice or
 * dropped" either holds or quietly stops holding. Pure inputs and pure outputs,
 * so they can be checked without a database — the integration suite proves the
 * same rules survive the round trip.
 */

let seq = 0;
const txn = (over: Partial<ReturnTransactionRow> = {}): ReturnTransactionRow => ({
  id: `txn-${++seq}`,
  posting_date: '2026-01-15',
  direction: 'OUTPUT',
  tax_code: 'VAT',
  component_code: 'STD',
  currency: 'GBP',
  taxable_amount: '100.00000000',
  tax_amount: '20.00000000',
  base_taxable_amount: '100.00000000',
  base_tax_amount: '20.00000000',
  recoverable_amount: '0.00000000',
  nonrecoverable_amount: '0.00000000',
  ...over,
});

const period = {
  id: 'period-jan',
  jurisdiction: 'GB',
  startDate: '2026-01-01',
  endDate: '2026-01-31',
};

const snapshotOf = (current: ReturnTransactionRow[], late: ReturnTransactionRow[] = []) =>
  buildReturnSnapshot({ formCode: 'VAT-RETURN', period, current, late });

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as AppError).code;
  }
};

describe('return box aggregation', () => {
  it('separates output tax from recoverable and non-recoverable input tax', () => {
    // The split that decides the liability: claiming the non-recoverable half
    // as recoverable understates net_payable by exactly that amount, and the
    // error only surfaces in an audit.
    const snap = snapshotOf([
      txn({ direction: 'OUTPUT', base_tax_amount: '20.00000000' }),
      txn({
        direction: 'INPUT',
        tax_code: 'PVAT',
        tax_amount: '15.00000000',
        base_tax_amount: '15.00000000',
        recoverable_amount: '10.00000000',
        nonrecoverable_amount: '5.00000000',
      }),
    ]);

    expect(snap.totals.output_tax).toBe('20.00000000');
    expect(snap.totals.recoverable_input_tax).toBe('10.00000000');
    expect(snap.totals.nonrecoverable_input_tax).toBe('5.00000000');
    // Only the recoverable half offsets the liability; the non-recoverable
    // half already capitalised into cost and must not reduce the payment.
    expect(snap.totals.net_payable).toBe('10.00000000');
  });

  it('nets a credit note against output tax rather than filing it as input', () => {
    // recordTransactions keeps direction OUTPUT on a sales credit note and
    // makes the amounts negative. If the sign decided the direction, every
    // credit note would inflate the input box and the return would over-claim.
    const snap = snapshotOf([
      txn({ direction: 'OUTPUT', base_tax_amount: '20.00000000' }),
      txn({
        direction: 'OUTPUT',
        taxable_amount: '-25.00000000',
        tax_amount: '-5.00000000',
        base_taxable_amount: '-25.00000000',
        base_tax_amount: '-5.00000000',
      }),
    ]);

    expect(snap.totals.output_tax).toBe('15.00000000');
    expect(snap.totals.recoverable_input_tax).toBe('0.00000000');
    expect(snap.totals.net_payable).toBe('15.00000000');
  });

  it('keeps withholding out of both the output and input boxes', () => {
    // Withholding is tax retained from a counterparty, not tax on a supply.
    // Filed in either box it would offset a liability it has nothing to do with.
    const snap = snapshotOf([
      txn({ direction: 'OUTPUT', base_tax_amount: '20.00000000' }),
      txn({ direction: 'WITHHOLDING', tax_code: 'WHT', base_tax_amount: '3.00000000' }),
    ]);

    expect(snap.totals.output_tax).toBe('20.00000000');
    expect(snap.totals.withholding_tax).toBe('3.00000000');
    expect(snap.totals.net_payable).toBe('20.00000000');
  });

  it('groups boxes by direction, code and component, and keeps late rows in their own box', () => {
    // A late transaction is reported at full value but flagged, because the
    // filing that includes prior-period amounts without saying so is the one an
    // auditor cannot reconcile back to the period's registers.
    const snap = buildReturnSnapshot({
      formCode: 'VAT-RETURN',
      period,
      current: [txn(), txn()],
      late: [txn({ posting_date: '2025-12-20' })],
    });

    expect(snap.boxes).toHaveLength(2);
    expect(snap.boxes.filter((b) => b.late)).toHaveLength(1);
    expect(snap.boxes.find((b) => !b.late)?.transaction_count).toBe(2);
    expect(snap.boxes.find((b) => !b.late)?.base_tax_amount).toBe('40.00000000');
    expect(snap.totals.output_tax).toBe('60.00000000');
    expect(snap.late_transaction_count).toBe(1);
  });

  it('records every reported id in the snapshot, current and late alike', () => {
    // transaction_ids is the double-reporting mechanism itself: the next
    // period's preparation reads it to know what this return already carried.
    const a = txn();
    const b = txn({ posting_date: '2025-12-20' });
    const snap = buildReturnSnapshot({ formCode: 'VAT-RETURN', period, current: [a], late: [b] });

    expect(snap.transaction_ids).toEqual([a.id, b.id].sort());
    expect(snap.late_transaction_ids).toEqual([b.id]);
  });
});

describe('prepare refusals', () => {
  it('refuses to prepare over a period with no transactions', () => {
    // An empty aggregate is almost always a wrong jurisdiction or date range.
    // Preparing it anyway would produce a plausible nil return that files
    // nothing and looks finished.
    expect(() => snapshotOf([])).toThrow(/no posted tax transactions/);
    expect(codeOf(() => snapshotOf([]))).toBe('VALIDATION_FAILED');
  });

  it('refuses to prepare a return that is already filed, with a different error', () => {
    // Distinct from the empty-period refusal because the fix is different:
    // re-preparing a FILED return would rewrite an immutable snapshot; the
    // remedy is an amending return, and the error says so.
    expect(() => assertReturnPreparable('FILED', 'ret-1')).toThrow(/immutable snapshot/);
    expect(codeOf(() => assertReturnPreparable('FILED', 'ret-1'))).toBe('POSTED_IMMUTABLE');
    expect(codeOf(() => assertReturnPreparable('AMENDED', 'ret-1'))).toBe('POSTED_IMMUTABLE');
  });

  it('allows preparing from every state before filing', () => {
    // READY included: re-preparing clears the approval rather than being
    // blocked, otherwise a late posting before filing would wedge the return
    // between "cannot prepare" and "cannot file".
    for (const status of ['OPEN', 'PREPARING', 'READY']) {
      expect(() => assertReturnPreparable(status, 'ret-1')).not.toThrow();
    }
  });

  it('refuses a direction no box accepts rather than guessing one', () => {
    expect(() => snapshotOf([txn({ direction: 'SIDEWAYS' })])).toThrow(/SIDEWAYS/);
  });
});

describe('double-reporting invariant', () => {
  const filedDecember: FiledCoverage[] = [
    {
      startDate: '2025-12-01',
      endDate: '2025-12-31',
      reportedTransactionIds: new Set(['dec-reported']),
    },
  ];

  it('includes a transaction dated in the period', () => {
    const row = txn({ posting_date: '2026-01-10' });
    const p = partitionForReturn([row], period, filedDecember);
    expect(p.current).toEqual([row]);
    expect(p.late).toEqual([]);
  });

  it('never re-reports a transaction that is on a filed return', () => {
    // The filed December return carried dec-reported. If January's preparation
    // picked it up again the same output tax would be remitted twice, and
    // nothing downstream could tell.
    const row = txn({ id: 'dec-reported', posting_date: '2025-12-15' });
    const p = partitionForReturn([row], period, filedDecember);
    expect(p.alreadyReported).toEqual([row]);
    expect(p.current).toEqual([]);
    expect(p.late).toEqual([]);
  });

  it('sweeps a transaction posted after its period filed into the next return', () => {
    // Posted into December's date range after December filed: it is on no
    // filed snapshot, so it surfaces here as late rather than being covered by
    // a filed period and reported by nobody — the silent-drop case.
    const row = txn({ id: 'dec-straggler', posting_date: '2025-12-20' });
    const p = partitionForReturn([row], period, filedDecember);
    expect(p.late).toEqual([row]);
    expect(p.current).toEqual([]);
    expect(p.alreadyReported).toEqual([]);
  });

  it('leaves a prior-period transaction alone while its own period is unfiled', () => {
    // November has no filed return, so November's rows belong to November's
    // return. Sweeping them into January would report them on the wrong period
    // and leave November's return empty.
    const row = txn({ posting_date: '2025-11-15' });
    const p = partitionForReturn([row], period, filedDecember);
    expect(p.outOfScope).toEqual([row]);
    expect(p.current).toEqual([]);
    expect(p.late).toEqual([]);
  });

  it('excludes a transaction dated after the period', () => {
    const row = txn({ posting_date: '2026-02-01' });
    const p = partitionForReturn([row], period, filedDecember);
    expect(p.outOfScope).toEqual([row]);
  });
});

describe('localization install decision', () => {
  const version = (v: string, effectiveFrom = '2026-01-01', packageCode = 'GB') => ({
    packageCode,
    version: v,
    effectiveFrom,
  });

  it('installs onto an entity with nothing installed', () => {
    expect(decideInstallation(null, version('2026.1'))).toBe('INSTALL');
  });

  it('is idempotent: re-installing the installed version is a no-op, not an error', () => {
    // installLocalization requires an Idempotency-Key; the retry after a lost
    // response must land here and return the existing installation.
    expect(decideInstallation(version('2026.1'), version('2026.1'))).toBe('ALREADY_INSTALLED');
  });

  it('refuses a downgrade by name', () => {
    // Historical transactions retain the rule version in force when they
    // posted (doc 07); a downgrade would run future postings under rules that
    // have been superseded, with nothing recording the regression.
    expect(() => decideInstallation(version('2026.2'), version('2026.1'))).toThrow(/[Dd]owngrad/);
    expect(codeOf(() => decideInstallation(version('2026.2'), version('2026.1')))).toBe(
      'PRECONDITION_FAILED',
    );
  });

  it('refuses to re-install a newer version over an existing installation', () => {
    // An upgrade is a deliberate migration (doc 20's "carries the version
    // delta; never rewrites history"), not something an install does silently.
    expect(() => decideInstallation(version('2026.1'), version('2026.2'))).toThrow(/upgrade/);
  });

  it('refuses a second package over the installed one', () => {
    expect(() =>
      decideInstallation(version('2026.1', '2026-01-01', 'GB'), version('1.0', '2026-01-01', 'BD')),
    ).toThrow(/already runs/);
  });

  it('orders versions numerically, not lexicographically', () => {
    // '1.10' < '1.9' under string comparison — the classic way a real upgrade
    // is misread as a downgrade and refused for the wrong reason.
    expect(compareLocalizationVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareLocalizationVersions('1.2', '1.2.0')).toBe(0);
    expect(compareLocalizationVersions('2026.1-beta', '2026.1')).toBeNull();
    // An unparseable pair still refuses the install; effective_from decides
    // whether the message says downgrade or upgrade.
    expect(() =>
      decideInstallation(version('2026.2-r1', '2026-06-01'), version('2026.1-r9', '2026-01-01')),
    ).toThrow(/[Dd]owngrad/);
  });
});
