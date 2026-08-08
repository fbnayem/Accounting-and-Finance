import { describe, it, expect } from 'vitest';
import { AppError, calculateDocument, type CalculatedDocument } from '@acct/domain';
import { salesInvoiceLines } from './document-posting.service';
import {
  validateAllocations,
  creditApplicationRequests,
  assertInvoiceEditable,
  type AllocationTarget,
} from './allocation';
import {
  conversionLineInputs,
  nextOccurrenceDate,
  dueOccurrenceDates,
  assertRefundWithinAvailable,
} from './sales.service';

/**
 * The decidable half of the sales module: sign inversion, application bounds,
 * refund bounds, conversion fidelity, recurrence arithmetic and the invoice
 * edit guard. Pure inputs and pure outputs, same as posting-lines.test.ts —
 * the integration suite proves the same rules survive the round trip.
 */

const taxCode = (rate: string) => ({
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
      recoverablePercent: '1',
    },
  ],
});

function document(unitPrice: string, rate = '0.20'): CalculatedDocument {
  return calculateDocument(
    [
      {
        lineNo: 1,
        description: 'Line 1',
        quantity: '1',
        unitPrice,
        taxCode: taxCode(rate),
      },
    ],
    { currency: 'GBP' },
  );
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (AppError.isAppError(error)) return error.code;
    throw error;
  }
  throw new Error('expected an AppError');
}

describe('SALES_CREDIT_NOTE mirrors SALES_INVOICE_POSTED', () => {
  const build = (sign: 1 | -1) =>
    salesInvoiceLines({
      calculated: document('100.00'),
      revenueAccountByLine: new Map([[1, 'acct-revenue']]),
      taxAccountByComponent: new Map([['comp-1', 'acct-output-tax']]),
      arAccountId: 'acct-ar',
      currency: 'GBP',
      baseCurrency: 'GBP',
      exchangeRate: '1',
      exchangeRateDate: null,
      contactId: 'customer-1',
      sign,
    });

  it('inverts every invoice line, account for account and amount for amount', () => {
    // The credit note posts through the same builder with sign -1, so the
    // reversal mirrors the original by construction. A hand-written second
    // path is how a credit note comes to reverse the revenue but not the tax,
    // leaving output tax payable overstated forever.
    const invoice = build(1);
    const credit = build(-1);

    expect(credit).toHaveLength(invoice.length);
    invoice.forEach((line, i) => {
      expect(credit[i]?.accountId).toBe(line.accountId);
      expect(credit[i]?.debit).toBe(line.credit);
      expect(credit[i]?.credit).toBe(line.debit);
    });
  });

  it('keeps the credit journal balanced', () => {
    // An unbalanced reversal would be caught later by the posting service, but
    // by then the failure names a journal, not the sign convention that broke.
    const credit = build(-1);
    const debits = credit.reduce((a, l) => a + Number(l.debit ?? 0), 0);
    const credits = credit.reduce((a, l) => a + Number(l.credit ?? 0), 0);
    expect(debits).toBe(credits);
  });

  it('credits AR on the credit note, reducing what the customer owes', () => {
    // If the AR line kept its invoice-side direction, a credit note would
    // RAISE the customer's balance — the exact opposite of what was issued.
    const credit = build(-1);
    expect(credit[0]).toMatchObject({ accountId: 'acct-ar', credit: '120.00000000' });
  });
});

