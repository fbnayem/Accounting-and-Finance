import { describe, it, expect } from 'vitest';
import { D } from './decimal';
import { AppError } from './errors';
import {
  evaluateBudgetControl,
  relieveCommitment,
  type BudgetControlInput,
  type CommitmentState,
} from './budgeting';

/** Runs fn expecting an AppError, so tests can assert on code and details. */
const capture = (fn: () => unknown): AppError => {
  try {
    fn();
  } catch (e) {
    if (AppError.isAppError(e)) return e;
    throw e;
  }
  throw new Error('expected an AppError and none was thrown');
};

describe('evaluateBudgetControl', () => {
  // Approved 10000, consumed 9500 across the three terms — 500 available. The
  // three consumption terms are deliberately all non-zero so a formula that
  // dropped one would land on a different available and fail every boundary
  // assertion below.
  const base: Omit<BudgetControlInput, 'policy' | 'proposedSpend'> = {
    approvedBudget: D('10000.00'),
    actualPosted: D('6000.00'),
    openCommitments: D('2500.00'),
    pendingApprovedSpend: D('1000.00'),
  };

  it('names every term of doc 10’s formula, not just the answer', () => {
    const v = evaluateBudgetControl({ ...base, policy: 'BLOCK', proposedSpend: D('700.00') });
    // The refusal is the number a person argues with; the argument is settled by
    // seeing which term consumed the budget. All four terms and both results
    // must survive into the verdict.
    expect(v.approvedBudget.toString()).toBe('10000.00000000');
    expect(v.actualPosted.toString()).toBe('6000.00000000');
    expect(v.openCommitments.toString()).toBe('2500.00000000');
    expect(v.pendingApprovedSpend.toString()).toBe('1000.00000000');
    expect(v.available.toString()).toBe('500.00000000');
    expect(v.proposedSpend.toString()).toBe('700.00000000');
    expect(v.availableAfter.toString()).toBe('-200.00000000');
    expect(v.overBudgetBy.toString()).toBe('200.00000000');
    for (const term of ['10000', '6000', '2500', '1000', '500', '700', '-200', '200']) {
      expect(v.explanation).toContain(`${term}.00000000`);
    }
  });

  describe('INFORMATIONAL', () => {
    it('proceeds just under, at, and just over the line', () => {
      for (const proposed of ['499.99', '500.00', '500.01']) {
        const v = evaluateBudgetControl({
          ...base,
          policy: 'INFORMATIONAL',
          proposedSpend: D(proposed),
        });
        expect(v.decision).toBe('PROCEED');
      }
    });

    it('still tells the truth about being over budget', () => {
      // "Informational only" changes what happens, not what is true. A verdict
      // that said PROCEED and overBudget:false would poison the report that
      // shares this function.
      const v = evaluateBudgetControl({
        ...base,
        policy: 'INFORMATIONAL',
        proposedSpend: D('500.01'),
      });
      expect(v.overBudget).toBe(true);
      expect(v.overBudgetBy.toString()).toBe('0.01000000');
    });
  });

  describe('WARN', () => {
    // Threshold 80% of 10000 = 8000 of consumption. Consumed before this spend
    // is 7500, so the boundary sits at a proposed spend of exactly 500.
    const warn = {
      approvedBudget: D('10000.00'),
      actualPosted: D('5000.00'),
      openCommitments: D('2000.00'),
      pendingApprovedSpend: D('500.00'),
      policy: 'WARN' as const,
      warnThresholdPct: D('80'),
    };

    it('proceeds just under the threshold', () => {
      expect(evaluateBudgetControl({ ...warn, proposedSpend: D('499.99') }).decision).toBe(
        'PROCEED',
      );
    });

    it('does not warn at exactly the threshold — doc 10 says "above"', () => {
      expect(evaluateBudgetControl({ ...warn, proposedSpend: D('500.00') }).decision).toBe(
        'PROCEED',
      );
    });

    it('warns just over the threshold', () => {
      const v = evaluateBudgetControl({ ...warn, proposedSpend: D('500.01') });
      expect(v.decision).toBe('WARN');
      expect(v.warnThresholdAmount?.toString()).toBe('8000.00000000');
    });

    it('never escalates a warn to a block, even fully over budget', () => {
      // The policy is the budget owner's choice. WARN that silently blocked
      // would be BLOCK with a misleading name.
      const v = evaluateBudgetControl({ ...warn, proposedSpend: D('3000.00') });
      expect(v.overBudget).toBe(true);
      expect(v.decision).toBe('WARN');
    });

    it('with no configured threshold, warns only once actually over budget', () => {
      // control_threshold_pct is nullable (F-310). A missing threshold must not
      // invent a stricter default than "over budget".
      const noPct = { ...warn, warnThresholdPct: null };
      expect(evaluateBudgetControl({ ...noPct, proposedSpend: D('2500.00') }).decision).toBe(
        'PROCEED',
      );
      expect(evaluateBudgetControl({ ...noPct, proposedSpend: D('2500.01') }).decision).toBe(
        'WARN',
      );
    });
  });

  describe('BLOCK', () => {
    it('proceeds just under the line', () => {
      const v = evaluateBudgetControl({ ...base, policy: 'BLOCK', proposedSpend: D('499.99') });
      expect(v.decision).toBe('PROCEED');
      expect(v.availableAfter.toString()).toBe('0.01000000');
    });

    it('proceeds at exactly the line — spending to zero available is not over budget', () => {
      const v = evaluateBudgetControl({ ...base, policy: 'BLOCK', proposedSpend: D('500.00') });
      expect(v.decision).toBe('PROCEED');
      expect(v.overBudget).toBe(false);
    });

    it('blocks one cent over, and says by how much', () => {
      const v = evaluateBudgetControl({ ...base, policy: 'BLOCK', proposedSpend: D('500.01') });
      expect(v.decision).toBe('BLOCK');
      expect(v.overBudgetBy.toString()).toBe('0.01000000');
    });
  });

  describe('REQUIRE_OVERRIDE', () => {
    it('proceeds just under and at the line', () => {
      for (const proposed of ['499.99', '500.00']) {
        expect(
          evaluateBudgetControl({
            ...base,
            policy: 'REQUIRE_OVERRIDE',
            proposedSpend: D(proposed),
          }).decision,
        ).toBe('PROCEED');
      }
    });

    it('demands an override just over the line, rather than blocking outright', () => {
      const v = evaluateBudgetControl({
        ...base,
        policy: 'REQUIRE_OVERRIDE',
        proposedSpend: D('500.01'),
      });
      expect(v.decision).toBe('OVERRIDE_REQUIRED');
    });
  });

  it('counts a budget fully consumed by commitments with zero actuals posted', () => {
    // The case doc 10 exists to prevent, and the reason F-106 added the
    // commitments table: nothing has hit the ledger, so a naive actual-vs-budget
    // check reports the full 10000 as room. The committed POs have already
    // spoken for all of it — the correct available is zero and the next cent is
    // refused.
    const v = evaluateBudgetControl({
      policy: 'BLOCK',
      approvedBudget: D('10000.00'),
      actualPosted: D('0'),
      openCommitments: D('10000.00'),
      pendingApprovedSpend: D('0'),
      proposedSpend: D('0.01'),
    });
    expect(v.available.toString()).toBe('0.00000000');
    expect(v.decision).toBe('BLOCK');
    expect(v.overBudgetBy.toString()).toBe('0.01000000');
  });
});

