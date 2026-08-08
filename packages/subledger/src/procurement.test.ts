import { describe, it, expect } from 'vitest';
import { calculateDocument, AppError, type CalculatedDocument } from '@acct/domain';
import { vendorBillLines } from './document-posting.service';
import { validateAllocations, type AllocationTarget } from './allocation';
import {
  requisitionApprovalTransition,
  purchaseOrderApprovalTransition,
  expenseClaimTransition,
  assertNotSelfApproval,
  paymentRunApprovalDecision,
  selectBillsForRun,
  paymentsToExecute,
  expensePolicyFlags,
  type RunCandidateBill,
} from './procurement.service';

/**
 * Procurement's decidable logic: the vendor-credit posting mirror, the
 * over-application guards, doc 14's separations, payment-run selection and
 * idempotent execution, and the requisition/PO state machines. Pure inputs and
 * pure outputs, as in posting-lines.test.ts — the integration suite proves the
 * same rules survive the round trip.
 */

const taxCode = (rate: string, recoverable = '1') => ({
  id: 'tax-1',
  code: 'VAT',
  treatment: 'STANDARD' as const,
  inclusive: false,
  components: [
    {
      id: 'comp-1',
      code: 'VAT',
      sequence: 1,
      rate,
      compoundOnPrevious: false,
      recoverablePercent: recoverable,
    },
  ],
});

function document(unitPrice: string, rate = '0.20', recoverable = '1'): CalculatedDocument {
  return calculateDocument(
    [
      {
        lineNo: 1,
        description: 'Line 1',
        quantity: '1',
        unitPrice,
        taxCode: taxCode(rate, recoverable),
      },
    ],
    { currency: 'GBP' },
  );
}

const sum = (lines: Array<{ debit?: string; credit?: string }>, side: 'debit' | 'credit') =>
  lines.reduce((a, l) => a + Number(l[side] ?? 0), 0);

describe('VENDOR_CREDIT_POSTED — the bill rule, sign-inverted', () => {
  const build = (sign: 1 | -1) =>
    vendorBillLines({
      calculated: document('100.00'),
      destinationAccountByLine: new Map([[1, 'acct-expense']]),
      taxAccountByComponent: new Map([['comp-1', 'acct-input-tax']]),
      apAccountId: 'acct-ap',
      currency: 'GBP',
      exchangeRate: '1',
      exchangeRateDate: null,
      contactId: 'vendor-1',
      sign,
    });

  it('debits AP gross and credits the destination and input tax', () => {
    // A credit that debited the expense instead of crediting it would inflate
    // spend twice over instead of taking it back once.
    const lines = build(-1);

    expect(lines[0]).toMatchObject({ accountId: 'acct-expense', credit: '100.00000000' });
    expect(lines[1]).toMatchObject({ accountId: 'acct-input-tax', credit: '20.00000000' });
    expect(lines[2]).toMatchObject({ accountId: 'acct-ap', debit: '120.00000000' });
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });

  it('mirrors the bill posting exactly: same accounts, same amounts, sides swapped', () => {
    // One builder, two signs. If the credit ever touched a different account
    // than the bill it reverses, the AP control would stop reconciling to the
    // subledger and nothing else would notice.
    const bill = build(1);
    const credit = build(-1);

    expect(credit).toHaveLength(bill.length);
    for (const [index, billLine] of bill.entries()) {
      const creditLine = credit[index]!;
      expect(creditLine.accountId).toBe(billLine.accountId);
      expect(creditLine.debit).toBe(billLine.credit);
      expect(creditLine.credit).toBe(billLine.debit);
    }
  });

  it('keeps non-recoverable tax in the destination line on the credit too', () => {
    // The bill capitalised the non-recoverable half into the expense (doc 07);
    // the credit must take it back out of the same account, or the expense
    // stays overstated by exactly the unrecoverable tax.
    const lines = vendorBillLines({
      calculated: document('100.00', '0.20', '0.5'),
      destinationAccountByLine: new Map([[1, 'acct-expense']]),
      taxAccountByComponent: new Map([['comp-1', 'acct-input-tax']]),
      apAccountId: 'acct-ap',
      currency: 'GBP',
      exchangeRate: '1',
      exchangeRateDate: null,
      contactId: 'vendor-1',
      sign: -1,
    });

    expect(lines[0]).toMatchObject({ accountId: 'acct-expense', credit: '110.00000000' });
    expect(lines[1]).toMatchObject({ accountId: 'acct-input-tax', credit: '10.00000000' });
    expect(lines[2]).toMatchObject({ accountId: 'acct-ap', debit: '120.00000000' });
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });
});

