/**
 * The safe financial semantic model — doc 21 Phase 6: "custom report definitions
 * with safe financial semantic model".
 *
 * A report definition is caller-supplied. Everything in this file exists because
 * that sentence, taken seriously, means a definition must not be able to become a
 * way to run arbitrary SQL, to read another tenant's data, or to step outside
 * row-level security. So the model is stated here as a closed vocabulary, and the
 * boundary is stated as a list of things it refuses rather than as a hope.
 *
 * ---------------------------------------------------------------------------
 * THE SAFETY BOUNDARY, in full
 * ---------------------------------------------------------------------------
 *
 * 1. **No caller string ever reaches the database as SQL.** A definition supplies
 *    labels, account codes, uuids, integers and formulas. Labels and codes are
 *    bound parameters. Formulas are parsed HERE, by `parseFormula`, into an AST
 *    over a closed grammar, and evaluated HERE in `Decimal` arithmetic. The
 *    formula text is stored so a reader can see it; it is never concatenated into
 *    a statement, never `EXECUTE`d, and never reaches Postgres as anything but a
 *    text value.
 *
 * 2. **The grammar names nothing but other rows of the same definition.** The only
 *    identifier it admits is `R<row_no>`. There is no column name, no table name,
 *    no function call, no string literal and no comparison operator in the
 *    grammar, so there is nothing for an injection to be injected INTO. A
 *    definition cannot express "select", "from", "union", "pg_", or a semicolon,
 *    because none of those are tokens.
 *
 * 3. **The only entities a definition may name are accounts and account groups**,
 *    and it names them by id or by code. Both are resolved against the
 *    definition's own scope at write time (`report_definitions.legal_entity_id`
 *    when set, otherwise any entity of its organization) and the database repeats
 *    the check in `assert_statement_mapping_in_scope` (0053) — the application's
 *    check gives the caller an actionable message, the trigger makes it true.
 *
 * 4. **A definition never chooses a table, a join, a filter, an ordering or a
 *    period.** Those come from the request and from `report_period_window`
 *    (0053). A definition selects WHICH ACCOUNTS ROLL UP TO WHICH LINE, and the
 *    arithmetic that combines lines. That is the whole of its power.
 *
 * 5. **Reads run under RLS with `app.tenant_id` set**, through `readInTenant`, and
 *    every write carries the principal's `tenant_id`. A definition belonging to
 *    another tenant is not "filtered out" by this code; it is invisible to the
 *    transaction.
 *
 * 6. **A row that cannot receive an account is refused, not rendered empty.** An
 *    ACCOUNT_RANGE whose bounds are inverted, an ACCOUNT_GROUP naming a group
 *    outside scope, a FORMULA referencing a row that does not exist — each is a
 *    registered intention that would never execute, and each silently shrinks the
 *    statement by exactly what its author believed it covered.
 *
 * What it therefore refuses, by name:
 *   REPORT_ROW_TYPE_UNKNOWN, REPORT_ROW_SELECTOR_MISSING, REPORT_ROW_RANGE_INVERTED,
 *   REPORT_ROW_DUPLICATE, REPORT_ACCOUNT_CODE_INVALID, REPORT_FORMULA_SYNTAX,
 *   REPORT_FORMULA_UNKNOWN_ROW, REPORT_FORMULA_SELF_REFERENCE, REPORT_FORMULA_CYCLE,
 *   REPORT_FORMULA_REFERENCES_PRESENTATION_ROW, REPORT_DEFINITION_NO_ROWS,
 *   REPORT_COLUMN_TYPE_UNKNOWN, REPORT_TYPE_UNKNOWN.
 *
 * All of them are `VALIDATION_FAILED` with the reason in the MESSAGE, because
 * `AppError.details` is log-only and a caller who must fix a definition has to be
 * told which row and why.
 */

import { AppError, D, Decimal, MONEY_SCALE } from '@acct/domain';

// ---------------------------------------------------------------------------
// The closed vocabulary. Each mirrors a CHECK constraint in 0016/0053 exactly.
// ---------------------------------------------------------------------------

