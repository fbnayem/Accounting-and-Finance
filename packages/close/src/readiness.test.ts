import { describe, expect, it } from 'vitest';
import { AppError } from '@acct/domain';
import {
  assertReadyToFinalize,
  deriveReadiness,
  reconciliationSatisfaction,
  taskSatisfaction,
  type ChecklistItem,
} from './readiness';

/**
 * The derivation, as a specification.
 *
 * Every case here has a matching case in `close.integration.test.ts` that proves
 * the same rule against a real database. They are not duplicates: this file says
 * what the rule IS, and the integration file says that the rule is what a close
 * run actually obeys — the arithmetic can be right while the query feeding it asks
 * the wrong question, and the reverse.
 */

const task = (over: Partial<ChecklistItem> = {}): ChecklistItem => ({
  kind: 'TASK',
  reference: 'T1',
  label: 'A task',
  required: true,
  satisfied: true,
  state: 'COMPLETED',
  ...over,
});

describe('deriveReadiness', () => {
  it('is zero per cent and unconfigured when nothing was asked for', () => {
    // The vacuity rule. 0/0 is not 100%: an empty checklist means the question was
    // never asked, and the answer to a question nobody asked is not "yes".
    const readiness = deriveReadiness([]);
    expect(readiness.configured).toBe(false);
    expect(readiness.complete).toBe(false);
    expect(readiness.readinessPercent).toBe('0.0000');
    expect(readiness.requiredTotal).toBe(0);
  });

  it('is unconfigured when every item on the list is optional', () => {
    // Same failure wearing a disguise: a checklist of nothing but optional tasks
    // would report 100% complete with no required work done, because the required
    // set is still empty.
    const readiness = deriveReadiness([
      task({ reference: 'OPT1', required: false, satisfied: false, state: 'OPEN' }),
      task({ reference: 'OPT2', required: false, satisfied: true }),
    ]);
    expect(readiness.configured).toBe(false);
    expect(readiness.complete).toBe(false);
    expect(readiness.optionalOutstanding).toBe(1);
  });

  it('completes when every required item is satisfied, optional ones notwithstanding', () => {
    const readiness = deriveReadiness([
      task({ reference: 'A' }),
      task({ reference: 'B' }),
      task({ reference: 'OPT', required: false, satisfied: false, state: 'OPEN' }),
    ]);
    expect(readiness.complete).toBe(true);
    expect(readiness.configured).toBe(true);
    expect(readiness.readinessPercent).toBe('100.0000');
    expect(readiness.optionalOutstanding).toBe(1);
  });

  it('computes the percentage as exact decimal at the column scale', () => {
    // numeric(7,4), and 1/3 is a repeating decimal — the case a float would round
    // to something that reads as 33.333333333333336 in a dashboard.
    const readiness = deriveReadiness([
      task({ reference: 'A' }),
      task({ reference: 'B', satisfied: false, state: 'OPEN' }),
      task({ reference: 'C', satisfied: false, state: 'OPEN' }),
    ]);
    expect(readiness.readinessPercent).toBe('33.3333');
    expect(readiness.requiredSatisfied).toBe(1);
    expect(readiness.blocking.map((b) => b.reference)).toEqual(['B', 'C']);
  });

  it('never reports a hundred per cent while an item is outstanding', () => {
    const items = Array.from({ length: 10_000 }, (_, i) =>
      task({ reference: `T${i}`, satisfied: i !== 0, state: i === 0 ? 'OPEN' : 'COMPLETED' }),
    );
    const readiness = deriveReadiness(items);
    expect(readiness.complete).toBe(false);
    expect(readiness.readinessPercent).toBe('99.9900');
  });
});

describe('assertReadyToFinalize', () => {
  const subject = {
    subject: 'close run X',
    act: 'Finalizing the close',
    configureHint: 'Generate a checklist first.',
  };

  it('refuses an empty close and says that is what is wrong', () => {
    const error = catchError(() => assertReadyToFinalize(deriveReadiness([]), subject));
    expect(error.code).toBe('VALIDATION_FAILED');
    // The message, not the details: `AppError.details` is log-only and never
    // reaches the caller, so a refusal a caller must act on has to say so here.
    expect(error.message).toContain('no required checklist task');
    expect(error.message).toContain('Generate a checklist first.');
  });

  it('refuses an incomplete close and names what is outstanding', () => {
    const readiness = deriveReadiness([
      task({ reference: 'CUTOFF' }),
      task({
        kind: 'RECONCILIATION',
        reference: '1100',
        satisfied: false,
        state: 'MISSING',
        unsatisfiedBecause: 'no reconciliation prepared',
      }),
    ]);
    const error = catchError(() => assertReadyToFinalize(readiness, subject));
    expect(error.code).toBe('VALIDATION_FAILED');
    expect(error.message).toContain('1 of 2');
    expect(error.message).toContain('reconciliation 1100');
    expect(error.message).toContain('no reconciliation prepared');
  });

  it('permits a complete close — the accept half', () => {
    // A control that only ever refuses is indistinguishable from an outage.
    expect(() =>
      assertReadyToFinalize(deriveReadiness([task(), task({ reference: 'B' })]), subject),
    ).not.toThrow();
  });
});

