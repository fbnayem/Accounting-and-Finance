/**
 * Profit and loss, balance sheet and cash flow — `getProfitLoss`,
 * `getBalanceSheet` and `getCashFlow` (contracts/openapi.yaml, phase 6).
 *
 * This service loads a trial balance, hands it to the composition engine in
 * `@acct/domain/statements`, and serves what comes back. It computes no
 * statement arithmetic of its own, and there is no SQL in the package that adds a
 * revenue to an expense or nets an asset against a liability. That is the whole
 * design rule: two implementations of the same statement is two answers, and the
 * second one is always found at a close, by an accountant, in something already
 * signed.
 *
 * Two exit criteria are answered IN the response rather than left to a caller:
 *
 *   1. "Core statements tie exactly to Trial Balance." Every response carries a
 *      `reconciliation` block comparing the trial balance the statements were
 *      composed from, account by account and column by column, against the one
 *      `/reports/trial-balance` produces from the same book and window — a
 *      different query over the same ledger. Plus the engine's own tie checks.
 *      `criterion.satisfied` is the conjunction, and it is false unless both
 *      halves were actually measured.
 *
 *   2. "Every financial report amount can drill to ledger lines." Every section,
 *      every line and every account carries a `drill` token: the exact parameters
 *      `/reports/drill-down` needs to list the journal lines behind that figure.
 *      A drill the caller has to assemble from the request it made is one
 *      forgotten parameter away from explaining a different number.
 */

import type { Pool, PoolClient } from 'pg';
import {
  AppError,
  Decimal,
  MONEY_SCALE,
  assertEntityPermission,
  composeBalanceSheet,
  composeCashFlow,
  composeFinancialStatements,
  composeProfitAndLoss,
  trialBalanceTotals as engineTrialBalanceTotals,
  type BalanceSheetLineSpec,
  type ProfitAndLossLineSpec,
  type RetainedEarningsMethod,
  type StatementLine,
  type TenantPrincipal,
  type UnmappedPolicy,
} from '@acct/domain';
import { readInTenant } from '@acct/database';
import type { LedgerReportsService } from '@acct/ledger';
import {
  cashFlowRows,
  loadBookScope,
  loadTrialBalance,
  type BalanceSource,
  type LoadedTrialBalance,
} from './trial-balance.loader';
import {
  balanceSheetLineSpecs,
  lineCodeFor,
  loadDefinition,
  presentRows,
  profitAndLossLineSpecs,
  type DefinitionAccount,
  type LoadedDefinition,
} from './definition-runtime';
import {
  reconcileToTrialBalance,
  type LedgerTrialBalanceResult,
  type TrialBalanceReconciliation,
  type TrialBalanceReconciliationSkipped,
} from './reconciliation';
import * as wire from './serialization';
import type { DrillBuilder, DrillToken } from './serialization';

export interface StatementQuery {
  readonly accountingBookId: string;
  readonly periodFrom?: string | undefined;
  readonly periodTo?: string | undefined;
  readonly comparativeFrom?: string | undefined;
  readonly comparativeTo?: string | undefined;
  readonly source?: BalanceSource | undefined;
  readonly reportDefinitionId?: string | undefined;
  /** REJECT refuses to present a statement with an account on no line (issue path). */
  readonly unmappedPolicy?: UnmappedPolicy | undefined;
  readonly cashFlowWindow?: 'PERIOD' | 'YEAR_TO_DATE' | undefined;
  /**
   * Whether to compare against `/reports/trial-balance`. Default true, because
   * exit criterion 1 is not something a caller should have to opt into. Set false
   * only where the comparison has already been made — the report-run executor
   * makes it once for the set rather than three times for three statements.
   */
  readonly reconcile?: boolean | undefined;
}

interface Composed {
  readonly loaded: LoadedTrialBalance;
  readonly definition: LoadedDefinition | null;
  readonly profitAndLossLines: ProfitAndLossLineSpec[] | undefined;
  readonly balanceSheetLines: BalanceSheetLineSpec[] | undefined;
  readonly retainedEarningsMethod: RetainedEarningsMethod;
  readonly drill: DrillBuilder;
}