/** `report_definitions.report_type` */
export const REPORT_TYPES = [
  'PROFIT_LOSS',
  'BALANCE_SHEET',
  'CASH_FLOW',
  'TRIAL_BALANCE',
  'CUSTOM',
] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** `report_rows.row_type` */
export const REPORT_ROW_TYPES = [
  'ACCOUNT_RANGE',
  'ACCOUNT_GROUP',
  'FORMULA',
  'SUBTOTAL',
  'HEADER',
  'SPACER',
] as const;
export type ReportRowType = (typeof REPORT_ROW_TYPES)[number];

/** Rows that carry accounts. Everything else is presentation or arithmetic. */
export const ACCOUNT_BEARING_ROW_TYPES: ReadonlySet<ReportRowType> = new Set([
  'ACCOUNT_RANGE',
  'ACCOUNT_GROUP',
]);
/** Rows whose amount is computed from other rows. */
export const COMPUTED_ROW_TYPES: ReadonlySet<ReportRowType> = new Set(['FORMULA', 'SUBTOTAL']);
/** Rows that have no amount at all and may never be referenced by a formula. */
export const PRESENTATION_ROW_TYPES: ReadonlySet<ReportRowType> = new Set(['HEADER', 'SPACER']);

/** `report_columns.column_type` */
export const REPORT_COLUMN_TYPES = [
  'PERIOD',
  'YTD',
  'COMPARATIVE',
  'VARIANCE',
  'BUDGET',
  'FORECAST',
  'PERCENT',
  'ENTITY',
  'FORMULA',
] as const;
export type ReportColumnType = (typeof REPORT_COLUMN_TYPES)[number];

/** `report_definitions.rounding_display_unit` */
export const ROUNDING_DISPLAY_UNITS = ['UNIT', 'THOUSAND', 'MILLION'] as const;
export type RoundingDisplayUnit = (typeof ROUNDING_DISPLAY_UNITS)[number];

/** `report_definitions.cash_flow_method` (0053). */
export const CASH_FLOW_METHODS = ['DIRECT', 'INDIRECT'] as const;
export type DefinitionCashFlowMethod = (typeof CASH_FLOW_METHODS)[number];

/**
 * An account code, as a report definition may write one.
 *
 * Deliberately narrow. Codes in this platform are `accounts.code`, unique per
 * entity, and every seeded and templated chart uses digits with the occasional
 * separator. Admitting quotes, semicolons, whitespace or comment markers would
 * not make a single legitimate chart work and would make the "no caller string
 * reaches SQL as SQL" claim rest on the query builder alone rather than on the
 * value as well. Defence in depth is the point: the codes are ALSO bound
 * parameters everywhere they are used.
 */
export const ACCOUNT_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;

function refuse(message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError('VALIDATION_FAILED', message, { details });
}

// ---------------------------------------------------------------------------
// The formula grammar
// ---------------------------------------------------------------------------

export type FormulaNode =
  | { readonly kind: 'literal'; readonly value: Decimal }
  | { readonly kind: 'row'; readonly rowNo: number }
  | { readonly kind: 'negate'; readonly operand: FormulaNode }
  | {
      readonly kind: 'binary';
      readonly op: '+' | '-' | '*' | '/';
      readonly left: FormulaNode;
      readonly right: FormulaNode;
    };

type Token =
  | { kind: 'number'; text: string; at: number }
  | { kind: 'row'; rowNo: number; at: number }
  | { kind: 'op'; text: '+' | '-' | '*' | '/'; at: number }
  | { kind: 'lparen'; at: number }
  | { kind: 'rparen'; at: number };

const MAX_FORMULA_LENGTH = 500;

/**
 * Turns formula text into tokens, or refuses.
 *
 * Anything not in the grammar is a syntax error naming the offending character
 * and its position — a definition author fixing `R10 - COGS` needs to be told
 * that `COGS` is not a thing a formula can say, not that "validation failed".
 */
