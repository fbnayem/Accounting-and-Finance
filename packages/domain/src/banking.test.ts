import { describe, it, expect } from 'vitest';
import { D } from './decimal';
import { accountingDate } from './dates';
import {
  normalizeText,
  fingerprintTransaction,
  classifyIncoming,
  scoreCandidate,
  tokenSimilarity,
  reconcile,
  decomposeSettlement,
  AUTO_MATCH_THRESHOLD,
  MATCH_WEIGHTS,
} from './banking';

const d = accountingDate;

describe('normalizeText', () => {
  it('folds case, punctuation and whitespace runs', () => {
    expect(normalizeText('  ACME   Corp., Ltd.  ')).toBe('acme corp ltd');
  });

  it('keeps digits', () => {
    // The single most useful token in a bank memo is the invoice number. A
    // normaliser that stripped digits would defeat the matcher it feeds.
    expect(normalizeText('Payment ref INV-2026-0042')).toBe('payment ref inv 2026 0042');
  });

  it('strips diacritics so a feed and a CSV of the same day agree', () => {
    expect(normalizeText('Café Münster')).toBe(normalizeText('Cafe Munster'));
  });

  it('treats null and empty alike', () => {
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
  });
});

describe('fingerprintTransaction', () => {
  const base = {
    bankAccountId: 'acct-1',
    transactionDate: d('2026-03-01'),
    amount: D('125.50'),
    reference: 'INV-1',
    description: 'ACME Corp',
  };

  it('is stable across cosmetic differences in the same transaction', () => {
    // doc 06's fallback exists because the same statement re-imported through a
    // different adapter arrives with different punctuation and casing.
    expect(fingerprintTransaction(base)).toBe(
      fingerprintTransaction({ ...base, reference: 'inv 1', description: '  ACME  CORP.  ' }),
    );
  });

  it('separates transactions that differ in amount, date or account', () => {
    const seen = new Set([
      fingerprintTransaction(base),
      fingerprintTransaction({ ...base, amount: D('125.51') }),
      fingerprintTransaction({ ...base, transactionDate: d('2026-03-02') }),
      fingerprintTransaction({ ...base, bankAccountId: 'acct-2' }),
    ]);
    expect(seen.size).toBe(4);
  });

  it('collides for two genuinely distinct identical same-day payments', () => {
    // This is why the database index on fingerprint is NOT unique (F-028). Two
    // £4.20 coffees at the same shop on the same day are one fingerprint and two
    // real transactions; the blueprint's unique index dropped the second.
    expect(fingerprintTransaction(base)).toBe(fingerprintTransaction({ ...base }));
  });
});

describe('classifyIncoming', () => {
  const existing = [
    { id: 'a', providerTransactionId: 'PROV-1', fingerprint: 'fp-1' },
    { id: 'b', providerTransactionId: null, fingerprint: 'fp-2' },
  ];

  it('treats a provider id match as a definite duplicate', () => {
    expect(
      classifyIncoming({ providerTransactionId: 'PROV-1', fingerprint: 'other' }, existing),
    ).toEqual({ kind: 'DUPLICATE', existingId: 'a', by: 'PROVIDER_ID' });
  });

  it('treats a fingerprint-only match as suspected, not definite', () => {
    // The distinction is the whole of doc 06's dedupe rule. A provider id match is
    // the bank saying "same transaction"; a fingerprint match is us guessing.
    expect(
      classifyIncoming({ providerTransactionId: null, fingerprint: 'fp-2' }, existing),
    ).toEqual({ kind: 'SUSPECTED', existingId: 'b', by: 'FINGERPRINT' });
  });

  it('prefers the provider id when both would match different rows', () => {
    expect(
      classifyIncoming({ providerTransactionId: 'PROV-1', fingerprint: 'fp-2' }, existing).by,
    ).toBe('PROVIDER_ID');
  });

  it('admits a new transaction that matches nothing', () => {
    expect(
      classifyIncoming({ providerTransactionId: 'PROV-9', fingerprint: 'fp-9' }, existing),
    ).toEqual({ kind: 'NEW' });
  });

  it('does not match a null provider id against another null one', () => {
    // Two unidentified transactions are not the same transaction because both
    // lack an id. Only the fingerprint may speak for them.
    expect(
      classifyIncoming({ providerTransactionId: null, fingerprint: 'fp-new' }, existing),
    ).toEqual({ kind: 'NEW' });
  });
});