export class StatementsService {
  constructor(
    private readonly pool: Pool,
    /**
     * The Phase 2 trial balance, injected rather than reimplemented.
     *
     * It is the OTHER implementation — the thing exit criterion 1 requires the
     * statements to tie to. Reading it through the same class the
     * `/reports/trial-balance` route reads it through is what makes the
     * comparison meaningful; a private copy of its query would compare this
     * package with itself.
     */
    private readonly ledgerReports: LedgerReportsService,
  ) {}

  // -------------------------------------------------------------------------
  // The three statements
  // -------------------------------------------------------------------------

  async profitAndLoss(principal: TenantPrincipal, query: StatementQuery) {
    const { composed, reconciliation } = await this.prepare(principal, query);
    const statement = composeProfitAndLoss({
      rows: composed.loaded.rows,
      ...(composed.profitAndLossLines ? { lines: composed.profitAndLossLines } : {}),
      unmappedPolicy: query.unmappedPolicy ?? 'REPORT',
    });

    const columns = ['period', 'comparative', 'year_to_date'] as const;
    const amountOf = amountResolver(
      statement.sections.flatMap((s) => s.lines),
      (line, column) =>
        column === 'period'
          ? line.amounts.period
          : column === 'comparative'
            ? line.amounts.comparative
            : line.amounts.yearToDate,
    );

    return {
      ...this.envelope(composed, reconciliation),
      profit_and_loss: wire.profitAndLoss(statement, composed.drill),
      rows: composed.definition ? presentRows(composed.definition, [...columns], amountOf) : null,
      ties: engineTies(composed, statement.result.yearToDate),
      exceptions: statement.exceptions.map(wire.exception),
      criterion: criterion(reconciliation, statement.definitionIsComplete, null),
    };
  }

  async balanceSheet(principal: TenantPrincipal, query: StatementQuery) {
    const { composed, reconciliation } = await this.prepare(principal, query);
    const statement = composeBalanceSheet({
      rows: composed.loaded.rows,
      retainedEarningsMethod: composed.retainedEarningsMethod,
      ...(composed.balanceSheetLines ? { lines: composed.balanceSheetLines } : {}),
      unmappedPolicy: query.unmappedPolicy ?? 'REPORT',
    });

    const columns = ['opening', 'movement', 'closing'] as const;
    const amountOf = amountResolver(
      statement.sections.flatMap((s) => s.lines),
      (line, column) =>
        column === 'opening'
          ? line.amounts.opening
          : column === 'movement'
            ? line.amounts.movement
            : line.amounts.closing,
    );

    return {
      ...this.envelope(composed, reconciliation),
      balance_sheet: wire.balanceSheet(statement, composed.drill),
      rows: composed.definition ? presentRows(composed.definition, [...columns], amountOf) : null,
      balances: statement.balances,
      exceptions: statement.exceptions.map(wire.exception),
      criterion: criterion(reconciliation, statement.definitionIsComplete, null),
    };
  }

  async cashFlow(principal: TenantPrincipal, query: StatementQuery) {
    const { composed, reconciliation } = await this.prepare(principal, query);
    const rows = cashFlowRows(composed.loaded);
    const statement = composeCashFlow({
      rows,
      window: query.cashFlowWindow ?? 'PERIOD',
      unclassifiedPolicy: query.unmappedPolicy ?? 'REPORT',
    });

    // Gate E's "beginning cash + movement = ending cash" has no subject unless
    // some account is marked cash. A cash flow over an empty set of cash accounts
    // reconciles 0 against 0 and reports success about something it never
    // measured, so `measured` says whether there was anything to measure.
    const cashAccountCount = composed.loaded.rows.filter((r) => r.account.isCash === true).length;
    const measured = cashAccountCount > 0;

    return {
      ...this.envelope(composed, reconciliation),
      cash_flow: {
        ...wire.cashFlow(statement, composed.drill),
        measured,
        cash_account_count: cashAccountCount,
        declared_method: composed.definition?.cashFlowMethod ?? null,
        overrides_applied: composed.loaded.overrides.map((o) => ({
          account_id: o.accountId,
          classification: o.classification,
          line_count: o.lineCount,
          reason: o.reason,
          period_debit: o.period.debit.toString(),
          period_credit: o.period.credit.toString(),
          year_to_date_debit: o.yearToDate.debit.toString(),
          year_to_date_credit: o.yearToDate.credit.toString(),
        })),
      },
      exceptions: [
        ...statement.exceptions.map(wire.exception),
        ...(measured
          ? []
          : [
              {
                code: 'CASH_FLOW_NO_CASH_ACCOUNTS',
                message:
                  `No account in this entity is marked as cash or a cash equivalent, so the ` +
                  `statement's opening cash, closing cash and movement are all zero and its ` +
                  `reconciliation compares nothing with nothing. Set accounts.is_cash_equivalent ` +
                  `on the bank, cash-on-hand and cash-equivalent accounts before reading this.`,
                account_id: null,
                account_code: null,
                amount: null,
              },
            ]),
        ...(composed.definition?.cashFlowMethod === 'INDIRECT'
          ? [
              {
                code: 'CASH_FLOW_METHOD_NOT_IMPLEMENTED',
                message:
                  `Report definition ${composed.definition.code} v${composed.definition.version} ` +
                  `declares the INDIRECT method. This engine composes the classification-based ` +
                  `DIRECT method (doc 12's initial method, ADR-0001), and the figures below are ` +
                  `direct figures. They are NOT an indirect presentation and must not be ` +
                  `published as one.`,
                account_id: null,
                account_code: null,
                amount: null,
              },
            ]
          : []),
      ],
      criterion: criterion(reconciliation, true, {
        name: 'Cash Flow reconciles: beginning cash + movement = ending cash',
        satisfied: measured && statement.reconciles,
        measured,
      }),
    };
  }