function tokenize(formula: string, rowNo: number): Token[] {
  if (formula.length > MAX_FORMULA_LENGTH) {
    throw refuse(
      `REPORT_FORMULA_SYNTAX: the formula on row ${rowNo} is ${formula.length} characters, over ` +
        `the ${MAX_FORMULA_LENGTH}-character limit. A report row's arithmetic is a handful of ` +
        `row references; anything longer is a program, and this grammar does not run programs.`,
      { row_no: rowNo, length: formula.length },
    );
  }
  const tokens: Token[] = [];
  let i = 0;
  while (i < formula.length) {
    const c = formula[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ kind: 'lparen', at: i });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ kind: 'rparen', at: i });
      i++;
      continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      tokens.push({ kind: 'op', text: c, at: i });
      i++;
      continue;
    }
    if (c === 'R' || c === 'r') {
      let j = i + 1;
      while (j < formula.length && formula[j]! >= '0' && formula[j]! <= '9') j++;
      if (j === i + 1) {
        throw refuse(
          `REPORT_FORMULA_SYNTAX: row ${rowNo}'s formula has "${c}" at position ${i} with no row ` +
            `number after it. A row reference is the letter R followed by the row_no it refers ` +
            `to, as in R10.`,
          { row_no: rowNo, position: i },
        );
      }
      tokens.push({ kind: 'row', rowNo: Number(formula.slice(i + 1, j)), at: i });
      i = j;
      continue;
    }
    if (c >= '0' && c <= '9') {
      let j = i;
      let dot = false;
      while (j < formula.length) {
        const d = formula[j]!;
        if (d >= '0' && d <= '9') {
          j++;
        } else if (d === '.' && !dot) {
          dot = true;
          j++;
        } else {
          break;
        }
      }
      tokens.push({ kind: 'number', text: formula.slice(i, j), at: i });
      i = j;
      continue;
    }
    throw refuse(
      `REPORT_FORMULA_SYNTAX: row ${rowNo}'s formula contains "${c}" at position ${i}, which is ` +
        `not part of the report formula grammar. A formula is row references (R10), numbers, ` +
        `the operators + - * / and parentheses — nothing else. It cannot name a column, a ` +
        `table or a function, which is what keeps a report definition from being a query.`,
      { row_no: rowNo, position: i, character: c },
    );
  }
  return tokens;
}

/**
 * Recursive descent over the token stream.
 *
 * Grammar, complete:
 *   expression := term (('+' | '-') term)*
 *   term       := unary (('*' | '/') unary)*
 *   unary      := ('-' | '+')? primary
 *   primary    := number | 'R' digits | '(' expression ')'
 */
export function parseFormula(formula: string, rowNo: number): FormulaNode {
  const tokens = tokenize(formula, rowNo);
  if (tokens.length === 0) {
    throw refuse(
      `REPORT_FORMULA_SYNTAX: row ${rowNo} is a ${'FORMULA'} row with an empty formula. A row ` +
        `whose amount is computed from nothing has no amount, and it would render as a zero ` +
        `nobody computed.`,
      { row_no: rowNo },
    );
  }
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const fail = (message: string): never => {
    throw refuse(`REPORT_FORMULA_SYNTAX: row ${rowNo}'s formula ${message}`, { row_no: rowNo });
  };

  function primary(): FormulaNode {
    const t = peek();
    if (t === undefined) return fail('ends where a number, a row reference or "(" was expected.');
    if (t.kind === 'number') {
      pos++;
      return { kind: 'literal', value: D(t.text, MONEY_SCALE) };
    }
    if (t.kind === 'row') {
      pos++;
      return { kind: 'row', rowNo: t.rowNo };
    }
    if (t.kind === 'lparen') {
      pos++;
      const inner = expression();
      const close = peek();
      if (close === undefined || close.kind !== 'rparen') {
        return fail(`opens a parenthesis at position ${t.at} that is never closed.`);
      }
      pos++;
      return inner;
    }
    return fail(
      `has "${t.kind === 'op' ? t.text : ')'}" at position ${t.at} where a number, a row ` +
        `reference or "(" was expected.`,
    );
  }

  function unary(): FormulaNode {
    const t = peek();
    if (t !== undefined && t.kind === 'op' && (t.text === '-' || t.text === '+')) {
      pos++;
      const operand = unary();
      return t.text === '-' ? { kind: 'negate', operand } : operand;
    }
    return primary();
  }

  function term(): FormulaNode {
    let left = unary();
    for (;;) {
      const t = peek();
      if (t === undefined || t.kind !== 'op' || (t.text !== '*' && t.text !== '/')) return left;
      pos++;
      left = { kind: 'binary', op: t.text, left, right: unary() };
    }
  }

  function expression(): FormulaNode {
    let left = term();
    for (;;) {
      const t = peek();
      if (t === undefined || t.kind !== 'op' || (t.text !== '+' && t.text !== '-')) return left;
      pos++;
      left = { kind: 'binary', op: t.text, left, right: term() };
    }
  }

  const tree = expression();
  const trailing = peek();
  if (trailing !== undefined) {
    fail(
      `has unexpected input at position ${trailing.at}; the expression already ended before it.`,
    );
  }
  return tree;
}

