import { describe, expect, it } from 'vitest';
import { D, MONEY_SCALE, type Decimal } from '@acct/domain';
import {
  ACCOUNT_CODE_PATTERN,
  codeInRange,
  compareCodes,
  evaluateFormula,
  formulaReferences,
  parseFormula,
  validateReportColumns,
  validateReportDefinition,
  type ReportDefinitionSpec,
  type ReportRowSpec,
} from './semantic-model';

/**
 * The safe semantic model, both halves.
 *
 * Every refusal below has an ACCEPT beside it. A model that refuses everything is
 * indistinguishable from one that refuses the right things, and it is the one a
 * definition author disables. So: for every "this is rejected" there is a "and
 * this, which is legitimate, is accepted and produces the right number".
 */

const money = (v: string): Decimal => D(v, MONEY_SCALE);

const row = (over: Partial<ReportRowSpec> & Pick<ReportRowSpec, 'rowNo'>): ReportRowSpec => ({
  label: `Row ${over.rowNo}`,
  rowType: 'ACCOUNT_RANGE',
  accountFrom: '4000',
  accountTo: '4999',
  ...over,
});

const definition = (rows: ReportRowSpec[]): ReportDefinitionSpec => ({
  organizationId: '00000000-0000-0000-0000-000000000001',
  legalEntityId: null,
  code: 'PNL',
  name: 'Profit and loss',
  reportType: 'PROFIT_LOSS',
  rows,
});

describe('the formula grammar', () => {
  it('parses the arithmetic a report row legitimately needs', () => {
    const tree = parseFormula('R10 - R20 + (R30 * 2) / 4', 99);
    expect(formulaReferences(tree)).toEqual([10, 20, 30]);
    const value = evaluateFormula(
      tree,
      (ref) => ({ 10: money('1000'), 20: money('400'), 30: money('50') })[ref] ?? null,
    );
    // 1000 - 400 + (50 * 2) / 4 = 625
    expect(value?.toString()).toBe(money('625').toString());
  });

  it('evaluates a unary minus and a bare literal', () => {
    expect(evaluateFormula(parseFormula('-R1', 1), () => money('12.34'))?.toString()).toBe(
      money('-12.34').toString(),
    );
    expect(evaluateFormula(parseFormula('7.5', 1), () => null)?.toString()).toBe(
      money('7.5').toString(),
    );
  });

  it('divides exactly, at the money scale, without a float anywhere', () => {
    const value = evaluateFormula(parseFormula('R1 / R2', 1), (ref) =>
      ref === 1 ? money('1') : money('3'),
    );
    // 1/3 at scale 8, HALF_UP. A float would give 0.3333333333333333.
    expect(value?.toString()).toBe('0.33333333');
  });

  it('answers "no answer" rather than zero when a denominator is zero', () => {
    const value = evaluateFormula(parseFormula('R1 / R2', 1), (ref) =>
      ref === 1 ? money('500') : money('0'),
    );
    expect(value).toBeNull();
  });

  it('propagates a null through the rest of the expression', () => {
    const value = evaluateFormula(parseFormula('R1 + R2', 1), (ref) =>
      ref === 1 ? money('500') : null,
    );
    expect(value).toBeNull();
  });

  for (const attempt of [
    'R1; DROP TABLE journal_lines',
    'R1 UNION SELECT 1',
    '(SELECT sum(base_debit) FROM journal_lines)',
    'pg_read_file(1)',
    'R1 || R2',
    "R1 + 'x'",
    'accounts.code',
    'R1 -- comment',
    'R1 /* c */ + R2',
  ]) {
    it(`refuses ${JSON.stringify(attempt)} as a formula`, () => {
      expect(() => parseFormula(attempt, 10)).toThrowError(/REPORT_FORMULA_SYNTAX/);
    });
  }

  it('refuses an R with no row number, and accepts one with a number', () => {
    expect(() => parseFormula('R + 1', 10)).toThrowError(/REPORT_FORMULA_SYNTAX/);
    expect(formulaReferences(parseFormula('R0 + 1', 10))).toEqual([0]);
  });

  it('refuses an unclosed parenthesis and trailing input', () => {
    expect(() => parseFormula('(R1 + R2', 10)).toThrowError(/never closed/);
    expect(() => parseFormula('R1 R2', 10)).toThrowError(/unexpected input/);
  });

  it('refuses a formula longer than the limit', () => {
    expect(() => parseFormula('R1+'.repeat(200) + 'R1', 10)).toThrowError(/character limit/);
  });
});