  /**
   * All three statements plus the tie checks, from ONE trial balance load.
   *
   * What a financial snapshot and a report run need: composing the three
   * separately would read the ledger three times, and three reads of a live
   * ledger are three slightly different moments. A snapshot assembled from three
   * moments is not reproducible, which is exactly what Gate E requires of it.
   */
  async financialStatements(principal: TenantPrincipal, query: StatementQuery) {
    const { composed, reconciliation } = await this.prepare(principal, query);
    const statements = composeFinancialStatements({
      rows: composed.loaded.rows,
      retainedEarningsMethod: composed.retainedEarningsMethod,
      ...(composed.profitAndLossLines ? { profitAndLossLines: composed.profitAndLossLines } : {}),
      ...(composed.balanceSheetLines ? { balanceSheetLines: composed.balanceSheetLines } : {}),
      cashFlowWindow: query.cashFlowWindow ?? 'PERIOD',
      unmappedPolicy: query.unmappedPolicy ?? 'REPORT',
    });
    // The cash flow is recomposed over the override-split rows. Nothing else
    // changes: the split is exact, so the totals are the same totals.
    const cashFlow = composeCashFlow({
      rows: cashFlowRows(composed.loaded),
      window: query.cashFlowWindow ?? 'PERIOD',
      unclassifiedPolicy: query.unmappedPolicy ?? 'REPORT',
    });

    const cashAccountCount = composed.loaded.rows.filter((r) => r.account.isCash === true).length;

    return {
      ...this.envelope(composed, reconciliation),
      ...wire.financialStatements(statements, composed.drill),
      cash_flow: {
        ...wire.cashFlow(cashFlow, composed.drill),
        measured: cashAccountCount > 0,
        cash_account_count: cashAccountCount,
      },
      criterion: criterion(reconciliation, statements.tiesExactly, {
        name: 'Core statements tie exactly to Trial Balance',
        satisfied: (reconciliation.ties ?? false) && statements.tiesExactly,
        measured: reconciliation.checked,
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------

  private async prepare(
    principal: TenantPrincipal,
    query: StatementQuery,
  ): Promise<{
    composed: Composed;
    reconciliation: TrialBalanceReconciliation | TrialBalanceReconciliationSkipped;
  }> {
    const composed = await readInTenant(this.pool, principal, async ({ client }) => {
      const book = await loadBookScope(client, principal.tenantId, query.accountingBookId);
      assertEntityPermission(principal, 'report.view', book.legalEntityId);
      return this.compose(client, principal, query);
    });

    if (query.reconcile === false) {
      return {
        composed,
        reconciliation: {
          checked: false,
          ties: null,
          message:
            'The comparison against /reports/trial-balance was not run for this response ' +
            '(reconcile=false). Nothing below asserts that these statements tie to the trial ' +
            'balance.',
        },
      };
    }

    // A separate transaction, because it is a separate implementation reached
    // through its own service. The window it resolves is compared with the one
    // these statements used, so two reads of two different sets of months cannot
    // agree by accident.
    const ledger = (await this.ledgerReports.trialBalance(principal, {
      accountingBookId: query.accountingBookId,
      periodFrom: query.periodFrom,
      periodTo: query.periodTo,
      source: composed.loaded.source,
      includeZero: true,
    })) as unknown as LedgerTrialBalanceResult;

    return {
      composed,
      reconciliation: reconcileToTrialBalance({
        statementRows: composed.loaded.rows,
        ledger,
        statementPeriodFrom: composed.loaded.window.from,
        statementPeriodTo: composed.loaded.window.to,
      }),
    };
  }

  private async compose(
    client: PoolClient,
    principal: TenantPrincipal,
    query: StatementQuery,
  ): Promise<Composed> {
    const loaded = await loadTrialBalance(client, principal.tenantId, {
      accountingBookId: query.accountingBookId,
      periodFrom: query.periodFrom ?? null,
      periodTo: query.periodTo ?? null,
      comparativeFrom: query.comparativeFrom ?? null,
      comparativeTo: query.comparativeTo ?? null,
      ...(query.source ? { source: query.source } : {}),
    });

    let definition: LoadedDefinition | null = null;
    let profitAndLossLines: ProfitAndLossLineSpec[] | undefined;
    let balanceSheetLines: BalanceSheetLineSpec[] | undefined;

    if (query.reportDefinitionId) {
      const accounts: DefinitionAccount[] = loaded.rows.map((row) => ({
        accountId: row.account.accountId,
        code: row.account.code,
        name: row.account.name,
        accountType: row.account.accountType,
        groupCode: row.account.groupCode ?? null,
      }));
      definition = await loadDefinition(
        client,
        principal.tenantId,
        query.reportDefinitionId,
        accounts,
      );
      if (
        definition.legalEntityId !== null &&
        definition.legalEntityId !== loaded.book.legalEntityId
      ) {
        throw new AppError(
          'CROSS_ENTITY_REFERENCE',
          `Report definition ${definition.code} v${definition.version} is scoped to a different ` +
            `legal entity than accounting book ${loaded.book.bookId}. A statement rendered under ` +
            `it would present one entity's accounts under another's headings.`,
          { details: { definition_id: definition.id, book_id: loaded.book.bookId } },
        );
      }
      const typeOf = (accountId: string) =>
        accounts.find((a) => a.accountId === accountId)?.accountType;
      if (definition.reportType === 'PROFIT_LOSS') {
        profitAndLossLines = profitAndLossLineSpecs(definition, typeOf);
      } else if (definition.reportType === 'BALANCE_SHEET') {
        balanceSheetLines = balanceSheetLineSpecs(definition, typeOf);
      }
    }

    const retainedEarningsMethod: RetainedEarningsMethod =
      definition?.retainedEarningsMethod ?? loaded.policy.retainedEarningsMethod;

    /**
     * One drill token per column the statement shows.
     *
     * The windows differ per column and that is the entire point: a period figure
     * is explained by the lines inside the window, a year-to-date figure by the
     * lines since the fiscal year began, a closing balance by every line up to the
     * window's end, and an opening balance by every line before it began. One
     * token beside all four explains one of them and mis-explains the other three
     * — which reads exactly like a correct drill and is not one.
     */
    const token = (
      explains: string,
      from: string | null,
      to: string,
      accountIds: readonly string[],
      rowNo: number | null,
    ): DrillToken => ({
      explains,
      accounting_book_id: loaded.book.bookId,
      period_from: from,
      period_to: to,
      account_ids: accountIds,
      report_definition_id: definition?.id ?? null,
      row_no: rowNo,
    });

    const windows: Array<[string, string | null, string]> = [
      ['period', loaded.window.from, loaded.window.to],
      ['movement', loaded.window.from, loaded.window.to],
      ['year_to_date', loaded.fiscalYearFrom, loaded.window.to],
      ['closing', null, loaded.window.to],
      ['opening', null, loaded.openingTo],
      ...(loaded.comparativeWindow
        ? ([['comparative', loaded.comparativeWindow.from, loaded.comparativeWindow.to]] as Array<
            [string, string | null, string]
          >)
        : []),
    ];

    const drill: DrillBuilder = (accountIds, rowNo) =>
      Object.fromEntries(
        windows.map(([explains, from, to]) => [
          explains,
          token(explains, from, to, accountIds, rowNo),
        ]),
      );

    return {
      loaded,
      definition,
      profitAndLossLines,
      balanceSheetLines,
      retainedEarningsMethod,
      drill,
    };
  }

  private envelope(
    composed: Composed,
    reconciliation: TrialBalanceReconciliation | TrialBalanceReconciliationSkipped,
  ) {
    return {
      accounting_book_id: composed.loaded.book.bookId,
      legal_entity_id: composed.loaded.book.legalEntityId,
      base_currency: composed.loaded.book.baseCurrency,
      source: composed.loaded.source,
      period_from: composed.loaded.window.from,
      period_to: composed.loaded.window.to,
      comparative_period_from: composed.loaded.comparativeWindow?.from ?? null,
      comparative_period_to: composed.loaded.comparativeWindow?.to ?? null,
      retained_earnings_method: composed.retainedEarningsMethod,
      retained_earnings_method_source: composed.definition?.retainedEarningsMethod
        ? 'REPORT_DEFINITION'
        : 'ACCOUNTING_POLICY',
      report_definition: composed.definition
        ? {
            id: composed.definition.id,
            code: composed.definition.code,
            name: composed.definition.name,
            version: composed.definition.version,
            report_type: composed.definition.reportType,
            rounding_display_unit: composed.definition.roundingDisplayUnit,
            exclusions: composed.definition.exclusions,
            exceptions: composed.definition.exceptions,
          }
        : null,
      trial_balance: wire.trialBalanceTotals(engineTrialBalanceTotals(composed.loaded.rows)),
      reconciliation,
    };
  }
}

// ---------------------------------------------------------------------------

/** Reads a composed line's amount for a definition row and a column. */
function amountResolver<S extends string, A>(
  lines: ReadonlyArray<StatementLine<S, A>>,
  pick: (line: StatementLine<S, A>, column: string) => Decimal | null,
): (rowNo: number, column: string) => Decimal | null {
  const byCode = new Map(lines.map((line) => [line.code, line]));
  return (rowNo, column) => {
    const line = byCode.get(lineCodeFor(rowNo));
    // A row that resolved to no account has no composed line. Zero rather than
    // null: the row genuinely holds nothing, the exception in the definition
    // block says so, and a null would poison every subtotal that references it.
    if (line === undefined) return Decimal.zero(MONEY_SCALE);
    return pick(line, column);
  };
}

/**
 * The composed result against the trial balance rows, by a path that does not go
 * through the line mapping.
 *
 * The whole point of computing it twice: if the definition dropped an account or
 * counted one on two lines, this is the number that disagrees. Summing the raw
 * credit and debit columns is not "composing a statement" — no account type is
 * consulted and no section is formed; it is the trial balance's own arithmetic.
 */
function engineTies(composed: Composed, resultYearToDate: Decimal) {
  const fromRows = composed.loaded.rows
    .filter((r) => r.account.accountType === 'REVENUE' || r.account.accountType === 'EXPENSE')
    .reduce<Decimal>(
      (acc, r) => acc.add(r.yearToDate.credit).sub(r.yearToDate.debit),
      Decimal.zero(MONEY_SCALE),
    );
  const difference = resultYearToDate.sub(fromRows);
  return [
    {
      name: 'PROFIT_AND_LOSS_TIES_TO_TRIAL_BALANCE',
      description:
        'composed year-to-date result against revenue less expense in the loaded trial balance',
      expected: fromRows.toString(),
      actual: resultYearToDate.toString(),
      difference: difference.toString(),
      ties: difference.isZero(),
    },
  ];
}

/**
 * The criterion, answered, with `measured` beside it.
 *
 * `satisfied` can only be true when the comparison actually ran. A green result
 * from a check that was skipped is worse than a red one, because nothing
 * downstream can tell the two apart.
 */
function criterion(
  reconciliation: TrialBalanceReconciliation | TrialBalanceReconciliationSkipped,
  engineComplete: boolean,
  extra: { name: string; satisfied: boolean; measured: boolean } | null,
) {
  const base = {
    name: 'Core statements tie exactly to Trial Balance',
    measured: reconciliation.checked,
    ties_to_trial_balance: reconciliation.ties,
    definition_is_complete: engineComplete,
    satisfied: reconciliation.checked && reconciliation.ties === true && engineComplete,
    message: reconciliation.message,
  };
  return extra === null ? base : { ...base, additional: extra };
}