describe('scoreCandidate', () => {
  const txn = {
    amount: D('-1200.00'),
    currency: 'USD',
    date: d('2026-03-10'),
    counterpartyName: 'ACME Corp',
    reference: 'Payment INV-2026-0042 thanks',
  };

  it('scores an exact match at the top and marks it exact', () => {
    const r = scoreCandidate(txn, {
      amount: D('1200.00'),
      currency: 'USD',
      date: d('2026-03-10'),
      counterpartyName: 'ACME Corp',
      reference: 'INV-2026-0042',
    });
    expect(r.exact).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });

  it('matches a payment against a bank debit of the same magnitude', () => {
    // The bank line is -1200 and the bill is 1200. The sign is the direction of
    // the movement, not a disagreement about the amount.
    expect(
      scoreCandidate(txn, {
        amount: D('1200.00'),
        currency: 'USD',
        date: d('2026-03-10'),
        counterpartyName: 'ACME Corp',
        reference: 'INV-2026-0042',
      }).factors.amount,
    ).toBe(1);
  });

  it('refuses to call a near amount exact however well everything else agrees', () => {
    // doc 06 permits auto-matching only for a deterministic exact match. A high
    // score built from a near amount is not one.
    const r = scoreCandidate(txn, {
      amount: D('1200.01'),
      currency: 'USD',
      date: d('2026-03-10'),
      counterpartyName: 'ACME Corp',
      reference: 'INV-2026-0042',
    });
    expect(r.exact).toBe(false);
  });

  it('refuses to call a match exact when the reference is absent from the memo', () => {
    const r = scoreCandidate(
      { ...txn, reference: 'Payment received' },
      {
        amount: D('1200.00'),
        currency: 'USD',
        date: d('2026-03-10'),
        counterpartyName: 'ACME Corp',
        reference: 'INV-2026-0042',
      },
    );
    expect(r.exact).toBe(false);
  });

  it('zeroes the currency factor across currencies and never calls it exact', () => {
    const r = scoreCandidate(txn, {
      amount: D('1200.00'),
      currency: 'EUR',
      date: d('2026-03-10'),
      counterpartyName: 'ACME Corp',
      reference: 'INV-2026-0042',
    });
    expect(r.factors.currency).toBe(0);
    expect(r.exact).toBe(false);
  });

  it('decays with date distance and reaches zero at a fortnight', () => {
    const at = (date: string) =>
      scoreCandidate(txn, {
        amount: D('1200.00'),
        currency: 'USD',
        date: d(date),
        counterpartyName: 'ACME Corp',
        reference: 'INV-2026-0042',
      }).factors.dateProximity;
    expect(at('2026-03-10')).toBe(1);
    expect(at('2026-03-17')).toBeCloseTo(0.5, 5);
    expect(at('2026-03-24')).toBe(0);
    expect(at('2026-04-30')).toBe(0);
  });

  it('decays with amount distance, measured against the larger of the two', () => {
    // Dividing by the larger side is what makes the factor symmetric — see the
    // test below. It also means "10% out" is 10% of the larger amount, so the
    // floor is reached at 1080 below and 1333.33 above, not at 1080 and 1320.
    const at = (amount: string) =>
      scoreCandidate(txn, {
        amount: D(amount),
        currency: 'USD',
        date: d('2026-03-10'),
        counterpartyName: 'ACME Corp',
        reference: 'INV-2026-0042',
      }).factors.amount;
    expect(at('1200.00')).toBe(1);
    expect(at('1260.00')).toBeCloseTo(1 - (60 / 1260) * 10, 4);
    expect(at('1080.00')).toBe(0);
    expect(at('1333.34')).toBe(0);
    expect(at('5000.00')).toBe(0);
  });

  it('is symmetric about which side is larger', () => {
    const high = scoreCandidate(txn, {
      amount: D('1260.00'),
      currency: 'USD',
      date: d('2026-03-10'),
      counterpartyName: 'ACME Corp',
      reference: 'INV-2026-0042',
    }).factors.amount;
    const low = scoreCandidate(
      { ...txn, amount: D('-1260.00') },
      {
        amount: D('1200.00'),
        currency: 'USD',
        date: d('2026-03-10'),
        counterpartyName: 'ACME Corp',
        reference: 'INV-2026-0042',
      },
    ).factors.amount;
    expect(high).toBeCloseTo(low, 6);
  });

  it('scores a candidate that agrees on nothing at zero', () => {
    const r = scoreCandidate(txn, {
      amount: D('7.00'),
      currency: 'EUR',
      date: d('2026-09-30'),
      counterpartyName: 'Someone Else',
      reference: 'XYZ',
    });
    expect(r.score).toBe(0);
  });

  it('keeps its weights summing to one', () => {
    // If they drift, every stored confidence becomes incomparable with the ones
    // recorded before the drift, and the auto-match threshold moves silently.
    const total = Object.values(MATCH_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('never exceeds one', () => {
    const r = scoreCandidate(txn, {
      amount: D('1200.00'),
      currency: 'USD',
      date: d('2026-03-10'),
      counterpartyName: 'ACME Corp',
      reference: 'INV-2026-0042',
      historicallyMatched: true,
    });
    expect(r.score).toBeLessThanOrEqual(1);
  });
});

describe('tokenSimilarity', () => {
  it('is 1 for identical and 0 for disjoint', () => {
    expect(tokenSimilarity('acme corp', 'acme corp')).toBe(1);
    expect(tokenSimilarity('acme corp', 'globex ltd')).toBe(0);
  });

  it('is order-free', () => {
    expect(tokenSimilarity('corp acme', 'acme corp')).toBe(1);
  });

  it('is 0 when either side is empty', () => {
    expect(tokenSimilarity('', 'acme')).toBe(0);
    expect(tokenSimilarity('acme', '')).toBe(0);
  });

  it('scores partial overlap by Jaccard', () => {
    // {acme, corp} vs {acme, ltd} -> 1 shared of 3 distinct
    expect(tokenSimilarity('acme corp', 'acme ltd')).toBeCloseTo(1 / 3, 6);
  });
});

describe('reconcile', () => {
  const empty = { outstandingPayments: [], depositsInTransit: [], unexplainedStatementLines: [] };

  it('reports zero difference when statement and book agree', () => {
    const r = reconcile(
      {
        statementOpeningBalance: D('0'),
        statementClosingBalance: D('5000.00'),
        bookClosingBalance: D('5000.00'),
        ...empty,
      },
      D('0'),
    );
    expect(r.difference.toString()).toBe('0.00000000');
    expect(r.reconciles).toBe(true);
  });

  it('explains a difference entirely made of outstanding cheques', () => {
    // Statement is ahead of the book by the cheques that have not cleared.
    const r = reconcile(
      {
        statementOpeningBalance: D('0'),
        statementClosingBalance: D('5300.00'),
        bookClosingBalance: D('5000.00'),
        outstandingPayments: [D('200.00'), D('100.00')],
        depositsInTransit: [],
        unexplainedStatementLines: [],
      },
      D('0'),
    );
    expect(r.difference.toString()).toBe('300.00000000');
    expect(r.outstandingPaymentsTotal.toString()).toBe('300.00000000');
    // Raw difference is 300, and it is fully explained — but the sign convention
    // matters: outstanding payments make the statement HIGHER than the book.
    expect(r.adjustedDifference.toString()).toBe('600.00000000');
    expect(r.reconciles).toBe(false);
  });

  it('works a real session down to zero', () => {
    // Book 5000. Statement 4800 because a 300 cheque has not cleared and a 100
    // deposit is in transit: 5000 - 300 + 100 = 4800.
    const r = reconcile(
      {
        statementOpeningBalance: D('0'),
        statementClosingBalance: D('4800.00'),
        bookClosingBalance: D('5000.00'),
        outstandingPayments: [D('300.00')],
        depositsInTransit: [D('100.00')],
        unexplainedStatementLines: [],
      },
      D('0'),
    );
    expect(r.difference.toString()).toBe('-200.00000000');
    expect(r.adjustedDifference.toString()).toBe('0.00000000');
    expect(r.reconciles).toBe(true);
  });

  it('honours a configured tolerance without pretending the difference is zero', () => {
    const input = {
      statementOpeningBalance: D('0'),
      statementClosingBalance: D('5000.02'),
      bookClosingBalance: D('5000.00'),
      ...empty,
    };
    expect(reconcile(input, D('0.05')).reconciles).toBe(true);
    expect(reconcile(input, D('0.01')).reconciles).toBe(false);
    // Either way it still reports the real number rather than rounding it away.
    expect(reconcile(input, D('0.05')).difference.toString()).toBe('0.02000000');
  });

  it('keeps exact decimals through the whole computation', () => {
    // ADR-0006 §1. Three thirds of a cent must not become 0.009999999.
    const r = reconcile(
      {
        statementOpeningBalance: D('0'),
        statementClosingBalance: D('0.30'),
        bookClosingBalance: D('0'),
        outstandingPayments: [D('0.10'), D('0.10'), D('0.10')],
        depositsInTransit: [],
        unexplainedStatementLines: [],
      },
      D('0'),
    );
    expect(r.outstandingPaymentsTotal.toString()).toBe('0.30000000');
  });
});

describe('decomposeSettlement', () => {
  it("accepts doc 06's worked example", () => {
    // Customer pays 100, processor settles 97, fee 3.
    const r = decomposeSettlement({ gross: D('100.00'), fee: D('3.00'), net: D('97.00') });
    expect(r.net.toString()).toBe('97.00000000');
    expect(r.adjustment.toString()).toBe('0.00000000');
  });

  it('carries an adjustment, so net is not simply gross less fee', () => {
    const r = decomposeSettlement({
      gross: D('100.00'),
      fee: D('3.00'),
      adjustment: D('-10.00'),
      net: D('87.00'),
    });
    expect(r.net.toString()).toBe('87.00000000');
  });

  it('refuses a batch that does not add up, before the database does', () => {
    expect(() =>
      decomposeSettlement({ gross: D('100.00'), fee: D('3.00'), net: D('98.00') }),
    ).toThrow(/SETTLEMENT_DOES_NOT_DECOMPOSE/);
  });

  it('names both sides of the arithmetic in the error', () => {
    // A constraint violation says which constraint. This says which number.
    expect(() =>
      decomposeSettlement({ gross: D('100.00'), fee: D('3.00'), net: D('98.00') }),
    ).toThrow(/98\.00000000.*100\.00000000.*3\.00000000.*97\.00000000/s);
  });
});
