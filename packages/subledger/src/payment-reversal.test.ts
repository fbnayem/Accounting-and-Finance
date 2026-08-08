import { describe, it, expect } from 'vitest';
import { mirrorPaymentJournals, type PostedPaymentJournal } from './ap.service';

/**
 * VENDOR_PAYMENT_REVERSED, as executable assertions.
 *
 * When the bank reports a payment FAILED, every journal the payment posted is
 * cancelled by a compensating entry mirrored from its own stored lines. This is
 * the pure half of that: lines in the shape `PostingService.readLines` returns
 * them — both sides present, the empty one zero — with debit and credit
 * swapped and nothing else touched. The integration suite proves the mirrors
 * survive the round trip through the posting kernel.
 */

const line = (over: {
  accountId: string;
  debit?: string;
  credit?: string;
  description?: string;
  contactId?: string | null;
  transactionCurrency?: string;
  exchangeRate?: string | null;
  dimensions?: Record<string, string>;
}) => ({
  description: null,
  transactionCurrency: 'GBP',
  exchangeRate: '1',
  contactId: null,
  debit: '0.00000000',
  credit: '0.00000000',
  ...over,
});

/** VENDOR_PAYMENT_POSTED: Dr AP allocated, Dr advance remainder, Cr bank full. */
const creationEntry: PostedPaymentJournal = {
  entryId: 'entry-creation',
  lines: [
    line({ accountId: 'acct-ap', debit: '60.00000000', contactId: 'vendor-1' }),
    line({ accountId: 'acct-advance', debit: '40.00000000', contactId: 'vendor-1' }),
    line({ accountId: 'acct-bank', credit: '100.00000000' }),
  ],
};

/** VENDOR_PAYMENT_ALLOCATED: Dr AP, Cr advance, plus the realized FX residue. */
const allocationEntry: PostedPaymentJournal = {
  entryId: 'entry-allocation',
  lines: [
    line({ accountId: 'acct-ap', debit: '40.00000000', contactId: 'vendor-1' }),
    line({ accountId: 'acct-advance', credit: '40.00000000', contactId: 'vendor-1' }),
    line({ accountId: 'acct-ap', debit: '1.50000000', contactId: 'vendor-1' }),
    line({ accountId: 'acct-fx-gain', credit: '1.50000000' }),
  ],
};

const sum = (lines: Array<{ debit?: string; credit?: string }>, side: 'debit' | 'credit') =>
  lines.reduce((a, l) => a + Number(l[side] ?? 0), 0);

describe('VENDOR_PAYMENT_REVERSED', () => {
  it('swaps every debit and credit and still balances', () => {
    // A half-swapped mirror would not cancel the original — the ledger would
    // keep saying cash left the bank for a payment the bank refused, which is
    // the AP-control-vs-aging divergence this rule exists to close.
    const [mirrored] = mirrorPaymentJournals([creationEntry]);

    expect(mirrored!.lines).toHaveLength(3);
    for (const [index, original] of creationEntry.lines.entries()) {
      expect(mirrored!.lines[index]).toMatchObject({
        accountId: original.accountId,
        debit: original.credit,
        credit: original.debit,
      });
    }
    expect(sum(mirrored!.lines, 'debit')).toBe(sum(mirrored!.lines, 'credit'));
    expect(sum(mirrored!.lines, 'debit')).toBe(sum(creationEntry.lines, 'credit'));
  });

  it('mirrors every entry the payment produced, not only the creation', () => {
    // A later allocation posted its own journal (Dr AP, Cr advance, realized
    // FX). Reversing only VENDOR_PAYMENT_POSTED would leave that
    // reclassification standing: AP relieved, an FX gain recognized, for a
    // settlement that never happened.
    const mirrored = mirrorPaymentJournals([creationEntry, allocationEntry]);

    expect(mirrored).toHaveLength(2);
    expect(mirrored.map((m) => m.entryId)).toEqual(['entry-creation', 'entry-allocation']);

    const allocation = mirrored[1]!;
    // The realized FX pair flips with everything else: the gain that never
    // settled comes back out of the FX account, not out of a plug.
    expect(allocation.lines[2]).toMatchObject({ accountId: 'acct-ap', credit: '1.50000000' });
    expect(allocation.lines[3]).toMatchObject({ accountId: 'acct-fx-gain', debit: '1.50000000' });
    expect(sum(allocation.lines, 'debit')).toBe(sum(allocation.lines, 'credit'));
  });

  it('mirrors nothing for a payment that never posted', () => {
    // A payment that failed before it reached the ledger has nothing to
    // compensate; posting anything for it would create movement out of nothing
    // and the "reversal" would itself be the divergence.
    expect(mirrorPaymentJournals([])).toEqual([]);
  });

  it('preserves contact and dimension attribution on every line', () => {
    // The reversal must drill back to the same vendor and the same cost centre
    // as the entry it cancels. A mirror that drops the contact leaves the
    // vendor's AP activity non-zero after a failure that changed nothing, and a
    // dropped dimension leaves one side of a dimension report uncancelled.
    const entry: PostedPaymentJournal = {
      entryId: 'entry-1',
      lines: [
        line({
          accountId: 'acct-ap',
          debit: '100.00000000',
          contactId: 'vendor-1',
          dimensions: { 'dim-dept': 'val-ops' },
        }),
        line({ accountId: 'acct-bank', credit: '100.00000000' }),
      ],
    };
    const [mirrored] = mirrorPaymentJournals([entry]);

    expect(mirrored!.lines[0]).toMatchObject({
      accountId: 'acct-ap',
      credit: '100.00000000',
      contactId: 'vendor-1',
      dimensions: { 'dim-dept': 'val-ops' },
    });
    // And nowhere it was not: the bank line stays anonymous, or every
    // "AP by vendor" query that joins through journal_lines double-counts.
    expect(mirrored!.lines.filter((l) => l.contactId === 'vendor-1')).toHaveLength(1);
  });

  it('copies currency and rate verbatim rather than re-deriving them', () => {
    // doc 03: a reversal copies, it does not recompute. Re-deriving the base
    // amount from today's rate would produce a mirror that does not cancel the
    // original — the one thing a reversal has to do.
    const entry: PostedPaymentJournal = {
      entryId: 'entry-1',
      lines: [
        line({
          accountId: 'acct-ap',
          debit: '100.00000000',
          transactionCurrency: 'EUR',
          exchangeRate: '0.85432100',
        }),
        line({
          accountId: 'acct-bank',
          credit: '100.00000000',
          transactionCurrency: 'EUR',
          exchangeRate: '0.85432100',
        }),
      ],
    };
    const [mirrored] = mirrorPaymentJournals([entry]);

    for (const mirroredLine of mirrored!.lines) {
      expect(mirroredLine).toMatchObject({
        transactionCurrency: 'EUR',
        exchangeRate: '0.85432100',
      });
    }
  });
});