describe('account codes and ranges', () => {
  it('admits real codes and refuses anything that could be an expression', () => {
    for (const good of ['1000', '4000.10', 'REV-01', 'A_1']) {
      expect(ACCOUNT_CODE_PATTERN.test(good)).toBe(true);
    }
    for (const bad of ["1000'", '1000;', '1000 OR 1=1', '1000%', '', ' 1000', '1000)']) {
      expect(ACCOUNT_CODE_PATTERN.test(bad)).toBe(false);
    }
  });

  it('compares all-numeric codes numerically, so a five-digit code is not inside a four-digit range', () => {
    // The failure this prevents: lexicographically '10000' < '1999', so a
    // 10000-series account would fall inside a 1000..1999 current-asset range.
    expect('10000' < '1999').toBe(true);
    expect(compareCodes('10000', '1999')).toBe(1);
    expect(codeInRange('10000', '1000', '1999')).toBe(false);
    expect(codeInRange('1500', '1000', '1999')).toBe(true);
  });

  it('compares mixed codes lexicographically', () => {
    expect(compareCodes('REV-01', 'REV-02')).toBe(-1);
    expect(codeInRange('REV-01', 'REV-00', 'REV-99')).toBe(true);
  });

  it('treats an open bound as open on that side only', () => {
    expect(codeInRange('9999', '4000', null)).toBe(true);
    expect(codeInRange('3999', '4000', null)).toBe(false);
    expect(codeInRange('1', null, null)).toBe(false);
  });
});

