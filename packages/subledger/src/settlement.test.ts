import { describe, it, expect } from 'vitest';
import { realizedFx, type DraftLineInput } from '@acct/domain';
import { settlementPostingLines, type SettlementAllocation } from './allocation';
import { vendorPaymentLines } from './ap.service';

/**
 * The settlement half of the posting rule catalog, as executable assertions.
 *
 * These builders are what stands between "the invoice reads paid" and "the
 * ledger knows why": CUSTOMER_RECEIPT_ALLOCATED / VENDOR_PAYMENT_ALLOCATED
 * reclassify advances onto the control accounts and crystallise realized FX,
 * and VENDOR_PAYMENT_POSTED splits a payment between AP and vendor advances.
 * Pure inputs and pure outputs, in the manner of posting-lines.test.ts.
 */

const sum = (lines: readonly DraftLineInput[], side: 'debit' | 'credit') =>
  lines.reduce((a, l) => a + Number(l[side] ?? 0), 0);

/** Base-currency total: each line converts at its own rate; base lines at 1. */
const baseSum = (lines: readonly DraftLineInput[], side: 'debit' | 'credit') =>
  lines.reduce((a, l) => a + Number(l[side] ?? 0) * Number(l.exchangeRate ?? 1), 0);

const allocation = (over: Partial<SettlementAllocation> = {}): SettlementAllocation => ({
  allocationId: 'alloc-1',
  targetId: 'inv-1',
  amount: '100.00',
  documentRate: '1',
  realizedFx: '0',
  ...over,
});

const arBuild = (
  allocations: SettlementAllocation[],
  over: Partial<Parameters<typeof settlementPostingLines>[0]> = {},
) =>
  settlementPostingLines({
    side: 'AR',
    controlAccountId: 'acct-ar',
    advanceAccountId: 'acct-advance',
    realizedFxGainAccountId: 'acct-fx-gain',
    realizedFxLossAccountId: 'acct-fx-loss',
    contactId: 'customer-1',
    currency: 'EUR',
    baseCurrency: 'GBP',
    settlementRate: '1',
    allocations,
    ...over,
  });

describe('CUSTOMER_RECEIPT_ALLOCATED', () => {
  it('debits the customer advance and credits AR — and not the reverse', () => {
    // The reversed posting would GROW the receivable every time cash was
    // applied to it: AR overstated by twice the allocation, and the advance
    // account driven negative. Direction is the whole content of this rule.
    const lines = arBuild([allocation()]);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountId: 'acct-ar', credit: '100.00' });
    expect(lines[1]).toMatchObject({ accountId: 'acct-advance', debit: '100.00' });
    expect(lines.find((l) => l.accountId === 'acct-ar')?.debit).toBeUndefined();
    expect(lines.find((l) => l.accountId === 'acct-advance')?.credit).toBeUndefined();
  });

  it('balances in base currency when the invoice was booked at another rate', () => {
    // Control at the document rate, advance at the settlement rate, FX line
    // for the difference. If these three do not sum to zero the posting kernel
    // refuses the journal — which is the design: an unbalanced settlement is
    // an error, never a misstatement quietly absorbed into AR.
    const fx = realizedFx({
      allocatedAmount: '100.00',
      documentRate: '1.2',
      settlementRate: '1',
      baseCurrency: 'GBP',
    });
    const lines = arBuild([allocation({ documentRate: '1.2', realizedFx: fx })]);

    expect(baseSum(lines, 'debit')).toBeCloseTo(baseSum(lines, 'credit'), 6);
  });

  it('puts a realized gain on the gain account as a credit', () => {
    // Settling above the booked rate collected more base currency than the
    // receivable carried. Posting that as a debit — or to the loss account —
    // inverts the P&L; either way the income statement lies by twice the FX.
    const fx = realizedFx({
      allocatedAmount: '100.00',
      documentRate: '1',
      settlementRate: '1.1',
      baseCurrency: 'GBP',
    });
    const lines = arBuild([allocation({ documentRate: '1', realizedFx: fx })], {
      settlementRate: '1.1',
    });

    const gain = lines.find((l) => l.accountId === 'acct-fx-gain');
    expect(gain).toMatchObject({ credit: '10.00000000' });
    expect(lines.find((l) => l.accountId === 'acct-fx-loss')).toBeUndefined();
    expect(baseSum(lines, 'debit')).toBeCloseTo(baseSum(lines, 'credit'), 6);
  });

  it('puts a realized loss on the loss account as a debit', () => {
    const fx = realizedFx({
      allocatedAmount: '100.00',
      documentRate: '1.2',
      settlementRate: '1',
      baseCurrency: 'GBP',
    });
    const lines = arBuild([allocation({ documentRate: '1.2', realizedFx: fx })]);

    const loss = lines.find((l) => l.accountId === 'acct-fx-loss');
    expect(loss).toMatchObject({ debit: '20.00000000' });
    expect(lines.find((l) => l.accountId === 'acct-fx-gain')).toBeUndefined();
  });

  it('posts nothing for a zero-amount, zero-FX allocation', () => {
    // The posting kernel refuses an entry with no lines, so the caller skips
    // the posting entirely. An empty journal entry would consume an entry
    // number and record nothing — a gap an auditor asks about.
    expect(arBuild([allocation({ amount: '0', realizedFx: '0' })])).toHaveLength(0);
    expect(arBuild([])).toHaveLength(0);
  });

  it('corrects only the control account when the amount is zero but FX is not', () => {
    // The creation-time path: the receipt posting already credited AR at the
    // settlement rate, so what remains is the difference to the booked rate.
    // Without this pair the base residue sits in the control account forever
    // with no open item explaining it — the aging reconciles to nothing.
    const fx = realizedFx({
      allocatedAmount: '100.00',
      documentRate: '1.2',
      settlementRate: '1',
      baseCurrency: 'GBP',
    });
    const lines = arBuild([allocation({ amount: '0', documentRate: '1.2', realizedFx: fx })]);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ accountId: 'acct-ar', credit: '20.00000000' });
    expect(lines[1]).toMatchObject({ accountId: 'acct-fx-loss', debit: '20.00000000' });
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });

  it('refuses when no advance account is configured, naming the policy column', () => {
    // A guessed account would reclassify the money somewhere no reconciliation
    // reads; the error names the exact column to fix instead.
    expect(() => arBuild([allocation()], { advanceAccountId: null })).toThrow(
      /customer_advance_account_id/,
    );
  });

  it('refuses a realized gain with no gain account, naming the policy column', () => {
    const fx = realizedFx({
      allocatedAmount: '100.00',
      documentRate: '1',
      settlementRate: '1.1',
      baseCurrency: 'GBP',
    });
    expect(() =>
      arBuild([allocation({ realizedFx: fx })], { realizedFxGainAccountId: null }),
    ).toThrow(/realized_fx_gain_account_id/);
  });
});

