/**
 * Running a stored report definition over a trial balance.
 *
 * The definition decides three things and no others: which accounts roll up to
 * which line, how the lines are ordered and labelled, and what arithmetic
 * combines them. Everything else — what an account balance IS, how a section
 * totals, whether the sheet balances — is `@acct/domain/statements`, and a
 * definition cannot reach it.
 *
 * The resolution is deliberately done in TypeScript rather than in SQL, and that
 * is not a preference. An account range compares codes the way
 * `compareAccountCodes` compares them: all-numeric codes numerically, everything
 * else lexicographically. SQL's `BETWEEN` on a text column is lexicographic
 * always, so `'10000'` falls inside `'1000'`..`'1999'` in the database and does
 * not in the engine — a five-digit sub-account would land in one line when the
 * definition was validated and another when the statement was rendered. One
 * comparison, in one place, used by the validator, the resolver and the engine.
 */

import type { PoolClient } from 'pg';
import { AppError, Decimal, MONEY_SCALE, notFound } from '@acct/domain';
import type {
  AccountTypeCode,
  BalanceSheetLineSpec,
  BalanceSheetSection,
  ProfitAndLossLineSpec,
  ProfitAndLossSection,
} from '@acct/domain';
import {
  ACCOUNT_BEARING_ROW_TYPES,
  COMPUTED_ROW_TYPES,
  PRESENTATION_ROW_TYPES,
  codeInRange,
  evaluateFormula,
  parseFormula,
  type FormulaNode,
  type ReportRowType,
  type ReportType,
} from './semantic-model';

export interface DefinitionAccount {
  readonly accountId: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: AccountTypeCode;
  readonly groupCode: string | null;
}

export interface LoadedDefinitionRow {
  readonly id: string;
  readonly rowNo: number;
  readonly label: string;
  readonly rowType: ReportRowType;
  readonly accountFrom: string | null;
  readonly accountTo: string | null;
  readonly accountGroupId: string | null;
  readonly accountGroupCode: string | null;
  readonly formula: string | null;
  readonly parsedFormula: FormulaNode | null;
  readonly signReversal: boolean;
  readonly indentLevel: number;
  readonly isBold: boolean;
  readonly hideIfZero: boolean;
  /** Resolved once, from the mapping table or from the row's own selector. */
  readonly accountIds: readonly string[];
  /** Which resolution produced `accountIds` — a reader must be able to tell. */
  readonly resolvedBy: 'MAPPING' | 'SELECTOR' | 'NONE';
}

export interface DefinitionExclusion {
  readonly account_id: string;
  readonly account_code: string;
  readonly account_name: string;
  readonly reason: string;
}

export interface LoadedDefinition {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly version: number;
  readonly reportType: ReportType;
  readonly retainedEarningsMethod: 'DERIVED' | 'CLOSING_JOURNAL' | null;
  readonly cashFlowMethod: 'DIRECT' | 'INDIRECT' | null;
  readonly roundingDisplayUnit: string | null;
  readonly legalEntityId: string | null;
  readonly organizationId: string;
  readonly rows: readonly LoadedDefinitionRow[];
  readonly exclusions: readonly DefinitionExclusion[];
  /** Warnings that do not stop a statement but must travel with it. */
  readonly exceptions: readonly { code: string; message: string; row_no?: number }[];
}

/**
 * The section a line sits in, derived from the account type on it.
 *
 * A LIMITATION, stated rather than hidden: `report_rows` (0016) has no section or
 * classification column, so a stored definition cannot say that row 20 is cost of
 * sales and row 40 is an operating expense — both are EXPENSE accounts and
 * nothing in the schema distinguishes their presentation. Guessing from the
 * label, or from a group-code convention the schema does not enforce, would
 * produce a gross profit nobody defined. So a definition-driven statement uses
 * the same sections the engine's default definition uses, its ROWS carry the
 * detail, and the finer sectioning waits for the column. See INTEGRATION NOTES.
 */