describe('definition validation', () => {
  it('accepts a definition that uses every legitimate row type', () => {
    const validated = validateReportDefinition(
      definition([
        row({ rowNo: 10, rowType: 'HEADER', accountFrom: null, accountTo: null }),
        row({ rowNo: 20, accountFrom: '4000', accountTo: '4999' }),
        row({ rowNo: 30, accountFrom: '5000', accountTo: '5999' }),
        row({
          rowNo: 40,
          rowType: 'SUBTOTAL',
          accountFrom: null,
          accountTo: null,
          formula: 'R20 - R30',
        }),
        row({
          rowNo: 50,
          rowType: 'FORMULA',
          accountFrom: null,
          accountTo: null,
          formula: 'R40 / R20',
        }),
      ]),
    );
    expect(validated.rows).toHaveLength(5);
    // Dependencies before dependants: R20 and R30 precede R40, which precedes R50.
    const order = validated.evaluationOrder;
    expect(order.indexOf(20)).toBeLessThan(order.indexOf(40));
    expect(order.indexOf(40)).toBeLessThan(order.indexOf(50));
  });

  it('refuses a range whose bounds are inverted, and accepts the same bounds the right way round', () => {
    expect(() =>
      validateReportDefinition(
        definition([row({ rowNo: 10, accountFrom: '4999', accountTo: '4000' })]),
      ),
    ).toThrowError(/REPORT_ROW_RANGE_INVERTED/);
    expect(
      validateReportDefinition(
        definition([row({ rowNo: 10, accountFrom: '4000', accountTo: '4999' })]),
      ).rows,
    ).toHaveLength(1);
  });

  it('refuses a row that selects nothing at all', () => {
    expect(() =>
      validateReportDefinition(
        definition([row({ rowNo: 10, accountFrom: null, accountTo: null })]),
      ),
    ).toThrowError(/REPORT_ROW_SELECTOR_MISSING/);
  });

  it('refuses two selectors on one row', () => {
    expect(() =>
      validateReportDefinition(
        definition([row({ rowNo: 10, accountGroupId: '00000000-0000-0000-0000-000000000002' })]),
      ),
    ).toThrowError(/REPORT_ROW_SELECTOR_MISSING/);
  });

  it('refuses a duplicate row_no', () => {
    expect(() =>
      validateReportDefinition(definition([row({ rowNo: 10 }), row({ rowNo: 10 })])),
    ).toThrowError(/REPORT_ROW_DUPLICATE/);
  });

  it('refuses a formula that references a row the definition does not declare', () => {
    expect(() =>
      validateReportDefinition(
        definition([
          row({ rowNo: 10 }),
          row({
            rowNo: 20,
            rowType: 'SUBTOTAL',
            accountFrom: null,
            accountTo: null,
            formula: 'R10 + R99',
          }),
        ]),
      ),
    ).toThrowError(/REPORT_FORMULA_UNKNOWN_ROW/);
  });

  it('refuses a self-reference', () => {
    expect(() =>
      validateReportDefinition(
        definition([
          row({
            rowNo: 20,
            rowType: 'SUBTOTAL',
            accountFrom: null,
            accountTo: null,
            formula: 'R20 + 1',
          }),
        ]),
      ),
    ).toThrowError(/REPORT_FORMULA_SELF_REFERENCE/);
  });

  it('refuses a cycle across three rows and names it', () => {
    expect(() =>
      validateReportDefinition(
        definition([
          row({
            rowNo: 10,
            rowType: 'SUBTOTAL',
            accountFrom: null,
            accountTo: null,
            formula: 'R20',
          }),
          row({
            rowNo: 20,
            rowType: 'SUBTOTAL',
            accountFrom: null,
            accountTo: null,
            formula: 'R30',
          }),
          row({
            rowNo: 30,
            rowType: 'SUBTOTAL',
            accountFrom: null,
            accountTo: null,
            formula: 'R10',
          }),
        ]),
      ),
    ).toThrowError(/REPORT_FORMULA_CYCLE/);
  });

  it('accepts a long chain that is not a cycle', () => {
    const rows: ReportRowSpec[] = [row({ rowNo: 0, accountFrom: '4000', accountTo: '4999' })];
    for (let i = 1; i < 400; i++) {
      rows.push(
        row({
          rowNo: i,
          rowType: 'SUBTOTAL',
          accountFrom: null,
          accountTo: null,
          formula: `R${i - 1} + 1`,
        }),
      );
    }
    expect(validateReportDefinition(definition(rows)).evaluationOrder).toHaveLength(400);
  });

  it('refuses a formula that references a HEADER row, because a header has no amount', () => {
    expect(() =>
      validateReportDefinition(
        definition([
          row({ rowNo: 10, rowType: 'HEADER', accountFrom: null, accountTo: null }),
          row({
            rowNo: 20,
            rowType: 'SUBTOTAL',
            accountFrom: null,
            accountTo: null,
            formula: 'R10',
          }),
        ]),
      ),
    ).toThrowError(/REPORT_FORMULA_REFERENCES_PRESENTATION_ROW/);
  });

  it('refuses an account code that is not an account code', () => {
    expect(() =>
      validateReportDefinition(
        definition([row({ rowNo: 10, accountFrom: "4000' OR '1'='1", accountTo: '4999' })]),
      ),
    ).toThrowError(/REPORT_ACCOUNT_CODE_INVALID/);
  });

  it('refuses a definition with no rows', () => {
    expect(() => validateReportDefinition(definition([]))).toThrowError(
      /REPORT_DEFINITION_NO_ROWS/,
    );
  });

  it('requires a cash flow method on a cash flow definition, and refuses one anywhere else', () => {
    const cash = {
      ...definition([row({ rowNo: 10 })]),
      reportType: 'CASH_FLOW' as const,
    };
    expect(() => validateReportDefinition(cash)).toThrowError(/cash_flow_method/);
    expect(validateReportDefinition({ ...cash, cashFlowMethod: 'DIRECT' }).rows).toHaveLength(1);
    expect(() =>
      validateReportDefinition({ ...definition([row({ rowNo: 10 })]), cashFlowMethod: 'DIRECT' }),
    ).toThrowError(/only meaningful on a CASH_FLOW definition/);
  });

  it('refuses an unknown report type and an unknown row type', () => {
    expect(() =>
      validateReportDefinition({
        ...definition([row({ rowNo: 10 })]),
        reportType: 'SQL' as never,
      }),
    ).toThrowError(/REPORT_TYPE_UNKNOWN/);
    expect(() =>
      validateReportDefinition(definition([row({ rowNo: 10, rowType: 'RAW_SQL' as never })])),
    ).toThrowError(/REPORT_ROW_TYPE_UNKNOWN/);
  });
});

describe('column validation', () => {
  it('accepts the declared column types and refuses anything else', () => {
    validateReportColumns([
      { columnNo: 1, label: 'This period', columnType: 'PERIOD' },
      { columnNo: 2, label: 'Year to date', columnType: 'YTD' },
      { columnNo: 3, label: 'Margin', columnType: 'FORMULA', formula: 'R10 / R20' },
    ]);
    expect(() =>
      validateReportColumns([{ columnNo: 1, label: 'x', columnType: 'RAW' as never }]),
    ).toThrowError(/REPORT_COLUMN_TYPE_UNKNOWN/);
    expect(() =>
      validateReportColumns([
        { columnNo: 1, label: 'x', columnType: 'FORMULA', formula: 'sum(base_debit)' },
      ]),
    ).toThrowError(/REPORT_FORMULA_SYNTAX/);
  });
});