describe('credit note application bounds', () => {
  const invoice = (
    id: string,
    due: string,
    over: Partial<AllocationTarget> = {},
  ): AllocationTarget => ({
    id,
    kind: 'INVOICE',
    amountDue: due,
    total: due,
    currency: 'GBP',
    exchangeRate: '1',
    legalEntityId: 'entity-1',
    status: 'POSTED',
    ...over,
  });

  const apply = (
    applications: Array<{ invoiceId: string; amount: string }>,
    targets: AllocationTarget[],
    available: string,
  ) =>
    validateAllocations({
      sourceUnapplied: available,
      sourceCurrency: 'GBP',
      requests: creditApplicationRequests(applications),
      targets: new Map(targets.map((t) => [t.id, t])),
      documentLabel: (t) => `invoice ${t.id}`,
    });

  it('restates applications as INVOICE allocation requests', () => {
    // The application path runs the same protocol as receipt allocation; a
    // parallel code path is how one of them ends up skipping a layer.
    expect(creditApplicationRequests([{ invoiceId: 'inv-1', amount: '10.00' }])).toEqual([
      { targetType: 'INVOICE', targetId: 'inv-1', amount: '10.00' },
    ]);
  });

  it('accepts an application within both the invoice and the credit', () => {
    expect(() =>
      apply([{ invoiceId: 'inv-1', amount: '60.00' }], [invoice('inv-1', '80.00')], '100.00'),
    ).not.toThrow();
  });

  it('refuses two applications that each fit and together exceed the credit', () => {
    // Each invoice can absorb 60, but the credit note only has 100 available.
    // Validated per request, both would pass, and the customer's 100 credit
    // would settle 120 of debt — AR understated by 20 with no journal saying so.
    expect(() =>
      apply(
        [
          { invoiceId: 'inv-1', amount: '60.00' },
          { invoiceId: 'inv-2', amount: '60.00' },
        ],
        [invoice('inv-1', '80.00'), invoice('inv-2', '80.00')],
        '100.00',
      ),
    ).toThrow(/120.*100.*unapplied/s);
  });

  it('refuses two applications to one invoice that together exceed its balance', () => {
    // The same failure on the target side: 50 and 50 each fit an 80 balance,
    // and together they overpay it. This is Gate G's concurrent-overpayment
    // test collapsed into one request set.
    expect(() =>
      apply(
        [
          { invoiceId: 'inv-1', amount: '50.00' },
          { invoiceId: 'inv-1', amount: '50.00' },
        ],
        [invoice('inv-1', '80.00')],
        '200.00',
      ),
    ).toThrow(/100.*inv-1.*80/s);
  });

  it('refuses application to an unposted invoice', () => {
    // A draft has no balance in the ledger; crediting it would record a
    // settlement of a receivable that was never posted.
    expect(() =>
      apply(
        [{ invoiceId: 'inv-1', amount: '10.00' }],
        [invoice('inv-1', '80.00', { status: 'DRAFT' })],
        '100.00',
      ),
    ).toThrow(/DRAFT/);
  });
});

describe('write-off bounds', () => {
  // The service runs the write-off through the same lock/validate protocol,
  // with the write-off amount as its own source. These are the bounds that
  // protocol enforces for it.
  const invoice = (due: string, over: Partial<AllocationTarget> = {}): AllocationTarget => ({
    id: 'inv-1',
    kind: 'INVOICE',
    amountDue: due,
    total: '100.00',
    currency: 'GBP',
    exchangeRate: '1',
    legalEntityId: 'entity-1',
    status: 'PARTIALLY_PAID',
    ...over,
  });

  const writeOff = (amount: string, target: AllocationTarget) =>
    validateAllocations({
      sourceUnapplied: amount,
      sourceCurrency: 'GBP',
      requests: [{ targetType: 'INVOICE', targetId: 'inv-1', amount }],
      targets: new Map([[target.id, target]]),
      documentLabel: (t) => `invoice ${t.id}`,
    });

  it('accepts a write-off up to the open balance', () => {
    expect(() => writeOff('80.00', invoice('80.00'))).not.toThrow();
  });

  it('refuses a write-off above the open balance, naming both numbers', () => {
    // Writing off 90 of an 80 balance credits AR for 10 nobody is owed; the
    // control account then reads below the sum of the open items — the exact
    // reconciliation doc 04 makes an acceptance criterion.
    expect(() => writeOff('90.00', invoice('80.00'))).toThrow(/90.*inv-1.*80/s);
  });

  it('refuses a zero or negative write-off', () => {
    // A negative write-off is a recovery, and doc 04 gives recovery its own
    // treatment; smuggling it through here would post bad debt expense backwards.
    expect(() => writeOff('0', invoice('80.00'))).toThrow(/not positive/);
  });

  it('refuses to write off a draft invoice', () => {
    // A draft never reached the ledger; there is no receivable to relieve.
    // Voiding is the draft's exit, not bad debt.
    expect(() => writeOff('10.00', invoice('80.00', { status: 'DRAFT' }))).toThrow(/DRAFT/);
  });
});