describe('taskSatisfaction — NULL-safety', () => {
  it('counts a completed task with a completing user', () => {
    expect(
      taskSatisfaction({
        status: 'COMPLETED',
        completed_by: 'u1',
        waived_by: null,
        waived_reason: null,
      }).satisfied,
    ).toBe(true);
  });

  it('does not count a completion nobody performed', () => {
    const verdict = taskSatisfaction({
      status: 'COMPLETED',
      completed_by: null,
      waived_by: null,
      waived_reason: null,
    });
    expect(verdict.satisfied).toBe(false);
    expect(verdict.because).toContain('no completing user');
  });

  it('counts a waiver with a waiver and a reason, and refuses one without either', () => {
    expect(
      taskSatisfaction({
        status: 'WAIVED',
        completed_by: null,
        waived_by: 'u2',
        waived_reason: 'immaterial this month',
      }).satisfied,
    ).toBe(true);
    // `close_tasks_waived_has_reason` requires the reason and nothing requires the
    // waiver, so this row is possible in the database.
    expect(
      taskSatisfaction({
        status: 'WAIVED',
        completed_by: null,
        waived_by: null,
        waived_reason: 'immaterial this month',
      }).satisfied,
    ).toBe(false);
    expect(
      taskSatisfaction({
        status: 'WAIVED',
        completed_by: null,
        waived_by: 'u2',
        waived_reason: '   ',
      }).satisfied,
    ).toBe(false);
  });

  it('does not count an open or blocked task', () => {
    for (const status of ['OPEN', 'IN_PROGRESS', 'BLOCKED']) {
      expect(
        taskSatisfaction({
          status,
          completed_by: null,
          waived_by: null,
          waived_reason: null,
        }).satisfied,
      ).toBe(false);
    }
  });
});

describe('reconciliationSatisfaction — NULL-safety', () => {
  it('counts a certified reconciliation with two different people on it', () => {
    expect(
      reconciliationSatisfaction({ status: 'CERTIFIED', prepared_by: 'u1', approved_by: 'u2' })
        .satisfied,
    ).toBe(true);
  });

  it('does not count one certified against a NULL preparer', () => {
    // `recon_sod` is `approved_by IS NULL OR approved_by <> prepared_by`. Against a
    // NULL preparer that expression is NULL, and a CHECK accepts NULL — so this row
    // exists as far as the schema is concerned and must not close a period.
    const verdict = reconciliationSatisfaction({
      status: 'CERTIFIED',
      prepared_by: null,
      approved_by: 'u2',
    });
    expect(verdict.satisfied).toBe(false);
    expect(verdict.because).toContain('no preparer');
  });

  it('does not count one certified by nobody, or by the preparer', () => {
    expect(
      reconciliationSatisfaction({ status: 'CERTIFIED', prepared_by: 'u1', approved_by: null })
        .satisfied,
    ).toBe(false);
    expect(
      reconciliationSatisfaction({ status: 'CERTIFIED', prepared_by: 'u1', approved_by: 'u1' })
        .satisfied,
    ).toBe(false);
  });

  it('does not count a missing, draft, prepared or reopened reconciliation', () => {
    for (const status of [null, 'DRAFT', 'PREPARED', 'REOPENED']) {
      expect(
        reconciliationSatisfaction({ status, prepared_by: 'u1', approved_by: 'u2' }).satisfied,
      ).toBe(false);
    }
  });

  it('does not count one the ledger has moved underneath', () => {
    const verdict = reconciliationSatisfaction({
      status: 'CERTIFIED',
      prepared_by: 'u1',
      approved_by: 'u2',
      stale: true,
    });
    expect(verdict.satisfied).toBe(false);
    expect(verdict.because).toContain('general ledger has moved');
  });
});

function catchError(fn: () => void): AppError {
  try {
    fn();
  } catch (e) {
    if (AppError.isAppError(e)) return e;
    throw e;
  }
  throw new Error('expected a refusal, and nothing was thrown');
}
