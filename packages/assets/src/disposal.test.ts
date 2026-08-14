import { describe, it, expect } from 'vitest';
import { AppError, D, disposalResult, type Decimal, type DraftLineInput } from '@acct/domain';
import { disposalJournalLines } from './disposal.service';

/**
 * The disposal journal, held to the two facts that make it correct:
 *
 *   1. `gain_loss = proceeds − carrying` — the database CHECK
 *      `dr_gain_loss_derived` re-derives this at COMMIT, so any drift between
 *      the engine and the journal builder is a rejected row, and this suite
 *      exercises the same expression the constraint does.
 *   2. The entry balances, with each contra account relieved of exactly what
 *      it holds — doc 09's generic entry, gain/loss leg on whichever side its
 *      sign puts it.
 */

const sum = (lines: readonly DraftLineInput[], side: 'debit' | 'credit'): Decimal =>
  lines.reduce((a, l) => a.add(D(l[side] ?? '0')), D('0'));

const accounts = {
  currency: 'BDT',
  assetNumber: 'FA-0001',
  assetAccountId: 'acct-cost',
  accumulatedDepreciationAccountId: 'acct-accdep',
  accumulatedImpairmentAccountId: 'acct-accimp',
  proceedsAccountId: 'acct-bank',
  gainAccountId: 'acct-gain',
  lossAccountId: 'acct-loss',
};

describe('disposalJournalLines', () => {
  it('a sale at a gain: Dr proceeds + Dr accumulated / Cr cost + Cr gain, balanced', () => {
    // 12,000 cost, 8,000 depreciated, sold for 5,000: carrying 4,000, gain
    // 1,000. The reversed gain leg (debit) would balance nothing; a gain
    // credited to the asset account would leave cost under-removed by 1,000
    // and the reconciliation report off by exactly that forever.
    const result = disposalResult({
      costBasis: D('12000.00'),
      accumulatedDepreciation: D('8000.00'),
      proceeds: D('5000.00'),
    });
    const lines = disposalJournalLines({
      ...accounts,
      result,
      accumulatedDepreciation: D('8000.00'),
      accumulatedImpairment: D('0'),
    });

    // The CHECK's expression, asserted the way the database will assert it.
    expect(result.gainLoss.equals(result.proceeds.sub(result.carryingAmount))).toBe(true);
    expect(result.gainLoss.equals(D('1000.00'))).toBe(true);

    expect(sum(lines, 'debit').equals(sum(lines, 'credit'))).toBe(true);
    expect(lines.find((l) => l.accountId === 'acct-gain')?.credit).toBeDefined();
    expect(lines.find((l) => l.accountId === 'acct-loss')).toBeUndefined();
    expect(D(lines.find((l) => l.accountId === 'acct-cost')!.credit!).equals(D('12000.00'))).toBe(
      true,
    );
  });

  it('a scrap at a loss: the loss is a debit and the entry still balances', () => {
    // No proceeds: the whole carrying amount of 4,000 is a loss. If the
    // builder emitted a proceeds leg of zero, prepare() downstream would
    // reject a zero line — so the leg must be absent, not zero.
    const result = disposalResult({
      costBasis: D('12000.00'),
      accumulatedDepreciation: D('8000.00'),
      proceeds: D('0'),
    });
    const lines = disposalJournalLines({
      ...accounts,
      result,
      accumulatedDepreciation: D('8000.00'),
      accumulatedImpairment: D('0'),
    });

    expect(result.gainLoss.equals(D('-4000.00'))).toBe(true);
    expect(sum(lines, 'debit').equals(sum(lines, 'credit'))).toBe(true);
    expect(lines.find((l) => l.accountId === 'acct-bank')).toBeUndefined();
    expect(D(lines.find((l) => l.accountId === 'acct-loss')!.debit!).equals(D('4000.00'))).toBe(
      true,
    );
  });

  it('an impaired asset relieves depreciation and impairment from their own accounts', () => {
    // 12,000 cost, 6,000 depreciated, 2,000 impaired, sold at its carrying
    // amount of 4,000 — no gain, no loss. Debiting the whole 8,000 contra from
    // the depreciation account would zero the asset but leave 2,000 stranded
    // in accumulated impairment for an asset that no longer exists.
    const result = disposalResult({
      costBasis: D('12000.00'),
      accumulatedDepreciation: D('6000.00').add(D('2000.00')),
      proceeds: D('4000.00'),
    });
    const lines = disposalJournalLines({
      ...accounts,
      result,
      accumulatedDepreciation: D('6000.00'),
      accumulatedImpairment: D('2000.00'),
    });

    expect(sum(lines, 'debit').equals(sum(lines, 'credit'))).toBe(true);
    expect(D(lines.find((l) => l.accountId === 'acct-accdep')!.debit!).equals(D('6000.00'))).toBe(
      true,
    );
    expect(D(lines.find((l) => l.accountId === 'acct-accimp')!.debit!).equals(D('2000.00'))).toBe(
      true,
    );
    expect(lines.find((l) => l.accountId === 'acct-gain')).toBeUndefined();
    expect(lines.find((l) => l.accountId === 'acct-loss')).toBeUndefined();
  });

  it('refuses proceeds with nowhere to land, and a gain/loss with no account', () => {
    // Each missing account would otherwise surface as an unbalanced-journal
    // error deep inside the posting service, far from the configuration
    // mistake that caused it (the F-810 lesson: name the actual problem).
    const gain = disposalResult({
      costBasis: D('1000.00'),
      accumulatedDepreciation: D('900.00'),
      proceeds: D('500.00'),
    });
    expect(() =>
      disposalJournalLines({
        ...accounts,
        proceedsAccountId: null,
        result: gain,
        accumulatedDepreciation: D('900.00'),
        accumulatedImpairment: D('0'),
      }),
    ).toThrowError(AppError);
    expect(() =>
      disposalJournalLines({
        ...accounts,
        gainAccountId: null,
        result: gain,
        accumulatedDepreciation: D('900.00'),
        accumulatedImpairment: D('0'),
      }),
    ).toThrowError(AppError);

    const loss = disposalResult({
      costBasis: D('1000.00'),
      accumulatedDepreciation: D('100.00'),
      proceeds: D('0'),
    });
    expect(() =>
      disposalJournalLines({
        ...accounts,
        lossAccountId: null,
        result: loss,
        accumulatedDepreciation: D('100.00'),
        accumulatedImpairment: D('0'),
      }),
    ).toThrowError(AppError);
  });

  it('refuses an impairment balance the category cannot relieve', () => {
    const result = disposalResult({
      costBasis: D('1000.00'),
      accumulatedDepreciation: D('500.00'),
      proceeds: D('500.00'),
    });
    expect(() =>
      disposalJournalLines({
        ...accounts,
        accumulatedImpairmentAccountId: null,
        result,
        accumulatedDepreciation: D('300.00'),
        accumulatedImpairment: D('200.00'),
      }),
    ).toThrowError(AppError);
  });
});