const PNL_SECTION: Record<'REVENUE' | 'EXPENSE', ProfitAndLossSection> = {
  REVENUE: 'REVENUE',
  EXPENSE: 'OPERATING_EXPENSE',
};
const BS_SECTION: Record<'ASSET' | 'LIABILITY' | 'EQUITY', BalanceSheetSection> = {
  ASSET: 'ASSET',
  LIABILITY: 'LIABILITY',
  EQUITY: 'EQUITY',
};

export function sectionFor(
  reportType: 'PROFIT_LOSS' | 'BALANCE_SHEET',
  accountType: AccountTypeCode,
): ProfitAndLossSection | BalanceSheetSection {
  if (reportType === 'PROFIT_LOSS') {
    if (accountType !== 'REVENUE' && accountType !== 'EXPENSE') {
      throw new AppError(
        'VALIDATION_FAILED',
        `STATEMENT_LINE_TYPE_MISMATCH: a ${accountType} account cannot appear on a profit and ` +
          `loss. Move it to the balance sheet definition.`,
      );
    }
    return PNL_SECTION[accountType];
  }
  if (accountType !== 'ASSET' && accountType !== 'LIABILITY' && accountType !== 'EQUITY') {
    throw new AppError(
      'VALIDATION_FAILED',
      `STATEMENT_LINE_TYPE_MISMATCH: a ${accountType} account cannot appear on a balance sheet. ` +
        `Move it to the profit and loss definition.`,
    );
  }
  return BS_SECTION[accountType];
}

interface DefinitionHeaderRow {
  id: string;
  code: string;
  name: string;
  version: number;
  report_type: ReportType;
  retained_earnings_method: 'DERIVED' | 'CLOSING_JOURNAL' | null;
  cash_flow_method: 'DIRECT' | 'INDIRECT' | null;
  rounding_display_unit: string | null;
  legal_entity_id: string | null;
  organization_id: string;
  status: string;
}

/**
 * Loads a definition and resolves every row to a set of account ids.
 *
 * `accounts` is the chart as the trial balance saw it, so a row can never resolve
 * to an account the statement is not composed from — which is how a line total
 * and the sum of its accounts stay the same number.
 */
