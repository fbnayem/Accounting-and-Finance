import { describe, it, expect } from 'vitest';
import { AppError } from './errors';
import {
  parsePostingRule,
  evaluatePostingRule,
  type AccountingEvent,
  type RuleResolutionContext,
} from './posting-rules';

/**
 * The fixtures are the catalog's own rules, transcribed.
 *
 * `project plan/posting_rule_catalog.md` is prose; if the language here cannot
 * express what the prose says, the language is wrong. Testing against invented
 * rules would prove only that the interpreter is self-consistent.
 */
const SALES_INVOICE_POSTED = parsePostingRule({
  event_type: 'SALES_INVOICE_POSTED',
  description: 'Dr AR gross; Cr Revenue per line; Cr Output Tax per component.',
  lines: [
    {
      role: 'Accounts receivable',
      account: { policy: 'ar_control_account_id' },
      side: 'DEBIT',
      amount: { event: 'gross' },
    },
    {
      role: 'Revenue',
      account: { event: 'revenue_account_id' },
      side: 'CREDIT',
      amount: { event: 'net' },
      forEach: 'lines',
      dimensions: 'dimensions',
    },
    {
      role: 'Output tax',
      account: { event: 'tax_account_id' },
      side: 'CREDIT',
      amount: { event: 'amount' },
      forEach: 'tax_components',
    },
  ],
});

const ASSET_DISPOSAL = parsePostingRule({
  event_type: 'ASSET_DISPOSAL',
  description: 'Dr proceeds and accumulated depreciation, Cr cost, balance to gain/loss.',
  lines: [
    {
      role: 'Proceeds',
      account: { policy: 'cash_clearing_account_id' },
      side: 'DEBIT',
      amount: { event: 'proceeds' },
    },
    {
      role: 'Accumulated depreciation',
      account: { event: 'accumulated_depreciation_account_id' },
      side: 'DEBIT',
      amount: { event: 'accumulated_depreciation' },
    },
    {
      role: 'Asset cost',
      account: { event: 'cost_account_id' },
      side: 'CREDIT',
      amount: { event: 'cost' },
    },
    {
      role: 'Gain or loss on disposal',
      account: { code: '7100' },
      side: 'DEBIT',
      amount: { balancing: true },
    },
  ],
});

const context: RuleResolutionContext = {
  policyAccounts: {
    ar_control_account_id: 'acct-ar',
    cash_clearing_account_id: 'acct-cash',
    ap_control_account_id: null,
  },
  accountsByCode: new Map([['7100', 'acct-gain-loss']]),
  baseCurrency: 'USD',
};

const event = (eventType: string, payload: Record<string, unknown>): AccountingEvent => ({
  eventType,
  legalEntityId: 'entity-1',
  accountingBookId: 'book-1',
  postingDate: '2026-03-31',
  sourceType: 'invoice',
  sourceId: 'src-1',
  sourceEventId: 'evt-1',
  payload,
});

describe('parsePostingRule', () => {
  it('accepts the catalog rules', () => {
    expect(SALES_INVOICE_POSTED.lines).toHaveLength(3);
    expect(ASSET_DISPOSAL.lines).toHaveLength(4);
  });

  it('rejects a rule with two balancing lines, because the split would be arbitrary', () => {
    expect(() =>
      parsePostingRule({
        event_type: 'X_Y',
        lines: [
          { role: 'a', account: { code: '1' }, side: 'DEBIT', amount: { balancing: true } },
          { role: 'b', account: { code: '2' }, side: 'CREDIT', amount: { balancing: true } },
        ],
      }),
    ).toThrow(/Only one line can absorb the residual/);
  });

  it('rejects an account source with two keys', () => {
    expect(() =>
      parsePostingRule({
        event_type: 'X_Y',
        lines: [
          { role: 'a', account: { code: '1', policy: 'p' }, side: 'DEBIT', amount: { const: '1' } },
        ],
      }),
    ).toThrow(/exactly one of: policy, event, code/);
  });

  it('reports every problem in one response', () => {
    try {
      parsePostingRule({
        event_type: 'lower_case',
        lines: [{ role: '', account: {}, side: 'SIDEWAYS', amount: {} }],
      });
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).fieldErrors.length).toBeGreaterThanOrEqual(4);
    }
  });
});