/** Every row this formula depends on, in first-seen order. */
export function formulaReferences(node: FormulaNode, into: number[] = []): number[] {
  switch (node.kind) {
    case 'literal':
      return into;
    case 'row':
      if (!into.includes(node.rowNo)) into.push(node.rowNo);
      return into;
    case 'negate':
      return formulaReferences(node.operand, into);
    case 'binary':
      formulaReferences(node.left, into);
      return formulaReferences(node.right, into);
  }
}

/**
 * Evaluates a parsed formula in exact decimal arithmetic.
 *
 * `resolve` returns null for a row whose own amount could not be computed — a
 * division by zero upstream, for instance. Null PROPAGATES rather than becoming
 * zero, because a percentage of nothing presented as `0.00` is a number nobody
 * computed sitting where a reader expects one that someone did.
 */
export function evaluateFormula(
  node: FormulaNode,
  resolve: (rowNo: number) => Decimal | null,
  scale: number = MONEY_SCALE,
): Decimal | null {
  switch (node.kind) {
    case 'literal':
      return node.value.rescale(scale);
    case 'row':
      return resolve(node.rowNo);
    case 'negate': {
      const v = evaluateFormula(node.operand, resolve, scale);
      return v === null ? null : v.negate();
    }
    case 'binary': {
      const left = evaluateFormula(node.left, resolve, scale);
      const right = evaluateFormula(node.right, resolve, scale);
      if (left === null || right === null) return null;
      switch (node.op) {
        case '+':
          return left.add(right);
        case '-':
          return left.sub(right);
        case '*':
          // A product of two money-scaled values carries twice the scale; bring it
          // back to the reporting scale explicitly rather than letting the scale
          // grow silently down a chain of rows.
          return left.mul(right).rescale(scale);
        case '/':
          // Division by zero is a real condition in a ratio row — a margin on zero
          // revenue — so it is not an error. It is "no answer", and it says so.
          return right.isZero() ? null : left.div(right, scale);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Definition validation
// ---------------------------------------------------------------------------

export interface ReportRowSpec {
  readonly rowNo: number;
  readonly label: string;
  readonly rowType: ReportRowType;
  readonly accountFrom?: string | null;
  readonly accountTo?: string | null;
  readonly accountGroupId?: string | null;
  readonly formula?: string | null;
  readonly signReversal?: boolean;
  readonly indentLevel?: number;
  readonly isBold?: boolean;
  readonly hideIfZero?: boolean;
}

export interface ReportColumnSpec {
  readonly columnNo: number;
  readonly label: string;
  readonly columnType: ReportColumnType;
  readonly periodOffset?: number;
  readonly budgetId?: string | null;
  readonly legalEntityId?: string | null;
  readonly formula?: string | null;
}

export interface ReportDefinitionSpec {
  readonly organizationId: string;
  readonly legalEntityId?: string | null;
  readonly code: string;
  readonly name: string;
  readonly reportType: ReportType;
  readonly retainedEarningsMethod?: 'DERIVED' | 'CLOSING_JOURNAL' | null;
  readonly roundingDisplayUnit?: RoundingDisplayUnit | null;
  readonly cashFlowMethod?: DefinitionCashFlowMethod | null;
  readonly rows: readonly ReportRowSpec[];
  readonly columns?: readonly ReportColumnSpec[];
}

export interface ValidatedRow extends ReportRowSpec {
  /** Present exactly for FORMULA and SUBTOTAL rows. */
  readonly parsedFormula: FormulaNode | null;
  readonly referencedRows: readonly number[];
}

export interface ValidatedDefinition {
  readonly spec: ReportDefinitionSpec;
  readonly rows: readonly ValidatedRow[];
  /** Rows in an order where every formula's dependencies are already computed. */
  readonly evaluationOrder: readonly number[];
}

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

function assertAccountCode(code: string, rowNo: number, field: string): void {
  if (!ACCOUNT_CODE_PATTERN.test(code)) {
    throw refuse(
      `REPORT_ACCOUNT_CODE_INVALID: row ${rowNo}'s ${field} is "${code}", which is not an ` +
        `account code. Codes are up to 40 characters of letters, digits, ".", "_" and "-". A ` +
        `report definition names accounts; it does not carry expressions.`,
      { row_no: rowNo, field },
    );
  }
}

/**
 * Compares two account codes the way an account range means them.
 *
 * The same rule as the statement engine's `compareAccountCodes`, and it must stay
 * the same rule: an account range that validates here and selects differently
 * there is a report whose bounds mean one thing to the check and another to the
 * statement. All-numeric codes compare numerically so a five-digit sub-account
 * does not fall inside a four-digit range by string order.
 */
const ALL_DIGITS = /^\d+$/;
export function compareCodes(a: string, b: string): -1 | 0 | 1 {
  if (ALL_DIGITS.test(a) && ALL_DIGITS.test(b)) {
    const x = BigInt(a);
    const y = BigInt(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The whole of the definition check, in one pass, before anything is written.
 *
 * Ordering matters here: the vocabulary first (so an unknown row type is reported
 * as an unknown row type rather than as a missing selector), then per-row
 * structure, then the cross-row graph. A cycle can only be looked for once every
 * formula parses.
 */
export function validateReportDefinition(spec: ReportDefinitionSpec): ValidatedDefinition {
  if (!oneOf(REPORT_TYPES, spec.reportType)) {
    throw refuse(
      `REPORT_TYPE_UNKNOWN: "${String(spec.reportType)}" is not a report type. The model admits ` +
        `${REPORT_TYPES.join(', ')}.`,
      { report_type: spec.reportType },
    );
  }
  if (
    spec.roundingDisplayUnit != null &&
    !oneOf(ROUNDING_DISPLAY_UNITS, spec.roundingDisplayUnit)
  ) {
    throw refuse(
      `REPORT_TYPE_UNKNOWN: "${String(spec.roundingDisplayUnit)}" is not a rounding display ` +
        `unit. The model admits ${ROUNDING_DISPLAY_UNITS.join(', ')}.`,
    );
  }
  // 0053's rd_cash_flow_method_present: exactly the cash flow definitions carry a
  // method. Checked here so the caller is told which field to fix rather than
  // receiving a check-constraint violation.
  if (spec.reportType === 'CASH_FLOW' && spec.cashFlowMethod == null) {
    throw refuse(
      `REPORT_TYPE_UNKNOWN: a CASH_FLOW definition must declare cash_flow_method (DIRECT or ` +
        `INDIRECT). doc 12 ships the classification-driven DIRECT method first, and a ` +
        `definition that does not say which method it is could have direct figures rendered ` +
        `under an indirect heading.`,
    );
  }
  if (spec.reportType !== 'CASH_FLOW' && spec.cashFlowMethod != null) {
    throw refuse(
      `REPORT_TYPE_UNKNOWN: cash_flow_method is only meaningful on a CASH_FLOW definition; this ` +
        `one is ${spec.reportType}.`,
    );
  }
  if (spec.cashFlowMethod != null && !oneOf(CASH_FLOW_METHODS, spec.cashFlowMethod)) {
    throw refuse(
      `REPORT_TYPE_UNKNOWN: "${String(spec.cashFlowMethod)}" is not a cash flow method. The ` +
        `model admits ${CASH_FLOW_METHODS.join(', ')}.`,
    );
  }
  if (spec.rows.length === 0) {
    throw refuse(
      `REPORT_DEFINITION_NO_ROWS: definition "${spec.code}" declares no rows. A report ` +
        `definition with no rows renders an empty statement that still looks like a statement.`,
      { code: spec.code },
    );
  }

  const byRowNo = new Map<number, ReportRowSpec>();
  for (const row of spec.rows) {
    if (!Number.isInteger(row.rowNo)) {
      throw refuse(
        `REPORT_ROW_DUPLICATE: row_no "${String(row.rowNo)}" is not an integer. row_no orders ` +
          `the statement and keys every formula reference.`,
      );
    }
    if (byRowNo.has(row.rowNo)) {
      throw refuse(
        `REPORT_ROW_DUPLICATE: row_no ${row.rowNo} is declared twice ("${
          byRowNo.get(row.rowNo)!.label
        }" and "${row.label}"). A formula referencing R${row.rowNo} could mean either.`,
        { row_no: row.rowNo },
      );
    }
    byRowNo.set(row.rowNo, row);
  }

  const validated: ValidatedRow[] = [];
  for (const row of spec.rows) {
    if (!oneOf(REPORT_ROW_TYPES, row.rowType)) {
      throw refuse(
        `REPORT_ROW_TYPE_UNKNOWN: row ${row.rowNo} ("${row.label}") is "${String(
          row.rowType,
        )}". The model admits ${REPORT_ROW_TYPES.join(', ')}.`,
        { row_no: row.rowNo },
      );
    }
    if (row.label.trim() === '') {
      throw refuse(
        `REPORT_ROW_SELECTOR_MISSING: row ${row.rowNo} has an empty label. Every line of a ` +
          `statement has to say what it is.`,
        { row_no: row.rowNo },
      );
    }

    if (row.rowType === 'ACCOUNT_RANGE') {
      const from = row.accountFrom ?? null;
      const to = row.accountTo ?? null;
      if (from === null && to === null) {
        throw refuse(
          `REPORT_ROW_SELECTOR_MISSING: row ${row.rowNo} ("${row.label}") is an ACCOUNT_RANGE ` +
            `with neither account_from nor account_to. A range that bounds nothing selects the ` +
            `whole chart on one reading and nothing at all on the other, and either way nobody ` +
            `chose it.`,
          { row_no: row.rowNo },
        );
      }
      if (from !== null) assertAccountCode(from, row.rowNo, 'account_from');
      if (to !== null) assertAccountCode(to, row.rowNo, 'account_to');
      if (from !== null && to !== null && compareCodes(from, to) > 0) {
        throw refuse(
          `REPORT_ROW_RANGE_INVERTED: row ${row.rowNo} ("${row.label}") ranges from ${from} to ` +
            `${to}, which is empty — no account can ever reach it. Swap the bounds.`,
          { row_no: row.rowNo },
        );
      }
      if (row.accountGroupId != null || (row.formula ?? '').trim() !== '') {
        throw refuse(
          `REPORT_ROW_SELECTOR_MISSING: row ${row.rowNo} ("${row.label}") is an ACCOUNT_RANGE ` +
            `but also carries ${row.accountGroupId != null ? 'an account group' : 'a formula'}. ` +
            `A row has one selector; two would make which one applied depend on the reader.`,
          { row_no: row.rowNo },
        );
      }
    } else if (row.rowType === 'ACCOUNT_GROUP') {
      if (row.accountGroupId == null) {
        throw refuse(
          `REPORT_ROW_SELECTOR_MISSING: row ${row.rowNo} ("${row.label}") is an ACCOUNT_GROUP ` +
            `row with no account_group_id. It would render empty forever.`,
          { row_no: row.rowNo },
        );
      }
      if (row.accountFrom != null || row.accountTo != null || (row.formula ?? '').trim() !== '') {
        throw refuse(
          `REPORT_ROW_SELECTOR_MISSING: row ${row.rowNo} ("${row.label}") is an ACCOUNT_GROUP ` +
            `row and also carries a code range or a formula. A row has one selector.`,
          { row_no: row.rowNo },
        );
      }
    } else if (COMPUTED_ROW_TYPES.has(row.rowType)) {
      const formula = (row.formula ?? '').trim();
      if (formula === '') {
        throw refuse(
          `REPORT_ROW_SELECTOR_MISSING: row ${row.rowNo} ("${row.label}") is a ${row.rowType} ` +
            `row with no formula. A subtotal that totals nothing renders a zero nobody computed.`,
          { row_no: row.rowNo },
        );
      }
      if (row.accountFrom != null || row.accountTo != null || row.accountGroupId != null) {
        throw refuse(
          `REPORT_ROW_SELECTOR_MISSING: row ${row.rowNo} ("${row.label}") is a ${row.rowType} ` +
            `row and also selects accounts. Its amount comes from the rows its formula names; ` +
            `the accounts would be counted twice.`,
          { row_no: row.rowNo },
        );
      }
    } else {
      // HEADER and SPACER carry nothing at all.
      if (
        row.accountFrom != null ||
        row.accountTo != null ||
        row.accountGroupId != null ||
        (row.formula ?? '').trim() !== ''
      ) {
        throw refuse(
          `REPORT_ROW_SELECTOR_MISSING: row ${row.rowNo} ("${row.label}") is a ${row.rowType}, ` +
            `which has no amount, but it carries a selector. Whatever it selected would be ` +
            `invisible in the statement and missing from every total.`,
          { row_no: row.rowNo },
        );
      }
    }

    const parsed = COMPUTED_ROW_TYPES.has(row.rowType)
      ? parseFormula((row.formula ?? '').trim(), row.rowNo)
      : null;
    const references = parsed === null ? [] : formulaReferences(parsed);

    for (const ref of references) {
      const target = byRowNo.get(ref);
      if (target === undefined) {
        throw refuse(
          `REPORT_FORMULA_UNKNOWN_ROW: row ${row.rowNo} ("${row.label}") references R${ref}, ` +
            `which this definition does not declare. The reference would evaluate to nothing ` +
            `and the row would silently be short by whatever R${ref} was meant to contribute.`,
          { row_no: row.rowNo, references: ref },
        );
      }
      if (ref === row.rowNo) {
        throw refuse(
          `REPORT_FORMULA_SELF_REFERENCE: row ${row.rowNo} ("${row.label}") references itself.`,
          { row_no: row.rowNo },
        );
      }
      if (PRESENTATION_ROW_TYPES.has(target.rowType as ReportRowType)) {
        throw refuse(
          `REPORT_FORMULA_REFERENCES_PRESENTATION_ROW: row ${row.rowNo} ("${row.label}") ` +
            `references R${ref}, which is a ${target.rowType} and has no amount. Treating it as ` +
            `zero would make the total silently wrong by the amount the author thought was there.`,
          { row_no: row.rowNo, references: ref },
        );
      }
    }

    validated.push({ ...row, parsedFormula: parsed, referencedRows: references });
  }

  return { spec, rows: validated, evaluationOrder: topologicalOrder(validated) };
}

/**
 * Rows ordered so every formula's dependencies precede it, refusing cycles.
 *
 * Iterative depth-first with an explicit colour map rather than recursion: a
 * definition is caller-supplied, and a thousand-row chain must produce
 * `REPORT_FORMULA_CYCLE` or an ordering, never a stack overflow — which would
 * surface as a 500 and tell the author nothing.
 */
function topologicalOrder(rows: readonly ValidatedRow[]): number[] {
  const byRowNo = new Map(rows.map((r) => [r.rowNo, r]));
  const colour = new Map<number, 'grey' | 'black'>();
  const order: number[] = [];

  for (const start of rows) {
    if (colour.get(start.rowNo) === 'black') continue;
    const stack: Array<{ rowNo: number; next: number }> = [{ rowNo: start.rowNo, next: 0 }];
    colour.set(start.rowNo, 'grey');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const row = byRowNo.get(frame.rowNo)!;
      if (frame.next < row.referencedRows.length) {
        const ref = row.referencedRows[frame.next]!;
        frame.next++;
        const seen = colour.get(ref);
        if (seen === 'grey') {
          const cycle = [...stack.map((f) => `R${f.rowNo}`), `R${ref}`].join(' -> ');
          throw refuse(
            `REPORT_FORMULA_CYCLE: the formulas form a cycle (${cycle}). No evaluation order ` +
              `exists, so at least one row's amount would depend on its own value.`,
            { cycle },
          );
        }
        if (seen === undefined) {
          colour.set(ref, 'grey');
          stack.push({ rowNo: ref, next: 0 });
        }
      } else {
        colour.set(frame.rowNo, 'black');
        order.push(frame.rowNo);
        stack.pop();
      }
    }
  }
  return order;
}

/**
 * Does an account code fall inside a validated ACCOUNT_RANGE row?
 *
 * Exported because the mapping builder and the tests must ask the same question
 * of the same function; a range that means one thing when a definition is
 * validated and another when it is applied is a statement nobody can reconcile.
 */
export function codeInRange(
  code: string,
  from: string | null | undefined,
  to: string | null | undefined,
): boolean {
  if (from != null && compareCodes(code, from) < 0) return false;
  if (to != null && compareCodes(code, to) > 0) return false;
  return from != null || to != null;
}

/** The boundary, as data, so a caller can be shown it rather than told about it. */
export const SEMANTIC_MODEL_BOUNDARY = {
  formula_grammar: 'row references (R<row_no>), decimal literals, + - * / and parentheses',
  formula_may_reference: 'other rows of the SAME definition, excluding HEADER and SPACER rows',
  identifiers_admitted: ['account_id', 'account_group_id', 'account code'],
  identifiers_refused: [
    'table names',
    'column names',
    'function calls',
    'string literals',
    'comparison and boolean operators',
    'statement separators',
  ],
  scope:
    "the definition's own legal entity, or any entity of its organization when it is an organization-wide template",
  enforced_by: [
    'validateReportDefinition (application, actionable message)',
    'assert_statement_mapping_in_scope trigger (0053)',
    'statement_account_mappings composite foreign keys (0053)',
    'row-level security with app.tenant_id (0024)',
  ],
  refusals: [
    'REPORT_TYPE_UNKNOWN',
    'REPORT_ROW_TYPE_UNKNOWN',
    'REPORT_ROW_SELECTOR_MISSING',
    'REPORT_ROW_RANGE_INVERTED',
    'REPORT_ROW_DUPLICATE',
    'REPORT_ACCOUNT_CODE_INVALID',
    'REPORT_FORMULA_SYNTAX',
    'REPORT_FORMULA_UNKNOWN_ROW',
    'REPORT_FORMULA_SELF_REFERENCE',
    'REPORT_FORMULA_CYCLE',
    'REPORT_FORMULA_REFERENCES_PRESENTATION_ROW',
    'REPORT_DEFINITION_NO_ROWS',
    'REPORT_COLUMN_TYPE_UNKNOWN',
  ],
} as const;

/** Column vocabulary check, separated because columns are optional. */
export function validateReportColumns(columns: readonly ReportColumnSpec[]): void {
  const seen = new Set<number>();
  for (const column of columns) {
    if (!oneOf(REPORT_COLUMN_TYPES, column.columnType)) {
      throw refuse(
        `REPORT_COLUMN_TYPE_UNKNOWN: column ${column.columnNo} ("${column.label}") is ` +
          `"${String(column.columnType)}". The model admits ${REPORT_COLUMN_TYPES.join(', ')}.`,
        { column_no: column.columnNo },
      );
    }
    if (seen.has(column.columnNo)) {
      throw refuse(`REPORT_ROW_DUPLICATE: column_no ${column.columnNo} is declared twice.`, {
        column_no: column.columnNo,
      });
    }
    seen.add(column.columnNo);
    if (column.columnType === 'FORMULA') {
      const formula = (column.formula ?? '').trim();
      if (formula === '') {
        throw refuse(
          `REPORT_COLUMN_TYPE_UNKNOWN: column ${column.columnNo} ("${column.label}") is a ` +
            `FORMULA column with no formula.`,
          { column_no: column.columnNo },
        );
      }
      // Parsed by the same grammar, so a column formula cannot say anything a row
      // formula cannot. Column references are row references evaluated per column.
      parseFormula(formula, column.columnNo);
    }
  }
}