export async function loadDefinition(
  client: PoolClient,
  tenantId: string,
  definitionId: string,
  accounts: readonly DefinitionAccount[],
): Promise<LoadedDefinition> {
  const { rows: headers } = await client.query<DefinitionHeaderRow>(
    `SELECT d.id, d.code, d.name, d.version, d.report_type,
            d.retained_earnings_method::text AS retained_earnings_method,
            d.cash_flow_method, d.rounding_display_unit,
            d.legal_entity_id, d.organization_id, d.status::text AS status
       FROM report_definitions d
      WHERE d.id = $1 AND d.tenant_id = $2`,
    [definitionId, tenantId],
  );
  const header = headers[0];
  if (!header) throw notFound('Report definition', definitionId);

  const { rows: rowRecords } = await client.query<{
    id: string;
    row_no: number;
    label: string;
    row_type: ReportRowType;
    account_from: string | null;
    account_to: string | null;
    account_group_id: string | null;
    account_group_code: string | null;
    formula: string | null;
    sign_reversal: boolean;
    indent_level: number;
    is_bold: boolean;
    hide_if_zero: boolean;
  }>(
    `SELECT r.id, r.row_no, r.label, r.row_type, r.account_from, r.account_to,
            r.account_group_id, g.code AS account_group_code, r.formula,
            r.sign_reversal, r.indent_level, r.is_bold, r.hide_if_zero
       FROM report_rows r
       LEFT JOIN account_groups g ON g.id = r.account_group_id
      WHERE r.report_definition_id = $1
      ORDER BY r.row_no`,
    [definitionId],
  );

  const { rows: mappings } = await client.query<{
    account_id: string;
    report_row_id: string | null;
    exclusion_reason: string | null;
  }>(
    `SELECT account_id, report_row_id, exclusion_reason
       FROM statement_account_mappings
      WHERE report_definition_id = $1`,
    [definitionId],
  );

  const accountsById = new Map(accounts.map((a) => [a.accountId, a]));
  const exceptions: { code: string; message: string; row_no?: number }[] = [];

  const exclusions: DefinitionExclusion[] = mappings
    .filter((m) => m.report_row_id === null && m.exclusion_reason !== null)
    .map((m) => {
      const account = accountsById.get(m.account_id);
      return {
        account_id: m.account_id,
        account_code: account?.code ?? m.account_id,
        account_name: account?.name ?? '',
        reason: m.exclusion_reason!,
      };
    });

  const mappedByRow = new Map<string, string[]>();
  for (const mapping of mappings) {
    if (mapping.report_row_id === null) continue;
    const list = mappedByRow.get(mapping.report_row_id);
    if (list) list.push(mapping.account_id);
    else mappedByRow.set(mapping.report_row_id, [mapping.account_id]);
  }
  const hasMappings = mappedByRow.size > 0 || exclusions.length > 0;

  // An account may reach at most one line. The database says so for the mapping
  // table (sam_account_uq); nothing says it for the range/group fallback, so it
  // is said here — an account counted on two lines makes a statement whose total
  // disagrees with its own sections while both look right.
  const claimedBy = new Map<string, number>();

  const rows: LoadedDefinitionRow[] = rowRecords.map((record) => {
    let accountIds: string[] = [];
    let resolvedBy: 'MAPPING' | 'SELECTOR' | 'NONE' = 'NONE';

    if (ACCOUNT_BEARING_ROW_TYPES.has(record.row_type)) {
      if (hasMappings) {
        accountIds = (mappedByRow.get(record.id) ?? []).filter((id) => accountsById.has(id));
        resolvedBy = 'MAPPING';
      } else {
        accountIds = accounts
          .filter((account) =>
            record.row_type === 'ACCOUNT_RANGE'
              ? codeInRange(account.code, record.account_from, record.account_to)
              : record.account_group_code !== null &&
                account.groupCode === record.account_group_code,
          )
          .map((a) => a.accountId);
        resolvedBy = 'SELECTOR';
      }

      for (const accountId of accountIds) {
        const already = claimedBy.get(accountId);
        if (already !== undefined) {
          const account = accountsById.get(accountId)!;
          throw new AppError(
            'VALIDATION_FAILED',
            `STATEMENT_ACCOUNT_MAPPED_TWICE: account ${account.code} ${account.name} reaches ` +
              `both row ${already} and row ${record.row_no} of report definition ` +
              `${header.code} v${header.version}. Its balance would be counted once per row and ` +
              `the statement would not tie to the trial balance. Narrow the ranges, or map the ` +
              `account explicitly.`,
            { details: { account_id: accountId, rows: [already, record.row_no] } },
          );
        }
        claimedBy.set(accountId, record.row_no);
      }

      if (accountIds.length === 0) {
        exceptions.push({
          code: 'REPORT_ROW_SELECTS_NO_ACCOUNT',
          row_no: record.row_no,
          message:
            `Row ${record.row_no} ("${record.label}") of ${header.code} v${header.version} ` +
            `selects no account in this entity's chart, so it renders as zero. A row that can ` +
            `never receive an account silently shrinks the statement by whatever it was meant ` +
            `to carry; ${
              resolvedBy === 'MAPPING' ? 'map accounts to it' : 'check its account range or group'
            }.`,
        });
      }
    }

    return {
      id: record.id,
      rowNo: record.row_no,
      label: record.label,
      rowType: record.row_type,
      accountFrom: record.account_from,
      accountTo: record.account_to,
      accountGroupId: record.account_group_id,
      accountGroupCode: record.account_group_code,
      formula: record.formula,
      parsedFormula:
        COMPUTED_ROW_TYPES.has(record.row_type) && (record.formula ?? '').trim() !== ''
          ? parseFormula(record.formula!.trim(), record.row_no)
          : null,
      signReversal: record.sign_reversal,
      indentLevel: record.indent_level,
      isBold: record.is_bold,
      hideIfZero: record.hide_if_zero,
      accountIds,
      resolvedBy,
    };
  });

  if (header.status !== 'ACTIVE') {
    exceptions.push({
      code: 'REPORT_DEFINITION_NOT_ACTIVE',
      message:
        `Report definition ${header.code} v${header.version} is ${header.status}. It still ` +
        `renders — a snapshot taken under it must remain reproducible — but new statements ` +
        `should use the active version.`,
    });
  }

  return {
    id: header.id,
    code: header.code,
    name: header.name,
    version: header.version,
    reportType: header.report_type,
    retainedEarningsMethod: header.retained_earnings_method,
    cashFlowMethod: header.cash_flow_method,
    roundingDisplayUnit: header.rounding_display_unit,
    legalEntityId: header.legal_entity_id,
    organizationId: header.organization_id,
    rows,
    exclusions,
    exceptions,
  };
}

