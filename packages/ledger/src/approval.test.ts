import { describe, it, expect } from 'vitest';
import { AppError } from '@acct/domain';
import { assertJournalApproval, meetsApprovalThreshold } from './approval';

/**
 * The approval threshold, at the boundary and on both sides of it.
 *
 * Gate F: "Approval thresholds and conditions pass boundary tests." The rule is
 * two comparisons and an equality, which is exactly the size of thing that is
 * obviously correct and quietly off by one — so the cases below are the ones a
 * tenant will actually meet: the threshold itself, a cent under it, a cent over
 * it, a threshold that is not configured at all, and the person who approved
 * their own work.
 *
 * The refusals are asserted on the MESSAGE and not only on the code. Every one
 * of these reaches a human whose next action depends on which number is which,
 * and `AppError.details` never leaves the log.
 */

const BASE = {
  currency: 'GBP',
  preparedBy: 'user-maker',
  approvedBy: null,
  reference: 'JE-00001',
} as const;

function refusalOf(fn: () => void): AppError {
  try {
    fn();
  } catch (error) {
    if (AppError.isAppError(error)) return error;
    throw error;
  }
  throw new Error('expected a refusal, and the call returned normally');
}

describe('meetsApprovalThreshold', () => {
  it('is >= rather than >, so the threshold itself is inside the control', () => {
    // The single most common number a tenant will test with is the threshold.
    // Reading "meets or exceeds" as strictly-greater puts it on the permissive
    // side and the discrepancy surfaces at an audit rather than at a demo.
    expect(meetsApprovalThreshold('1000', '1000')).toBe(true);
    expect(meetsApprovalThreshold('1000.00', '1000.00000000')).toBe(true);
  });

  it('separates a cent under from a cent over', () => {
    expect(meetsApprovalThreshold('1000', '999.99')).toBe(false);
    expect(meetsApprovalThreshold('1000', '1000.01')).toBe(true);
  });

  it('compares exact decimals, not floats', () => {
    // 0.1 + 0.2 in binary is 0.30000000000000004, and a threshold compared in
    // binary floating point is a threshold that moves. These two are equal.
    expect(meetsApprovalThreshold('0.3', '0.30000000')).toBe(true);
    // Nineteen significant digits: past what a double can hold exactly, so a
    // float comparison would call these equal and let the journal through.
    expect(meetsApprovalThreshold('1000000000000000000', '999999999999999999')).toBe(false);
  });

  it('treats the absolute value as the amount', () => {
    // A journal's value is its size. A negative total is a sign convention, not
    // a smaller journal, and "under the threshold because it is negative" is a
    // hole big enough to drive the whole control through.
    expect(meetsApprovalThreshold('1000', '-2500')).toBe(true);
  });

  it('is permissive when no threshold is configured', () => {
    // NULL is the shipped default. Reading it as zero would demand approval for
    // every journal in every tenant the moment this shipped, which is not
    // enforcement, it is an outage.
    expect(meetsApprovalThreshold(null, '999999999')).toBe(false);
  });
});