describe('vendor credit application — over-application refusal', () => {
  const bill = (over: Partial<AllocationTarget> = {}): AllocationTarget => ({
    id: 'bill-1',
    kind: 'VENDOR_BILL',
    amountDue: '100.00',
    total: '100.00',
    currency: 'GBP',
    exchangeRate: '1',
    legalEntityId: 'entity-1',
    status: 'POSTED',
    ...over,
  });

  const apply = (
    requests: Array<{ targetType: 'VENDOR_BILL'; targetId: string; amount: string }>,
    targets: AllocationTarget[],
    available = '200.00',
  ) =>
    validateAllocations({
      sourceUnapplied: available,
      sourceCurrency: 'GBP',
      requests,
      targets: new Map(targets.map((t) => [t.id, t])),
      documentLabel: (t) => `bill ${t.id}`,
    });

  it('accepts an application within both the bill balance and the credit', () => {
    expect(() =>
      apply([{ targetType: 'VENDOR_BILL', targetId: 'bill-1', amount: '80.00' }], [bill()]),
    ).not.toThrow();
  });

  it('refuses applying more than the bill has outstanding', () => {
    expect(() =>
      apply([{ targetType: 'VENDOR_BILL', targetId: 'bill-1', amount: '120.00' }], [bill()]),
    ).toThrow(/120.*bill-1.*100/s);
  });

  it('refuses two applications that each fit and together do not', () => {
    // The failure a per-request check waves through: 60 and 60 are each under
    // the bill's 100, and together they settle a debt of 100 with 120 — a
    // negative balance the vendor now owes us for no reason.
    expect(() =>
      apply(
        [
          { targetType: 'VENDOR_BILL', targetId: 'bill-1', amount: '60.00' },
          { targetType: 'VENDOR_BILL', targetId: 'bill-1', amount: '60.00' },
        ],
        [bill()],
      ),
    ).toThrow(/120/);
  });

  it('refuses applying more than the credit has available', () => {
    // Each bill could absorb the amount; the credit cannot supply it. A credit
    // applied past its own total is money invented at the AP control account.
    expect(() =>
      apply(
        [
          { targetType: 'VENDOR_BILL', targetId: 'bill-1', amount: '90.00' },
          { targetType: 'VENDOR_BILL', targetId: 'bill-2', amount: '90.00' },
        ],
        [bill(), bill({ id: 'bill-2' })],
        '150.00',
      ),
    ).toThrow(/only 150.*unapplied/);
  });

  it('refuses application against an unposted bill', () => {
    expect(() =>
      apply(
        [{ targetType: 'VENDOR_BILL', targetId: 'bill-1', amount: '10.00' }],
        [bill({ status: 'DRAFT' })],
      ),
    ).toThrow(/DRAFT.*posted document has a balance/s);
  });
});