/**
 * The engine line specs for a definition, one per account-bearing row that
 * actually resolved to accounts.
 *
 * A row that resolved to none is omitted rather than passed through as a line
 * with an empty selector: the engine refuses an empty selector outright (rightly
 * — a line that can never receive an account is a lie about coverage), and one
 * mis-typed range would take the whole statement down instead of producing the
 * statement plus the exception that names the row. The exception is raised in
 * `loadDefinition` and travels with the response.
 */
interface ResolvedLineSpec<S extends string> {
  readonly code: string;
  readonly label: string;
  readonly section: S;
  readonly sortOrder: number;
  readonly accountIds: readonly string[];
}

function lineSpecs<S extends string>(
  definition: LoadedDefinition,
  reportType: 'PROFIT_LOSS' | 'BALANCE_SHEET',
  accountTypeOf: (accountId: string) => AccountTypeCode | undefined,
): Array<ResolvedLineSpec<S>> {
  const specs: Array<ResolvedLineSpec<S>> = [];

  for (const row of definition.rows) {
    if (!ACCOUNT_BEARING_ROW_TYPES.has(row.rowType) || row.accountIds.length === 0) continue;

    const types = new Set<AccountTypeCode>();
    for (const accountId of row.accountIds) {
      const type = accountTypeOf(accountId);
      if (type !== undefined) types.add(type);
    }
    const sections = new Set([...types].map((t) => sectionFor(reportType, t)));
    if (sections.size > 1) {
      throw new AppError(
        'VALIDATION_FAILED',
        `STATEMENT_LINE_TYPE_MISMATCH: row ${row.rowNo} ("${row.label}") of ` +
          `${definition.code} v${definition.version} mixes account types ` +
          `${[...types].join(' and ')}, which belong to different sections ` +
          `(${[...sections].join(', ')}). Presenting them on one line files at least one of ` +
          `them under a heading that misstates what it is; split the row.`,
        { details: { row_no: row.rowNo, account_types: [...types] } },
      );
    }
    const section = [...sections][0];
    if (section === undefined) continue;

    specs.push({
      code: `ROW:${row.rowNo}`,
      label: row.label,
      section: section as S,
      sortOrder: row.rowNo,
      accountIds: row.accountIds,
    });
  }
  return specs;
}

/** The profit-and-loss lines of a definition, typed for the engine. */
export const profitAndLossLineSpecs = (
  definition: LoadedDefinition,
  accountTypeOf: (accountId: string) => AccountTypeCode | undefined,
): ProfitAndLossLineSpec[] =>
  lineSpecs<ProfitAndLossSection>(definition, 'PROFIT_LOSS', accountTypeOf);

/** The balance-sheet lines of a definition, typed for the engine. */
export const balanceSheetLineSpecs = (
  definition: LoadedDefinition,
  accountTypeOf: (accountId: string) => AccountTypeCode | undefined,
): BalanceSheetLineSpec[] =>
  lineSpecs<BalanceSheetSection>(definition, 'BALANCE_SHEET', accountTypeOf);

/** The line code a row's amount is found under, in the engine's output. */
export const lineCodeFor = (rowNo: number): string => `ROW:${rowNo}`;

