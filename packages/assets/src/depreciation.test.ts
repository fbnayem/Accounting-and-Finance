import { describe, it, expect } from 'vitest';
import { AppError, D } from '@acct/domain';
import {
  eligibleScheduleLines,
  depreciationRunLines,
  type ScheduleLineCandidate,
} from './depreciation.service';

/**
 * Exit criterion 5 — "Depreciation rerun is idempotent for same
 * asset/book/period" — as executable assertions on the eligibility rule and
 * the run's journal aggregation. Pure inputs and pure outputs, in the manner
 * of posting-lines.test.ts; the run's SQL applies the same status filter, and
 * guard_depreciation_line_posted (0043) holds the database to it.
 */

const line = (over: Partial<ScheduleLineCandidate> = {}): ScheduleLineCandidate => ({
  id: 'line-1',
  assetBookId: 'book-1',
  status: 'SCHEDULED',
  scheduledAmount: '333.33',
  depreciationExpenseAccountId: 'acct-expense',
  accumulatedDepreciationAccountId: 'acct-accdep',
  ...over,
});

describe('eligibleScheduleLines', () => {
  it('a rerun finds nothing: a POSTED line is never eligible again', () => {
    // The failure this catches is the one 0013's UNIQUE cannot see (F-916): a
    // rerun that selects the already-POSTED line and posts it again produces
    // two journals for one asset/book/period — the exact double-charge the
    // exit criterion forbids.
    const afterFirstRun = [
      line({ id: 'line-1', status: 'POSTED' }),
      line({ id: 'line-2', assetBookId: 'book-2', status: 'POSTED' }),
    ];
    expect(eligibleScheduleLines(afterFirstRun)).toHaveLength(0);
  });

  it('a new asset capitalized into an already-run period is still eligible', () => {
    // The other half of the criterion: idempotency must not curdle into "this
    // period can never depreciate anything again". The late asset's line is
    // SCHEDULED, so the incremental run selects exactly it and nothing else.
    const afterLateCapitalization = [
      line({ id: 'line-1', status: 'POSTED' }),
      line({ id: 'line-2', assetBookId: 'book-2', status: 'POSTED' }),
      line({ id: 'line-3', assetBookId: 'book-new', status: 'SCHEDULED' }),
    ];
    expect(eligibleScheduleLines(afterLateCapitalization).map((l) => l.id)).toEqual(['line-3']);
  });

  it('SKIPPED and REVISED lines stay out of play', () => {
    // A SKIPPED line belongs to a disposed asset; posting it would depreciate
    // a machine that has left the building. A REVISED line was superseded by
    // prospective re-estimation and its replacement carries the charge.
    const lines = [
      line({ id: 'line-1', status: 'SKIPPED' }),
      line({ id: 'line-2', status: 'REVISED' }),
    ];
    expect(eligibleScheduleLines(lines)).toHaveLength(0);
  });
});

describe('depreciationRunLines', () => {
  it('posts Dr Expense / Cr Accumulated, summed per account pair', () => {
    // Two assets of one category collapse into one debit and one credit; a
    // third of another category keeps its own accounts. Getting this wrong in
    // the collapsing direction loses the category split the reconciliation
    // report reads; wrong in the other direction posts a line per asset and
    // the journal stops being reviewable at month end.
    const { drafts, total } = depreciationRunLines([
      line({ id: 'a', scheduledAmount: '100.00' }),
      line({ id: 'b', assetBookId: 'book-2', scheduledAmount: '50.00' }),
      line({
        id: 'c',
        assetBookId: 'book-3',
        scheduledAmount: '25.00',
        depreciationExpenseAccountId: 'acct-expense-2',
        accumulatedDepreciationAccountId: 'acct-accdep-2',
      }),
    ]);

    expect(total.equals(D('175.00'))).toBe(true);
    expect(drafts).toContainEqual({
      accountId: 'acct-expense',
      description: 'Depreciation expense',
      debit: '150.00',
    });
    expect(drafts).toContainEqual({
      accountId: 'acct-expense-2',
      description: 'Depreciation expense',
      debit: '25.00',
    });
    expect(drafts).toContainEqual({
      accountId: 'acct-accdep',
      description: 'Accumulated depreciation',
      credit: '150.00',
    });
    expect(drafts).toContainEqual({
      accountId: 'acct-accdep-2',
      description: 'Accumulated depreciation',
      credit: '25.00',
    });

    const debits = drafts.filter((d) => d.debit !== undefined);
    const credits = drafts.filter((d) => d.credit !== undefined);
    expect(debits).toHaveLength(2);
    expect(credits).toHaveLength(2);
  });

  it('refuses a non-positive stored charge instead of posting it', () => {
    // buildSchedule never emits one, so a zero or negative scheduled_amount
    // means the stored schedule was corrupted after the fact. Posting a
    // negative "charge" would CREDIT expense — silently un-depreciating.
    expect(() => depreciationRunLines([line({ scheduledAmount: '0' })])).toThrowError(AppError);
    expect(() => depreciationRunLines([line({ scheduledAmount: '-10.00' })])).toThrowError(
      AppError,
    );
  });
});