describe('relieveCommitment', () => {
  const fresh: CommitmentState = {
    id: 'commit-1',
    committedAmount: D('1000.00'),
    relievedAmount: D('0'),
    status: 'OPEN',
  };

  it('relieves partially, then fully, then refuses the third attempt', () => {
    const partial = relieveCommitment(fresh, D('400.00'));
    expect(partial.relievedAmount.toString()).toBe('400.00000000');
    expect(partial.openAmount.toString()).toBe('600.00000000');
    expect(partial.status).toBe('PARTIALLY_RELIEVED');

    const full = relieveCommitment(partial, D('600.00'));
    expect(full.relievedAmount.toString()).toBe('1000.00000000');
    expect(full.openAmount.toString()).toBe('0.00000000');
    expect(full.status).toBe('RELIEVED');

    // The commitment is spent. A third relief has nothing to take — and it must
    // be refused here by name, not by the database CHECK it would otherwise hit.
    const err = capture(() => relieveCommitment(full, D('0.01')));
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toMatch(/COMMITMENT_NOT_OPEN/);
  });

  it('releases the whole open amount in one relief — the PO close/cancel path', () => {
    // doc 10 acceptance: "Closing/canceling PO releases unused commitment."
    const released = relieveCommitment(fresh, D('1000.00'));
    expect(released.status).toBe('RELIEVED');
    expect(released.openAmount.toString()).toBe('0.00000000');
  });

  it('refuses to relieve more than remains, naming all four numbers', () => {
    // "Constraint violated" is not actionable. The caller needs the attempted
    // amount, what was open, and how the commitment got there.
    const partial = relieveCommitment(fresh, D('400.00'));
    const err = capture(() => relieveCommitment(partial, D('600.01')));
    expect(err.code).toBe('OVER_ALLOCATION');
    expect(err.message).toMatch(/COMMITMENT_OVER_RELIEF/);
    expect(err.message).toContain('600.01000000');
    expect(err.message).toContain('600.00000000');
    expect(err.message).toContain('1000.00000000');
    expect(err.message).toContain('400.00000000');
    expect(err.details).toMatchObject({
      commitmentId: 'commit-1',
      attempted: '600.01000000',
      open: '600.00000000',
    });
  });

  it('refuses a zero relief', () => {
    const err = capture(() => relieveCommitment(fresh, D('0')));
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toMatch(/COMMITMENT_RELIEF_NOT_POSITIVE/);
  });

  it('refuses a negative relief — re-committing is a new commitment, not negative relief', () => {
    const err = capture(() => relieveCommitment(fresh, D('-50.00')));
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toMatch(/COMMITMENT_RELIEF_NOT_POSITIVE/);
  });

  it('refuses to touch a cancelled commitment', () => {
    const err = capture(() => relieveCommitment({ ...fresh, status: 'CANCELLED' }, D('100.00')));
    expect(err.code).toBe('VALIDATION_FAILED');
    expect(err.message).toMatch(/COMMITMENT_NOT_OPEN/);
  });

  it('reports an impossible stored state as our defect, not the caller’s', () => {
    // relieved > committed cannot have come through commitments_relieved_bounded.
    // Blaming the request with a 422 would send the caller hunting for a mistake
    // they did not make.
    const err = capture(() =>
      relieveCommitment({ ...fresh, relievedAmount: D('1200.00') }, D('10.00')),
    );
    expect(err.code).toBe('INTERNAL');
    expect(err.safeToExpose).toBe(false);
  });
});