describe('refund bounds', () => {
  it('accepts a refund of exactly what is unapplied', () => {
    expect(() =>
      assertRefundWithinAvailable('50.00', '50.00', 'GBP', 'credit note CN-1'),
    ).not.toThrow();
  });

  it('refuses a refund above the unapplied amount, naming the source', () => {
    // Money already applied to an invoice has settled that invoice; refunding
    // it too would pay the same credit out twice — once to the invoice, once
    // to the customer's bank account.
    expect(() => assertRefundWithinAvailable('60.00', '50.00', 'GBP', 'credit note CN-1')).toThrow(
      /60.*CN-1.*50.*unapplied/s,
    );
    expect(
      codeOf(() => assertRefundWithinAvailable('60.00', '50.00', 'GBP', 'credit note CN-1')),
    ).toBe('OVER_ALLOCATION');
  });

  it('refuses a zero or negative refund', () => {
    // A negative refund is a receipt wearing a refund's number sequence.
    expect(() => assertRefundWithinAvailable('0', '50.00', 'GBP', 'receipt RCP-1')).toThrow(
      /not positive/,
    );
  });
});

describe('quote conversion preserves the lines and their tax treatment', () => {
  const quoteLines = [
    {
      line_no: 1,
      description: 'Consulting',
      quantity: '10',
      unit_price: '150.00',
      discount_amount: '50.00',
      tax_code_id: 'tax-std',
    },
    {
      line_no: 2,
      description: 'Zero-rated export',
      quantity: '1',
      unit_price: '500.00',
      discount_amount: null,
      tax_code_id: 'tax-zero',
    },
    {
      line_no: 3,
      description: 'Out of scope',
      quantity: '1',
      unit_price: '20.00',
      discount_amount: null,
      tax_code_id: null,
    },
  ];

  it('carries every line with its tax code through the copy (F-701/F-706)', () => {
    // Conversion that drops tax_code_id retaxes the document at whatever
    // default applies — a zero-rated export line would pick up standard VAT
    // and the invoice would charge the customer tax the quote never did.
    const inputs = conversionLineInputs(quoteLines);

    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toMatchObject({
      lineNo: 1,
      description: 'Consulting',
      quantity: '10',
      unitPrice: '150.00',
      discountAmount: '50.00',
      taxCodeId: 'tax-std',
    });
    expect(inputs[1]?.taxCodeId).toBe('tax-zero');
    // Untaxed is a statement, not an omission: the line converts with no code
    // rather than inheriting a sibling's.
    expect(inputs[2]?.taxCodeId).toBeUndefined();
  });

  it('produces invoice lines that keep the tax code when the revenue account is added', () => {
    // The second hop: order/quote lines become invoice lines by adding the
    // revenue account, and the spread must not clobber the treatment.
    const invoiceLines = conversionLineInputs(quoteLines).map((line) => ({
      ...line,
      revenueAccountId: 'acct-revenue',
    }));
    expect(invoiceLines[0]).toMatchObject({
      taxCodeId: 'tax-std',
      revenueAccountId: 'acct-revenue',
    });
    expect(invoiceLines.map((l) => l.lineNo)).toEqual([1, 2, 3]);
  });
});