describe('evaluatePostingRule', () => {
  it('expands forEach over invoice lines and tax components', () => {
    const lines = evaluatePostingRule(
      SALES_INVOICE_POSTED,
      event('SALES_INVOICE_POSTED', {
        currency: 'USD',
        gross: '115.00',
        lines: [
          { net: '60.00', revenue_account_id: 'acct-rev-goods', dimensions: { 'dim-1': 'val-a' } },
          { net: '40.00', revenue_account_id: 'acct-rev-services' },
        ],
        tax_components: [
          { amount: '10.00', tax_account_id: 'acct-tax-standard' },
          { amount: '5.00', tax_account_id: 'acct-tax-reduced' },
        ],
      }),
      context,
    );

    expect(lines).toHaveLength(5);
    expect(lines[0]).toMatchObject({ accountId: 'acct-ar', debit: '115.00000000' });
    expect(lines[1]).toMatchObject({ accountId: 'acct-rev-goods', credit: '60.00000000' });
    expect(lines[1]?.dimensions).toEqual({ 'dim-1': 'val-a' });
    expect(lines[4]).toMatchObject({ accountId: 'acct-tax-reduced', credit: '5.00000000' });

    const debit = lines.reduce((a, l) => a + Number(l.debit ?? 0), 0);
    const credit = lines.reduce((a, l) => a + Number(l.credit ?? 0), 0);
    expect(debit).toBeCloseTo(credit);
  });

  it('resolves a balancing line to a loss when the residual runs the other way', () => {
    // Cost 1000, accumulated depreciation 600, proceeds 300 -> carrying 400, loss 100.
    const lines = evaluatePostingRule(
      ASSET_DISPOSAL,
      event('ASSET_DISPOSAL', {
        currency: 'USD',
        proceeds: '300.00',
        accumulated_depreciation: '600.00',
        accumulated_depreciation_account_id: 'acct-accum',
        cost: '1000.00',
        cost_account_id: 'acct-cost',
      }),
      context,
    );
    const balancing = lines.find((l) => l.accountId === 'acct-gain-loss');
    expect(balancing?.debit).toBe('100.00000000');
    expect(balancing?.credit).toBe('0');
  });

  it('resolves the same balancing line to a gain when proceeds exceed carrying amount', () => {
    const lines = evaluatePostingRule(
      ASSET_DISPOSAL,
      event('ASSET_DISPOSAL', {
        currency: 'USD',
        proceeds: '500.00',
        accumulated_depreciation: '600.00',
        accumulated_depreciation_account_id: 'acct-accum',
        cost: '1000.00',
        cost_account_id: 'acct-cost',
      }),
      context,
    );
    const balancing = lines.find((l) => l.accountId === 'acct-gain-loss');
    expect(balancing?.credit).toBe('100.00000000');
  });

  it('drops the balancing line entirely when the residual is zero', () => {
    const lines = evaluatePostingRule(
      ASSET_DISPOSAL,
      event('ASSET_DISPOSAL', {
        currency: 'USD',
        proceeds: '400.00',
        accumulated_depreciation: '600.00',
        accumulated_depreciation_account_id: 'acct-accum',
        cost: '1000.00',
        cost_account_id: 'acct-cost',
      }),
      context,
    );
    expect(lines.some((l) => l.accountId === 'acct-gain-loss')).toBe(false);
    expect(lines).toHaveLength(3);
  });

  it('is deterministic — the same event and rule produce identical lines', () => {
    const payload = {
      currency: 'USD',
      gross: '115.00',
      lines: [{ net: '100.00', revenue_account_id: 'acct-rev' }],
      tax_components: [{ amount: '15.00', tax_account_id: 'acct-tax' }],
    };
    const a = evaluatePostingRule(
      SALES_INVOICE_POSTED,
      event('SALES_INVOICE_POSTED', payload),
      context,
    );
    const b = evaluatePostingRule(
      SALES_INVOICE_POSTED,
      event('SALES_INVOICE_POSTED', payload),
      context,
    );
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('names the unset policy mapping rather than failing obscurely (F-203)', () => {
    const rule = parsePostingRule({
      event_type: 'VENDOR_BILL_POSTED',
      lines: [
        {
          role: 'AP',
          account: { policy: 'ap_control_account_id' },
          side: 'CREDIT',
          amount: { event: 'gross' },
        },
      ],
    });
    expect(() =>
      evaluatePostingRule(rule, event('VENDOR_BILL_POSTED', { gross: '10.00' }), context),
    ).toThrow(/ap_control_account_id, which is not configured/);
  });

  it('refuses a money value that arrived as a JSON number', () => {
    const rule = parsePostingRule({
      event_type: 'BANK_FEE',
      lines: [
        { role: 'Fee', account: { code: '7100' }, side: 'DEBIT', amount: { event: 'amount' } },
      ],
    });
    expect(() =>
      // 0.1 + 0.2 in binary floating point is where this ends; the event contract
      // carries money as a decimal string precisely so it cannot.
      evaluatePostingRule(rule, event('BANK_FEE', { amount: 12.34 }), context),
    ).toThrow(/decimal string on the wire/);
  });

  it('refuses to evaluate a rule against the wrong event type', () => {
    expect(() => evaluatePostingRule(SALES_INVOICE_POSTED, event('BANK_FEE', {}), context)).toThrow(
      /Rule version is for SALES_INVOICE_POSTED but the event is BANK_FEE/,
    );
  });

  it('applies a factor without rounding at an undeclared boundary', () => {
    const rule = parsePostingRule({
      event_type: 'PARTIAL_ACCRUAL',
      lines: [
        {
          role: 'Expense',
          account: { code: '7100' },
          side: 'DEBIT',
          amount: { event: 'total', factor: '0.25' },
        },
        {
          role: 'Accrual',
          account: { code: '7100' },
          side: 'CREDIT',
          amount: { event: 'total', factor: '0.75' },
        },
      ],
    });
    const lines = evaluatePostingRule(rule, event('PARTIAL_ACCRUAL', { total: '100.00' }), context);
    expect(lines[0]?.debit).toBe('25.00000000');
    expect(lines[1]?.credit).toBe('75.00000000');
  });
});