export interface PresentedRow {
  readonly row_no: number;
  readonly label: string;
  readonly row_type: ReportRowType;
  readonly indent_level: number;
  readonly is_bold: boolean;
  readonly hide_if_zero: boolean;
  /** True when hide_if_zero applies to this row's amounts in EVERY column. */
  readonly hidden: boolean;
  readonly sign_reversal: boolean;
  readonly resolved_by: 'MAPPING' | 'SELECTOR' | 'NONE';
  readonly account_count: number;
  readonly formula: string | null;
  /** The engine's amount per column, before any presentation sign flip. */
  readonly amounts: Readonly<Record<string, string | null>>;
  /** The same amounts as presented — sign_reversal applied and nothing else. */
  readonly presented_amounts: Readonly<Record<string, string | null>>;
}

/**
 * Builds the presented rows of a definition-driven statement.
 *
 * Two properties this function is written to keep:
 *
 *   1. `sign_reversal` and `hide_if_zero` are PRESENTATION. They change how a row
 *      is shown and never what a total is: `amounts` always carries the engine's
 *      figure, `presented_amounts` the flipped one, and both are returned so
 *      nothing downstream has to guess which it is holding. A hidden row is
 *      flagged, not dropped — dropping it would take its exception with it.
 *   2. A formula that cannot be evaluated yields NULL, not zero. A margin on zero
 *      revenue is not 0%; presenting it as 0% puts a number nobody computed where
 *      a reader expects one that someone did.
 */
export function presentRows(
  definition: LoadedDefinition,
  columns: readonly string[],
  lineAmount: (rowNo: number, column: string) => Decimal | null,
): PresentedRow[] {
  const rowByNo = new Map(definition.rows.map((r) => [r.rowNo, r]));
  const cache = new Map<string, Decimal | null>();
  const visiting = new Set<string>();

  /**
   * One row's amount in one column, memoised, with a cycle guard.
   *
   * The guard is not belt and braces. `validateReportDefinition` refuses a cycle
   * at write time, but a definition stored before that check existed — or edited
   * by any path that does not go through this package — would otherwise recurse
   * until the stack ran out, and a stack overflow reaches the caller as a 500
   * that names nothing.
   */
  const amountFor = (rowNo: number, column: string): Decimal | null => {
    const key = `${rowNo}${column}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    if (visiting.has(key)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `REPORT_FORMULA_CYCLE: row ${rowNo} of ${definition.code} v${definition.version} ` +
          `depends on itself through its formula, so its amount would depend on its own value. ` +
          `Break the loop in the definition.`,
        { details: { row_no: rowNo, definition_id: definition.id } },
      );
    }
    visiting.add(key);
    try {
      const row = rowByNo.get(rowNo);
      let value: Decimal | null;
      if (row === undefined || PRESENTATION_ROW_TYPES.has(row.rowType)) {
        value = null;
      } else if (COMPUTED_ROW_TYPES.has(row.rowType)) {
        value =
          row.parsedFormula === null
            ? null
            : evaluateFormula(row.parsedFormula, (ref) => amountFor(ref, column), MONEY_SCALE);
      } else {
        value = lineAmount(rowNo, column);
      }
      cache.set(key, value);
      return value;
    } finally {
      visiting.delete(key);
    }
  };

  return definition.rows.map((row) => {
    const raw: Record<string, string | null> = {};
    const presented: Record<string, string | null> = {};
    let allZero = true;
    for (const column of columns) {
      const value = PRESENTATION_ROW_TYPES.has(row.rowType) ? null : amountFor(row.rowNo, column);
      raw[column] = value === null ? null : value.toString();
      presented[column] =
        value === null ? null : (row.signReversal ? value.negate() : value).toString();
      if (value !== null && !value.isZero()) allZero = false;
    }
    return {
      row_no: row.rowNo,
      label: row.label,
      row_type: row.rowType,
      indent_level: row.indentLevel,
      is_bold: row.isBold,
      hide_if_zero: row.hideIfZero,
      hidden: row.hideIfZero && allZero && !PRESENTATION_ROW_TYPES.has(row.rowType),
      sign_reversal: row.signReversal,
      resolved_by: row.resolvedBy,
      account_count: row.accountIds.length,
      formula: row.formula,
      amounts: raw,
      presented_amounts: presented,
    };
  });
}