describe('VENDOR_PAYMENT_ALLOCATED', () => {
  const apBuild = (allocations: SettlementAllocation[]) =>
    settlementPostingLines({
      side: 'AP',
      controlAccountId: 'acct-ap',
      advanceAccountId: 'acct-vendor-advance',
      realizedFxGainAccountId: 'acct-fx-gain',
      realizedFxLossAccountId: 'acct-fx-loss',
      contactId: 'vendor-1',
      currency: 'EUR',
      baseCurrency: 'GBP',
      settlementRate: '1.1',
      allocations,
    });

  it('debits AP and credits the vendor advance — the mirror of the AR side', () => {
    // Getting the AP side backwards inflates what we owe every time we pay it
    // down; the aging falls while the control account climbs.
    const lines = apBuild([allocation({ targetId: 'bill-1', documentRate: '1.1' })]);

    expect(lines[0]).toMatchObject({ accountId: 'acct-ap', debit: '100.00' });
    expect(lines[1]).toMatchObject({ accountId: 'acct-vendor-advance', credit: '100.00' });
  });

  it('treats settling above the booked rate as a LOSS on the AP side', () => {
    // The sign flip that a shared implementation gets wrong: paying more base
    // currency than the bill carried is a loss for us — the same rate movement
    // that is a gain when we are the ones being paid.
    const fx = realizedFx({
      allocatedAmount: '100.00',
      documentRate: '1',
      settlementRate: '1.1',
      baseCurrency: 'GBP',
    });
    const lines = apBuild([allocation({ targetId: 'bill-1', documentRate: '1', realizedFx: fx })]);

    expect(lines.find((l) => l.accountId === 'acct-fx-loss')).toMatchObject({
      debit: '10.00000000',
    });
    expect(lines.find((l) => l.accountId === 'acct-fx-gain')).toBeUndefined();
    expect(baseSum(lines, 'debit')).toBeCloseTo(baseSum(lines, 'credit'), 6);
  });
});

describe('VENDOR_PAYMENT_POSTED', () => {
  const build = (over: Partial<Parameters<typeof vendorPaymentLines>[0]> = {}) =>
    vendorPaymentLines({
      amount: '100.00',
      allocatedTotal: '60.00',
      apAccountId: 'acct-ap',
      vendorAdvanceAccountId: 'acct-vendor-advance',
      paymentAccountId: 'acct-bank',
      currency: 'GBP',
      exchangeRate: '1',
      contactId: 'vendor-1',
      reference: 'Payment PAY-00001',
      ...over,
    });

  it('splits between AP and vendor advance and still balances', () => {
    // Debiting the whole payment to AP hides the prepayment inside the control
    // account: AP understated by the unapplied 40, and no visible advance for
    // the vendor to deliver against — the exact thing doc 05 keeps visible.
    const lines = build();

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ accountId: 'acct-ap', debit: '60.00000000' });
    expect(lines[1]).toMatchObject({ accountId: 'acct-vendor-advance', debit: '40.00000000' });
    expect(lines[2]).toMatchObject({ accountId: 'acct-bank', credit: '100.00' });
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });

  it('omits the advance line when the payment is fully applied', () => {
    // A zero advance line is not harmless: it makes every payment appear in
    // the advance account's activity, and zero-amount journals are refused by
    // the kernel anyway.
    const lines = build({ allocatedTotal: '100.00' });
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.accountId === 'acct-vendor-advance')).toBeUndefined();
    expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
  });

  it('puts the vendor on the AP and advance lines, not the bank line', () => {
    // The contact on the subledger-control lines is what makes the ledger
    // drillable back to a vendor; on the bank line it would double-count any
    // "payments by vendor" query that joins through journal_lines.
    const lines = build();
    expect(lines.filter((l) => l.contactId === 'vendor-1')).toHaveLength(2);
    expect(lines[lines.length - 1]?.contactId).toBeUndefined();
  });

  it('refuses unapplied cash with no advance account, naming the policy column', () => {
    expect(() => build({ vendorAdvanceAccountId: null })).toThrow(/vendor_advance_account_id/);
  });

  it('refuses allocations exceeding the payment amount', () => {
    // The database's deferred trigger would catch this at COMMIT; refusing
    // here names the two numbers instead of surfacing a constraint name.
    expect(() => build({ allocatedTotal: '120.00' })).toThrow(/cannot apply more/);
  });
});