describe('expense claim — self-approval and lifecycle', () => {
  it('refuses the claimant approving their own claim', () => {
    // doc 14: this separation is the entire control. The person who spent the
    // money never decides that the company owes it back to them.
    let thrown: unknown;
    try {
      assertNotSelfApproval({
        approverId: 'user-1',
        ownerId: 'user-1',
        ownerRole: 'claimant of an expense claim',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('SEGREGATION_OF_DUTIES');
  });

  it('permits approval by anyone else', () => {
    expect(() =>
      assertNotSelfApproval({
        approverId: 'user-2',
        ownerId: 'user-1',
        ownerRole: 'claimant of an expense claim',
      }),
    ).not.toThrow();
  });

  it('refuses approving a claim that was never submitted', () => {
    // The policy engine (limits, missing receipts, duplicates) runs at
    // submission. Approving straight from DRAFT approves flags nobody has seen.
    expect(() => expenseClaimTransition('DRAFT', 'APPROVE')).toThrow(/not been submitted/);
  });

  it('walks the happy path and is idempotent at each station', () => {
    expect(expenseClaimTransition('DRAFT', 'SUBMIT')).toEqual({ already: false });
    expect(expenseClaimTransition('SUBMITTED', 'SUBMIT')).toEqual({ already: true });
    expect(expenseClaimTransition('SUBMITTED', 'APPROVE')).toEqual({ already: false });
    expect(expenseClaimTransition('APPROVED', 'APPROVE')).toEqual({ already: true });
    expect(expenseClaimTransition('APPROVED', 'POST')).toEqual({ already: false });
    expect(expenseClaimTransition('POSTED', 'POST')).toEqual({ already: true });
  });

  it('refuses posting an unapproved or rejected claim', () => {
    // Posting creates the payable; a claim that skipped approval would owe the
    // claimant money on nobody's authority.
    expect(() => expenseClaimTransition('SUBMITTED', 'POST')).toThrow(/cannot be posted/);
    expect(() => expenseClaimTransition('REJECTED', 'POST')).toThrow(/cannot be posted/);
    expect(() => expenseClaimTransition('REJECTED', 'APPROVE')).toThrow(/cannot be approved/);
  });

  it('flags the signals doc 05 names, and flags rather than blocks', () => {
    expect(expensePolicyFlags({ expenseDate: '2026-08-08', receiptFileId: null }, 0)).toContain(
      'MISSING_RECEIPT',
    );
    // 2026-08-09 is a Sunday.
    expect(expensePolicyFlags({ expenseDate: '2026-08-09', receiptFileId: 'file-1' }, 0)).toEqual([
      'WEEKEND',
    ]);
    expect(expensePolicyFlags({ expenseDate: '2026-08-07', receiptFileId: 'file-1' }, 2)).toEqual([
      'DUPLICATE_SUSPECTED',
    ]);
    expect(expensePolicyFlags({ expenseDate: '2026-08-07', receiptFileId: 'file-1' }, 0)).toEqual(
      [],
    );
  });
});

describe('payment run — selection', () => {
  const candidate = (over: Partial<RunCandidateBill> = {}): RunCandidateBill => ({
    id: 'bill-1',
    vendor_id: 'vendor-1',
    currency: 'GBP',
    status: 'POSTED',
    on_hold: false,
    due_date: '2026-08-01',
    amount_due: '100.00',
    ...over,
  });

  const select = (
    bills: RunCandidateBill[],
    holds: Array<{ scope_type: string; scope_id: string; released_at?: string | null }> = [],
  ) => selectBillsForRun({ bills, holds, currency: 'GBP', dueOnOrBefore: '2026-08-08' });

  it('selects a due, posted, unheld bill', () => {
    expect(select([candidate()])).toHaveLength(1);
  });

  it('excludes a bill under an active hold', () => {
    // doc 05: the run "excludes unapproved, held or blocked vendors/bills".
    // A hold that a run walks past is a hold in name only.
    expect(select([candidate()], [{ scope_type: 'VENDOR_BILL', scope_id: 'bill-1' }])).toHaveLength(
      0,
    );
  });

  it('excludes every bill of a vendor under an active hold', () => {
    // A vendor-scoped hold (fraud investigation, disputed relationship) must
    // stop bills it has never seen, including ones created after it was placed.
    expect(
      select(
        [candidate(), candidate({ id: 'bill-2' })],
        [{ scope_type: 'VENDOR', scope_id: 'vendor-1' }],
      ),
    ).toHaveLength(0);
  });

  it('does not exclude on a released hold', () => {
    // Release is the recorded decision that the concern is over; a released
    // hold that kept excluding would make release meaningless.
    expect(
      select(
        [candidate()],
        [{ scope_type: 'VENDOR_BILL', scope_id: 'bill-1', released_at: '2026-08-01T00:00:00Z' }],
      ),
    ).toHaveLength(1);
  });

  it('excludes an already-paid bill on its zero balance', () => {
    // Paying a paid bill is the doubled payment doc 05 exists to prevent —
    // the balance is the truth, whatever the status row says.
    expect(select([candidate({ amount_due: '0', status: 'PAID' })])).toHaveLength(0);
    expect(select([candidate({ amount_due: '0' })])).toHaveLength(0);
  });

  it('excludes bills not yet due, in another currency, or still unposted', () => {
    expect(select([candidate({ due_date: '2026-09-01' })])).toHaveLength(0);
    expect(select([candidate({ currency: 'EUR' })])).toHaveLength(0);
    expect(select([candidate({ status: 'DRAFT' })])).toHaveLength(0);
    expect(select([candidate({ on_hold: true })])).toHaveLength(0);
  });
});

describe('payment run — approval separations (doc 14)', () => {
  const run = {
    status: 'DRAFT',
    createdBy: 'maker',
    approvedBy: null,
    totalAmount: '1000.00',
    dualApprovalThreshold: null,
  };

  it('refuses the creator approving their own run', () => {
    // Building the run chooses who gets paid; approving it is the check on
    // that choice. One person doing both is a payment with no control at all.
    let thrown: unknown;
    try {
      paymentRunApprovalDecision({ ...run, approverId: 'maker' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).code).toBe('SEGREGATION_OF_DUTIES');
  });

  it('approves outright below the dual-approval threshold', () => {
    expect(
      paymentRunApprovalDecision({ ...run, approverId: 'checker', dualApprovalThreshold: '5000' }),
    ).toEqual({ kind: 'FIRST', nextStatus: 'APPROVED' });
  });

  it('parks a run over the threshold until a second, different approver signs', () => {
    // Approved by one person is not approved: execution requires APPROVED, so
    // the parked run cannot pay anyone yet.
    expect(
      paymentRunApprovalDecision({ ...run, approverId: 'checker', dualApprovalThreshold: '500' }),
    ).toEqual({ kind: 'FIRST', nextStatus: 'APPROVAL_PENDING' });

    expect(
      paymentRunApprovalDecision({
        ...run,
        status: 'APPROVAL_PENDING',
        approvedBy: 'checker',
        approverId: 'second-checker',
        dualApprovalThreshold: '500',
      }),
    ).toEqual({ kind: 'SECOND' });
  });

  it('treats the same approver signing twice as one signature', () => {
    // Two signatures from one hand is one signature: the run stays parked
    // rather than completing its own dual control.
    expect(
      paymentRunApprovalDecision({
        ...run,
        status: 'APPROVAL_PENDING',
        approvedBy: 'checker',
        approverId: 'checker',
        dualApprovalThreshold: '500',
      }),
    ).toEqual({ kind: 'ALREADY_APPROVED' });
  });

  it('is idempotent once approved and refuses terminal states', () => {
    expect(
      paymentRunApprovalDecision({ ...run, status: 'APPROVED', approverId: 'checker' }),
    ).toEqual({ kind: 'ALREADY_APPROVED' });
    expect(() =>
      paymentRunApprovalDecision({ ...run, status: 'COMPLETED', approverId: 'checker' }),
    ).toThrow(/COMPLETED/);
    expect(() =>
      paymentRunApprovalDecision({ ...run, status: 'CANCELLED', approverId: 'checker' }),
    ).toThrow(/CANCELLED/);
  });
});

describe('payment run — idempotent execution', () => {
  it('processes DRAFT payments only, so a second execute pays nothing twice', () => {
    // "Calling it twice must not pay a bill twice." After the first execution
    // every processed payment is SENT; the second pass finds an empty plan.
    const before = [
      { id: 'pay-1', status: 'DRAFT' },
      { id: 'pay-2', status: 'DRAFT' },
    ];
    expect(paymentsToExecute(before).map((p) => p.id)).toEqual(['pay-1', 'pay-2']);

    const after = [
      { id: 'pay-1', status: 'SENT' },
      { id: 'pay-2', status: 'SENT' },
    ];
    expect(paymentsToExecute(after)).toHaveLength(0);
  });

  it('never resurrects a cancelled payment', () => {
    // A payment cancelled mid-run (hold, vanished balance) stays cancelled on
    // retry; re-executing it would pay past the recorded refusal.
    expect(
      paymentsToExecute([
        { id: 'pay-1', status: 'CANCELLED' },
        { id: 'pay-2', status: 'DRAFT' },
      ]).map((p) => p.id),
    ).toEqual(['pay-2']);
  });
});

describe('requisition approval state machine', () => {
  it('approves from DRAFT, SUBMITTED and APPROVAL_PENDING', () => {
    expect(requisitionApprovalTransition('DRAFT')).toEqual({ alreadyApproved: false });
    expect(requisitionApprovalTransition('SUBMITTED')).toEqual({ alreadyApproved: false });
    expect(requisitionApprovalTransition('APPROVAL_PENDING')).toEqual({ alreadyApproved: false });
  });

  it('is idempotent on APPROVED', () => {
    // The route requires an Idempotency-Key; a retried approval must not fail
    // on its own success.
    expect(requisitionApprovalTransition('APPROVED')).toEqual({ alreadyApproved: true });
  });

  it('refuses REJECTED, CONVERTED and CLOSED', () => {
    // A rejected requisition re-approved quietly is a spending decision nobody
    // made; a converted one already spent its authority on an order.
    expect(() => requisitionApprovalTransition('REJECTED')).toThrow(/REJECTED/);
    expect(() => requisitionApprovalTransition('CONVERTED')).toThrow(/CONVERTED/);
    expect(() => requisitionApprovalTransition('CLOSED')).toThrow(/CLOSED/);
  });
});

describe('purchase order approval state machine', () => {
  it('approves from DRAFT and APPROVAL_PENDING', () => {
    expect(purchaseOrderApprovalTransition('DRAFT')).toEqual({ alreadyApproved: false });
    expect(purchaseOrderApprovalTransition('APPROVAL_PENDING')).toEqual({
      alreadyApproved: false,
    });
  });

  it('reports already-approved for every state past approval', () => {
    // An order that has been issued or received against was certainly approved;
    // failing the retry would fail it on its own success.
    for (const status of ['APPROVED', 'ISSUED', 'PARTIALLY_RECEIVED', 'PARTIALLY_BILLED']) {
      expect(purchaseOrderApprovalTransition(status)).toEqual({ alreadyApproved: true });
    }
  });

  it('refuses CANCELLED and CLOSED', () => {
    // Approving a cancelled order would resurrect authority to spend that
    // someone explicitly withdrew.
    expect(() => purchaseOrderApprovalTransition('CANCELLED')).toThrow(/CANCELLED/);
    expect(() => purchaseOrderApprovalTransition('CLOSED')).toThrow(/CLOSED/);
  });
});