describe('recurring occurrence arithmetic', () => {
  it('advances by the stated frequency', () => {
    expect(nextOccurrenceDate('2026-01-01', 'WEEKLY')).toBe('2026-01-08');
    expect(nextOccurrenceDate('2026-01-01', 'MONTHLY')).toBe('2026-02-01');
    expect(nextOccurrenceDate('2026-01-01', 'QUARTERLY')).toBe('2026-04-01');
    expect(nextOccurrenceDate('2026-01-01', 'ANNUAL')).toBe('2027-01-01');
  });

  it('clamps month-end rather than spilling into the next month', () => {
    // A template anchored on Jan 31 must run on Feb 28. Spilling to Mar 3
    // would put two occurrences in March and invoice the customer twice in
    // one month — the exact double-billing idempotency exists to prevent.
    expect(nextOccurrenceDate('2026-01-31', 'MONTHLY')).toBe('2026-02-28');
    expect(nextOccurrenceDate('2024-01-31', 'MONTHLY')).toBe('2024-02-29');
  });

  it('is deterministic: the same cursor always names the same dates', () => {
    // Generation is idempotent because these dates plus the UNIQUE
    // (template_id, occurrence_date) constraint decide everything; a
    // wall-clock-dependent generator would make the constraint unreachable.
    const first = dueOccurrenceDates('2026-01-01', 'MONTHLY', '2026-03-15');
    const second = dueOccurrenceDates('2026-01-01', 'MONTHLY', '2026-03-15');
    expect(first).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    expect(second).toEqual(first);
  });

  it('generates nothing on a rerun from the advanced cursor', () => {
    // After a successful run the cursor moves past the last occurrence;
    // running the job again for the same day must produce an empty set, not a
    // second January invoice.
    const generated = dueOccurrenceDates('2026-01-01', 'MONTHLY', '2026-03-15');
    const advanced = nextOccurrenceDate(generated[generated.length - 1]!, 'MONTHLY');
    expect(dueOccurrenceDates(advanced, 'MONTHLY', '2026-03-15')).toEqual([]);
  });

  it('never generates past the template end date', () => {
    // A subscription that ended in February must not invoice March, however
    // late the job runs.
    expect(dueOccurrenceDates('2026-01-01', 'MONTHLY', '2026-06-30', '2026-02-28')).toEqual([
      '2026-01-01',
      '2026-02-01',
    ]);
  });

  it('refuses an unknown frequency rather than guessing a cadence', () => {
    expect(() => nextOccurrenceDate('2026-01-01', 'FORTNIGHTLY')).toThrow(/FORTNIGHTLY/);
  });
});

describe('assertInvoiceEditable', () => {
  it('permits DRAFT and nothing else', () => {
    // doc 04: DRAFT is the only editable state. Everything after it is either
    // covered by an approval or already an accounting fact.
    expect(() => assertInvoiceEditable('DRAFT')).not.toThrow();
  });

  it('refuses posted states as POSTED_IMMUTABLE', () => {
    // Editing a posted invoice would make it disagree with its own journal
    // for the rest of time — doc 01 rule 4's exact failure. The code matters:
    // POSTED_IMMUTABLE tells the client this needs a credit note, not a retry.
    for (const status of ['POSTED', 'PARTIALLY_PAID', 'PAID']) {
      expect(codeOf(() => assertInvoiceEditable(status))).toBe('POSTED_IMMUTABLE');
      expect(() => assertInvoiceEditable(status)).toThrow(/credit note/);
    }
  });

  it('refuses approval states, because the approval covers the submitted figures', () => {
    // Editing under a pending or granted approval posts amounts nobody
    // approved — the quiet way around the approval control.
    for (const status of ['PENDING_APPROVAL', 'APPROVED']) {
      expect(codeOf(() => assertInvoiceEditable(status))).toBe('VALIDATION_FAILED');
      expect(() => assertInvoiceEditable(status)).toThrow(/approval/i);
    }
  });

  it('refuses VOID and CANCELLED as closed history', () => {
    // A void invoice must stay the invoice that was voided; editing it back
    // to life would resurrect a number the audit trail says is dead.
    for (const status of ['VOID', 'CANCELLED']) {
      expect(codeOf(() => assertInvoiceEditable(status))).toBe('VALIDATION_FAILED');
      expect(() => assertInvoiceEditable(status)).toThrow(/closed history/);
    }
  });
});
