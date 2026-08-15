import { describe, expect, it } from 'vitest';
import { AppError } from '@acct/domain';
import {
  matchesConditions,
  parseConditions,
  parseStoredConditions,
  serializeConditions,
  type ConditionFacts,
} from './conditions';

const facts = (overrides: Partial<ConditionFacts> = {}): ConditionFacts => ({
  amount: '5000.00',
  currency: 'USD',
  legalEntityId: 'entity-1',
  branchId: null,
  accountIds: ['account-1'],
  counterpartyId: 'vendor-1',
  departmentId: null,
  projectId: null,
  sourceType: 'VENDOR_BILL',
  riskFlags: [],
  exceptionStates: [],
  ...overrides,
});

describe('monetary conditions stay exact', () => {
  /**
   * The defect this whole file exists for, demonstrated rather than asserted.
   *
   * `pnpm dod:check` cannot see it: its money rule looks for `Number(...)` or
   * `parseFloat(...)` around a word-bounded name, and there is no conversion in
   * the code and no word boundary in `min_amount`. The rounding happens inside
   * `JSON.parse`, which is how a jsonb column reaches JavaScript.
   */
  it('a JSON number in a condition has already lost the value before anything reads it', () => {
    const asStored = '{"min_amount": 9007199254740993.01}';
    const naive = JSON.parse(asStored) as { min_amount: number };
    expect(String(naive.min_amount)).not.toBe('9007199254740993.01');
  });

  it('refuses to store a monetary bound as a JSON number', () => {
    expect(() => parseConditions({ min_amount: 10000.55 })).toThrowError(AppError);
    try {
      parseConditions({ min_amount: 10000.55 });
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION_FAILED');
      expect((error as AppError).message).toContain('decimal strings');
      // AppError.details is log-only, so the remedy has to be in the message.
      expect((error as AppError).message).toContain('ADR-0006');
    }
  });

  it('keeps a value a double cannot hold, exactly, through a full round trip', () => {
    const exact = '9007199254740993.01';
    const parsed = parseConditions({ min_amount: exact });
    const stored = serializeConditions(parsed);
    expect(stored['min_amount']).toBe(exact);

    // The read path: the monetary keys arrive as the TEXT PostgreSQL produced
    // from `conditions ->> 'min_amount'`, never through JSON.parse.
    const readBack = parseStoredConditions(
      { currencies: ['USD'] },
      { minAmount: exact, maxAmount: null },
    );
    expect(readBack.minAmount).toBe(exact);
  });

  it('discards a number that reached the parser instead of stringifying it', () => {
    // A row written by hand with a JSON number: `->>` still yields exact text,
    // and the jsonb object's rounded number is thrown away rather than used.
    // Built through JSON.parse rather than written as a literal, because a
    // literal that loses precision is an eslint error — which is the one place
    // in this repository where that class of defect IS visible statically.
    const roundedByTheParser = JSON.parse('{"min_amount": 9007199254740993.01}') as object;
    const readBack = parseStoredConditions(roundedByTheParser, {
      minAmount: '9007199254740993.01',
      maxAmount: null,
    });
    expect(readBack.minAmount).toBe('9007199254740993.01');
  });

  it('preserves the scale as written rather than renormalising it', () => {
    expect(parseConditions({ min_amount: '10000.00' }).minAmount).toBe('10000.00');
  });

  it('rejects exponent notation, which is not an exact decimal literal', () => {
    expect(() => parseConditions({ min_amount: '1e4' })).toThrowError(/not an exact decimal/);
  });
});

describe('amount boundaries', () => {
  const band = parseConditions({ min_amount: '10000.00', max_amount: '50000.00' });

  it('includes the minimum exactly', () => {
    expect(matchesConditions(band, facts({ amount: '10000.00' })).matched).toBe(true);
  });

  it('excludes one hundredth below the minimum', () => {
    expect(matchesConditions(band, facts({ amount: '9999.99' })).matched).toBe(false);
  });

  it('excludes the maximum exactly, so adjacent bands tile', () => {
    expect(matchesConditions(band, facts({ amount: '50000.00' })).matched).toBe(false);
  });

  it('includes one hundredth below the maximum', () => {
    expect(matchesConditions(band, facts({ amount: '49999.99' })).matched).toBe(true);
  });

  it('compares at a precision no double could', () => {
    const fine = parseConditions({ min_amount: '9007199254740993.01' });
    expect(matchesConditions(fine, facts({ amount: '9007199254740993.00' })).matched).toBe(false);
    expect(matchesConditions(fine, facts({ amount: '9007199254740993.01' })).matched).toBe(true);
  });

  it('refuses a band no amount can satisfy', () => {
    expect(() => parseConditions({ min_amount: '100', max_amount: '100' })).toThrowError(
      /not above min_amount/,
    );
  });
});

describe('non-monetary conditions', () => {
  it('an omitted condition constrains nothing', () => {
    expect(matchesConditions(parseConditions({}), facts()).matched).toBe(true);
  });

  it('matches on any account the document touches', () => {
    const c = parseConditions({ account_ids: ['account-9', 'account-1'] });
    expect(matchesConditions(c, facts()).matched).toBe(true);
    expect(matchesConditions(c, facts({ accountIds: ['account-7'] })).matched).toBe(false);
  });

  it('matches counterparty, currency, source type and risk flags', () => {
    const c = parseConditions({
      currencies: ['USD'],
      counterparty_ids: ['vendor-1'],
      source_types: ['VENDOR_BILL'],
      risk_flags: ['SANCTIONS'],
    });
    expect(matchesConditions(c, facts({ riskFlags: ['SANCTIONS'] })).matched).toBe(true);
    expect(matchesConditions(c, facts({ riskFlags: [] })).matched).toBe(false);
    expect(matchesConditions(c, facts({ currency: 'GBP', riskFlags: ['SANCTIONS'] })).matched).toBe(
      false,
    );
  });

  it('a null fact never satisfies a stated list', () => {
    const c = parseConditions({ project_ids: ['project-1'] });
    expect(matchesConditions(c, facts({ projectId: null })).matched).toBe(false);
  });

  it('names every failed condition, so a workflow that never fires can be explained', () => {
    const c = parseConditions({ min_amount: '10000.00', currencies: ['GBP'] });
    const result = matchesConditions(c, facts({ amount: '10.00', currency: 'USD' }));
    expect(result.matched).toBe(false);
    expect(result.failed).toHaveLength(2);
  });
});

describe('conditions that would silently match everything', () => {
  it('refuses an unknown key rather than ignoring it', () => {
    expect(() => parseConditions({ min_ammount: '10000' })).toThrowError(/Unknown workflow/);
  });

  it('refuses an empty list, which nothing can satisfy', () => {
    expect(() => parseConditions({ currencies: [] })).toThrowError(/no document can satisfy/);
  });
});