describe('assertJournalApproval — the threshold', () => {
  it('refuses an over-threshold journal with no approval', () => {
    const error = refusalOf(() =>
      assertJournalApproval({ ...BASE, threshold: '1000.00', amount: '2500.00' }),
    );
    expect(error.code).toBe('APPROVAL_REQUIRED');
    expect(error.httpStatus).toBe(403);
  });

  it('names both the amount and the threshold in the message, not only in details', () => {
    // `AppError.details` is log-only — `toResponse()` never serialises it — so a
    // caller who has to act on the refusal learns nothing from a code alone.
    // The two numbers they must reconcile have to be in the sentence.
    const error = refusalOf(() =>
      assertJournalApproval({ ...BASE, threshold: '1000.00', amount: '2500.00' }),
    );
    expect(error.message).toContain('2500.00');
    expect(error.message).toContain('1000.00');
    expect(error.message).toContain('GBP');
    // And the remedy, because "approval required" without "by whom, through
    // where" is a dead end for the person holding the invoice.
    expect(error.message).toMatch(/approve/i);
  });

  it('accepts an over-threshold journal that carries an approval by someone else', () => {
    expect(() =>
      assertJournalApproval({
        ...BASE,
        threshold: '1000.00',
        amount: '2500.00',
        approvedBy: 'user-checker',
      }),
    ).not.toThrow();
  });

  it('accepts an under-threshold journal with no approval at all', () => {
    // The half that keeps this from being a control that refuses everything.
    expect(() =>
      assertJournalApproval({ ...BASE, threshold: '1000.00', amount: '999.99' }),
    ).not.toThrow();
  });

  it('accepts everything when the tenant has configured no threshold', () => {
    expect(() =>
      assertJournalApproval({ ...BASE, threshold: null, amount: '9999999.99' }),
    ).not.toThrow();
  });

  it('refuses at the boundary exactly', () => {
    expect(
      refusalOf(() => assertJournalApproval({ ...BASE, threshold: '1000', amount: '1000' })).code,
    ).toBe('APPROVAL_REQUIRED');
    expect(() =>
      assertJournalApproval({ ...BASE, threshold: '1000', amount: '999.99999999' }),
    ).not.toThrow();
  });
});

describe('assertJournalApproval — maker/checker', () => {
  it('refuses an approval by the preparer, whatever the amount', () => {
    // Unconditional: it is a statement about approvals, not about large ones. A
    // rule that only applies over a threshold means the same person may approve
    // their own work as long as they keep it small, which is how the control is
    // actually defeated in practice.
    const error = refusalOf(() =>
      assertJournalApproval({
        ...BASE,
        threshold: '1000000',
        amount: '1.00',
        approvedBy: BASE.preparedBy,
      }),
    );
    expect(error.code).toBe('SEGREGATION_OF_DUTIES');
    expect(error.httpStatus).toBe(403);
    expect(error.message).toMatch(/same person/i);
  });

  it('refuses an approval whose preparer is unknown', () => {
    // The vacuous-control case. `approvedBy !== preparedBy` is TRUE against a
    // null preparer in TypeScript and NULL in SQL, and both of those let the row
    // through — so both layers state the rule as "the preparer must be known
    // AND different" rather than "different".
    const error = refusalOf(() =>
      assertJournalApproval({
        ...BASE,
        threshold: '1000',
        amount: '2500',
        preparedBy: null,
        approvedBy: 'user-checker',
      }),
    );
    expect(error.code).toBe('SEGREGATION_OF_DUTIES');
    expect(error.message).toMatch(/no preparer/i);
  });

  it('accepts an approval by a different person', () => {
    expect(() =>
      assertJournalApproval({
        ...BASE,
        threshold: '1000000',
        amount: '1.00',
        approvedBy: 'user-checker',
      }),
    ).not.toThrow();
  });
});

describe('assertJournalApproval — reversals', () => {
  it('accepts an over-threshold reversal of an entry that carries an approval', () => {
    // doc 01 rule 4 corrects posted history by reversal, and no route approves a
    // reversal — it is created and posted by one command. Without this, every
    // approved journal would be permanently irreversible.
    expect(() =>
      assertJournalApproval({
        ...BASE,
        threshold: '1000',
        amount: '2500',
        reversesApprovedEntry: true,
      }),
    ).not.toThrow();
  });

  it('still refuses an over-threshold reversal of an entry that carries none', () => {
    // The narrow half. `reversal_of_id` is a column any writer can set, so "it
    // says it is a reversal" is not evidence — the entry named has to actually
    // carry the approval this one is standing on.
    expect(
      refusalOf(() =>
        assertJournalApproval({
          ...BASE,
          threshold: '1000',
          amount: '2500',
          reversesApprovedEntry: false,
        }),
      ).code,
    ).toBe('APPROVAL_REQUIRED');
  });
});
