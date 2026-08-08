import { describe, it, expect } from 'vitest';
import { calculateDocument, type CalculatedDocument } from '@acct/domain';
import { salesInvoiceLines, vendorBillLines } from './document-posting.service';
import { validateAllocations, type AllocationTarget } from './allocation';
import { normalizeInvoiceNumber } from './ap.service';

/**
 * The posting rule catalog, as executable assertions.
 *
 * These are the functions that turn a calculated document into debits and
 * credits, so they are where the catalog's SALES_INVOICE_POSTED and
 * VENDOR_BILL_POSTED entries either hold or quietly stop holding. Pure inputs
 * and pure outputs, so they can be checked without a database — the integration
 * suite proves the same rules survive the round trip.
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

describe('SALES_INVOICE_POSTED', () => {
  const build = (doc: CalculatedDocument) =>
    salesInvoiceLines({
      calculated: doc,
      revenueAccountByLine: new Map([[1, 'acct-revenue']]),
      taxAccountByComponent: new Map([['comp-1', 'acct-output-tax']]),
      arAccountId: 'acct-ar',
      currency: 'GBP',
      baseCurrency: 'GBP',
      exchangeRate: '1',
      exchangeRateDate: null,
      contactId: 'customer-1',
    });

  it('debits AR gross and credits revenue net and tax', () => {
    const lines = build(document('100.00'));

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ accountId: 'acct-ar', debit: '120.00000000' });
    expect(lines[1]).toMatchObject({ accountId: 'acct-revenue', credit: '100.00000000' });
    expect(lines[2]).toMatchObject({ accountId: 'acct-output-tax', credit: '20.00000000' });
  });

  it('balances', () => {
    const lines = build(document('100.00'));
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });

  it('puts the customer on the AR line and nowhere else', () => {
    // The contact on the control-account line is what makes the ledger drillable
    // back to a customer. On the revenue line it would double-count every
    // "sales by customer" query that joins through journal_lines.
    const lines = build(document('100.00'));
    expect(lines.filter((l) => l.contactId === 'customer-1')).toHaveLength(1);
    expect(lines[0]?.contactId).toBe('customer-1');
  });

  it('omits the tax line entirely when there is no tax', () => {
    const zeroRated = calculateDocument(
      [{ lineNo: 1, description: 'Line 1', quantity: '1', unitPrice: '100.00' }],
      { currency: 'GBP' },
    );
    const lines = build(zeroRated);
    expect(lines).toHaveLength(2);
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });

  it('inverts every line for a credit note', () => {
    // The credit note posts the same rule with sign -1 rather than a second
    // function, so the two can never disagree about which account moves.
    const lines = salesInvoiceLines({
      calculated: document('100.00'),
      revenueAccountByLine: new Map([[1, 'acct-revenue']]),
      taxAccountByComponent: new Map([['comp-1', 'acct-output-tax']]),
      arAccountId: 'acct-ar',
      currency: 'GBP',
      baseCurrency: 'GBP',
      exchangeRate: '1',
      exchangeRateDate: null,
      contactId: 'customer-1',
      sign: -1,
    });

    expect(lines[0]).toMatchObject({ accountId: 'acct-ar', credit: '120.00000000' });
    expect(lines[1]).toMatchObject({ accountId: 'acct-revenue', debit: '100.00000000' });
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });

  it('refuses a line with no revenue account rather than inventing one', () => {
    expect(() =>
      salesInvoiceLines({
        calculated: document('100.00'),
        revenueAccountByLine: new Map(),
        taxAccountByComponent: new Map([['comp-1', 'acct-output-tax']]),
        arAccountId: 'acct-ar',
        currency: 'GBP',
        baseCurrency: 'GBP',
        exchangeRate: '1',
        exchangeRateDate: null,
        contactId: 'customer-1',
      }),
    ).toThrow(/no revenue account/);
  });

  it('names the tax code when its output account is missing', () => {
    // A suspense account would make this post and make the tax return wrong, so
    // it fails with the thing to fix rather than the thing that broke.
    expect(() =>
      salesInvoiceLines({
        calculated: document('100.00'),
        revenueAccountByLine: new Map([[1, 'acct-revenue']]),
        taxAccountByComponent: new Map(),
        arAccountId: 'acct-ar',
        currency: 'GBP',
        baseCurrency: 'GBP',
        exchangeRate: '1',
        exchangeRateDate: null,
        contactId: 'customer-1',
      }),
    ).toThrow(/payable_account_id/);
  });
});

describe('VENDOR_BILL_POSTED', () => {
  const build = (doc: CalculatedDocument, taxAccounts = new Map([['comp-1', 'acct-input-tax']])) =>
    vendorBillLines({
      calculated: doc,
      destinationAccountByLine: new Map([[1, 'acct-expense']]),
      taxAccountByComponent: taxAccounts,
      apAccountId: 'acct-ap',
      currency: 'GBP',
      exchangeRate: '1',
      exchangeRateDate: null,
      contactId: 'vendor-1',
    });

  it('debits the destination and recoverable tax, credits AP gross', () => {
    const lines = build(document('100.00'));

    expect(lines[0]).toMatchObject({ accountId: 'acct-expense', debit: '100.00000000' });
    expect(lines[1]).toMatchObject({ accountId: 'acct-input-tax', debit: '20.00000000' });
    expect(lines[2]).toMatchObject({ accountId: 'acct-ap', credit: '120.00000000' });
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });

  it('capitalises non-recoverable tax into the line, not into a tax account', () => {
    // doc 07: "Nonrecoverable tax capitalizes into inventory/asset cost or
    // expense based on line destination." 50% recoverable on 20 tax means 10
    // goes to input tax and 10 joins the expense — posting all 20 to the tax
    // account is the standard way an expense ends up understated.
    const lines = build(document('100.00', '0.20', '0.5'));

    expect(lines[0]).toMatchObject({ accountId: 'acct-expense', debit: '110.00000000' });
    expect(lines[1]).toMatchObject({ accountId: 'acct-input-tax', debit: '10.00000000' });
    expect(lines[2]).toMatchObject({ accountId: 'acct-ap', credit: '120.00000000' });
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });

  it('needs no input tax account when nothing is recoverable', () => {
    // Fully non-recoverable tax never reaches a tax account, so demanding one
    // would block a legitimate configuration.
    const lines = build(document('100.00', '0.20', '0'), new Map());

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountId: 'acct-expense', debit: '120.00000000' });
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });

  it('puts the vendor on the AP line', () => {
    const lines = build(document('100.00'));
    expect(lines.filter((l) => l.contactId === 'vendor-1')).toHaveLength(1);
    expect(lines[lines.length - 1]?.contactId).toBe('vendor-1');
  });
});

describe('allocation validation', () => {
  const target = (over: Partial<AllocationTarget> = {}): AllocationTarget => ({
    id: 'inv-1',
    kind: 'INVOICE',
    amountDue: '100.00',
    total: '100.00',
    currency: 'GBP',
    exchangeRate: '1',
    legalEntityId: 'entity-1',
    status: 'POSTED',
    ...over,
  });

  const validate = (
    requests: Array<{ targetType: 'INVOICE'; targetId: string; amount: string }>,
    targets: AllocationTarget[],
    unapplied = '500.00',
  ) =>
    validateAllocations({
      sourceUnapplied: unapplied,
      sourceCurrency: 'GBP',
      requests,
      targets: new Map(targets.map((t) => [t.id, t])),
      documentLabel: (t) => `invoice ${t.id}`,
    });

  it('accepts an allocation within the outstanding balance', () => {
    expect(() =>
      validate([{ targetType: 'INVOICE', targetId: 'inv-1', amount: '60.00' }], [target()]),
    ).not.toThrow();
  });

  it('refuses more than the invoice has outstanding, naming both numbers', () => {
    expect(() =>
      validate([{ targetType: 'INVOICE', targetId: 'inv-1', amount: '120.00' }], [target()]),
    ).toThrow(/120.*inv-1.*100/s);
  });

  it('sums two allocations to the same invoice before comparing', () => {
    // The one a per-request check misses: 60 and 60 are each under 100, and
    // together they are not. This is Gate G's "two receipts allocated to last
    // invoice balance" in miniature.
    expect(() =>
      validate(
        [
          { targetType: 'INVOICE', targetId: 'inv-1', amount: '60.00' },
          { targetType: 'INVOICE', targetId: 'inv-1', amount: '60.00' },
        ],
        [target()],
      ),
    ).toThrow(/120/);
  });

  it('refuses more than the receipt has unapplied', () => {
    expect(() =>
      validate(
        [{ targetType: 'INVOICE', targetId: 'inv-1', amount: '90.00' }],
        [target()],
        '50.00',
      ),
    ).toThrow(/only 50.*unapplied/);
  });

  it('refuses an allocation against an unposted invoice', () => {
    expect(() =>
      validate(
        [{ targetType: 'INVOICE', targetId: 'inv-1', amount: '10.00' }],
        [target({ status: 'DRAFT' })],
      ),
    ).toThrow(/DRAFT.*posted document has a balance/s);
  });

  it('refuses a cross-currency allocation rather than guessing a rate', () => {
    expect(() =>
      validate(
        [{ targetType: 'INVOICE', targetId: 'inv-1', amount: '10.00' }],
        [target({ currency: 'EUR' })],
      ),
    ).toThrow(/EUR.*GBP.*settlement rate/s);
  });

  it('refuses a zero or negative allocation', () => {
    expect(() =>
      validate([{ targetType: 'INVOICE', targetId: 'inv-1', amount: '0' }], [target()]),
    ).toThrow(/not positive/);
  });
});

describe('duplicate invoice number normalisation', () => {
  it('treats case, separators and padding as the same document', () => {
    // doc 05's "similar invoice number normalization". Each of these is the same
    // bill re-keyed by a different person, and each would otherwise slip past a
    // plain equality check.
    expect(normalizeInvoiceNumber('INV-0042')).toBe('INV42');
    expect(normalizeInvoiceNumber('inv 42')).toBe('INV42');
    expect(normalizeInvoiceNumber('Inv/42')).toBe('INV42');
    expect(normalizeInvoiceNumber('  inv_42  ')).toBe('INV42');
  });

  it('keeps genuinely different numbers different', () => {
    expect(normalizeInvoiceNumber('INV-421')).not.toBe(normalizeInvoiceNumber('INV-42'));
    expect(normalizeInvoiceNumber('2026-001')).not.toBe(normalizeInvoiceNumber('2025-001'));
  });

  it('does not collapse a number that is all zeros', () => {
    // The lookahead stops the strip at the last digit, so '000' stays a number
    // rather than becoming an empty string that matches every other empty one.
    expect(normalizeInvoiceNumber('000')).toBe('0');
    expect(normalizeInvoiceNumber('0')).toBe('0');
  });
});
