/**
 * Loading the trial balance the statement engine composes from.
 *
 * This file does arithmetic in exactly one sense: it SUMS posted debit and credit
 * columns into the four windows a statement needs. It never nets them, never
 * signs them by account type, never decides what a line is worth and never
 * computes a total a statement presents. All of that is
 * `@acct/domain/statements`, and it is there rather than here because two
 * implementations of the same statement is two answers — and the second one is
 * always discovered at a close, by an accountant, in a report someone signed.
 *
 * The four windows, and why all four are loaded rather than derived:
 *
 *   opening        everything before the window, the balance brought forward
 *   period         movement inside the window
 *   year to date   movement from the first day of the fiscal year that contains
 *                  the window's LAST period, to the end of the window
 *   comparative    movement in a second, caller-chosen window (doc 12)
 *
 * `yearToDate` cannot be derived from the other three. Under the DERIVED
 * retained-earnings method (ADR-0001 §2) a profit-and-loss account's closing
 * balance is its life-to-date result, and the difference between that and the
 * year-to-date result is precisely the prior years. A balance sheet that reads
 * the closing balance as "this year's profit" overstates the current-year line by
 * every prior year the book has run, and it does so silently because the sheet
 * still balances.
 *
 * The period window itself comes from `report_period_window_bounds` (0053) and
 * nowhere else. That function is also what refuses a discontiguous window — one
 * that skips an adjustment period the ledger orders inside it — over which
 * opening, movement and closing have no consistent meaning at all.
 */

import type { PoolClient } from 'pg';
import {
  AppError,
  D,
  Decimal,
  MONEY_SCALE,
  notFound,
  type AccountTypeCode,
  type NormalBalance,
} from '@acct/domain';
import type {
  CashFlowClassification,
  EquityRole,
  RetainedEarningsMethod,
  StatementAccount,
  TrialBalanceRow,
  TrialBalanceWindow,
} from '@acct/domain';

export type BalanceSource = 'projection' | 'journal_lines';

const ZERO = Decimal.zero(MONEY_SCALE);

/** A debit/credit pair as it comes out of SQL, before anything is decided about it. */
interface RawWindow {
  readonly debit: string;
  readonly credit: string;
}

export interface ResolvedWindow {
  readonly periodIds: readonly string[];
  readonly firstOrdinal: number;
  readonly lastOrdinal: number;
  readonly from: string;
  readonly to: string;
}

export interface BookScope {
  readonly bookId: string;
  readonly legalEntityId: string;
  readonly organizationId: string;
  readonly baseCurrency: string;
}

export interface AccountingPolicySnapshot {
  readonly retainedEarningsMethod: RetainedEarningsMethod;
  readonly retainedEarningsAccountId: string | null;
  readonly currentYearEarningsAccountId: string | null;
}

/** One account's line-level cash-flow override totals, per classification. */
export interface CashFlowOverrideTotals {
  readonly accountId: string;
  readonly classification: CashFlowClassification;
  readonly period: TrialBalanceWindow;
  readonly yearToDate: TrialBalanceWindow;
  readonly lineCount: number;
  readonly reason: string;
}

export interface LoadedTrialBalance {
  readonly book: BookScope;
  readonly policy: AccountingPolicySnapshot;
  readonly source: BalanceSource;
  readonly window: ResolvedWindow;
  readonly comparativeWindow: ResolvedWindow | null;
  readonly fiscalYearFirstOrdinal: number;
  /** First day of the fiscal year the window closes in — where year-to-date starts. */
  readonly fiscalYearFrom: string;
  /** Last day before the window — where the opening balance is measured. */
  readonly openingTo: string;
  readonly rows: readonly TrialBalanceRow[];
  readonly overrides: readonly CashFlowOverrideTotals[];
}

function money(value: string): Decimal {
  // Deliberately D(...) and never Number(...): every one of these is a
  // numeric(24,8) rendered as text by the driver, and a float conversion loses
  // the cent that a statement is supposed to tie to (ADR-0006 §1).
  return D(value, MONEY_SCALE);
}

const windowOf = (raw: RawWindow): TrialBalanceWindow => ({
  debit: money(raw.debit),
  credit: money(raw.credit),
});

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

export async function loadBookScope(
  client: PoolClient,
  tenantId: string,
  bookId: string,
): Promise<BookScope> {
  const { rows } = await client.query<{
    id: string;
    legal_entity_id: string;
    organization_id: string;
    base_currency: string;
  }>(
    `SELECT b.id, b.legal_entity_id, e.organization_id, b.base_currency
       FROM accounting_books b
       JOIN legal_entities e ON e.id = b.legal_entity_id
      WHERE b.id = $1 AND b.tenant_id = $2`,
    [bookId, tenantId],
  );
  const book = rows[0];
  if (!book) throw notFound('Accounting book', bookId);
  return {
    bookId: book.id,
    legalEntityId: book.legal_entity_id,
    organizationId: book.organization_id,
    baseCurrency: book.base_currency,
  };
}

/**
 * The effective accounting policy, selected the same way the posting service
 * selects it: a book-specific policy beats the entity default, later versions
 * beat earlier ones, and the row must be valid on the date asked about.
 *
 * Same selection, deliberately, so a statement and the journals it reports on
 * cannot disagree about which retained-earnings method the book uses.
 */
export async function loadAccountingPolicy(
  client: PoolClient,
  book: BookScope,
  on: string,
): Promise<AccountingPolicySnapshot> {
  const { rows } = await client.query<{
    retained_earnings_method: RetainedEarningsMethod | null;
    retained_earnings_account_id: string | null;
    current_year_earnings_account_id: string | null;
  }>(
    `SELECT ap.retained_earnings_method,
            ap.retained_earnings_account_id,
            ap.current_year_earnings_account_id
       FROM accounting_policies ap
      WHERE ap.legal_entity_id = $1
        AND (ap.accounting_book_id = $2 OR ap.accounting_book_id IS NULL)
        AND ap.valid_from <= $3::date
        AND (ap.valid_to IS NULL OR ap.valid_to > $3::date)
      ORDER BY ap.accounting_book_id NULLS LAST, ap.version DESC
      LIMIT 1`,
    [book.legalEntityId, book.bookId, on],
  );
  const policy = rows[0];
  return {
    // 0003 defaults the column to DERIVED and ADR-0001 §2 makes that the shipped
    // choice, so an entity with no policy row is DERIVED rather than undefined.
    retainedEarningsMethod: policy?.retained_earnings_method ?? 'DERIVED',
    retainedEarningsAccountId: policy?.retained_earnings_account_id ?? null,
    currentYearEarningsAccountId: policy?.current_year_earnings_account_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * The validated reporting window, from 0053's single definition of one.
 *
 * Not re-derived here. `report_period_window_bounds` returns the period ids AND
 * the ordinal bounds from the same call, which is what stops the projection form
 * and the journal-line form of the balance query from selecting different months
 * while both look correct.
 */
export async function resolveWindow(
  client: PoolClient,
  legalEntityId: string,
  from: string | null,
  to: string | null,
): Promise<ResolvedWindow> {
  const { rows } = await client.query<{
    period_ids: string[] | null;
    first_ordinal: number | null;
    last_ordinal: number | null;
    period_from: string | null;
    period_to: string | null;
  }>(
    `SELECT period_ids, first_ordinal, last_ordinal,
            period_from::text AS period_from, period_to::text AS period_to
       FROM report_period_window_bounds($1::uuid, $2::date, $3::date)`,
    [legalEntityId, from, to],
  );
  const bounds = rows[0];
  if (
    !bounds ||
    bounds.period_ids === null ||
    bounds.first_ordinal === null ||
    bounds.last_ordinal === null ||
    bounds.period_from === null ||
    bounds.period_to === null
  ) {
    throw new AppError(
      'NO_PERIOD_FOR_DATE',
      `No accounting period falls between ${from ?? '(start of calendar)'} and ` +
        `${to ?? '(end of calendar)'}, so there is nothing to report on.`,
      { details: { legal_entity_id: legalEntityId, from, to } },
    );
  }
  return {
    periodIds: bounds.period_ids,
    firstOrdinal: bounds.first_ordinal,
    lastOrdinal: bounds.last_ordinal,
    from: bounds.period_from,
    to: bounds.period_to,
  };
}

/**
 * The ordinal of the first period of the fiscal year that contains the window's
 * last period — where "year to date" starts.
 *
 * Keyed on the LAST period rather than the first: a window that straddles a year
 * end reports the year the statement closes in, which is the year an equity
 * section is about. Reading it from the first period would report the prior
 * year's result on a statement dated in the new one.
 */
async function fiscalYearStart(
  client: PoolClient,
  legalEntityId: string,
  lastPeriodId: string,
): Promise<{ ordinal: number; from: string }> {
  const { rows } = await client.query<{ ordinal: number | null; from: string | null }>(
    `SELECT min(c.ordinal)::int AS ordinal, min(c.start_date)::text AS from
       FROM report_period_calendar($1::uuid) c
       JOIN accounting_periods p ON p.id = c.accounting_period_id
      WHERE p.fiscal_year_id = (SELECT fiscal_year_id FROM accounting_periods WHERE id = $2)`,
    [legalEntityId, lastPeriodId],
  );
  const ordinal = rows[0]?.ordinal;
  const from = rows[0]?.from;
  if (ordinal === null || ordinal === undefined || from === null || from === undefined) {
    throw new AppError(
      'NO_PERIOD_FOR_DATE',
      `The period ending this window belongs to no fiscal year, so year-to-date figures have no ` +
        `start. Rebuild the entity calendar before reporting on it.`,
      { details: { legal_entity_id: legalEntityId, period_id: lastPeriodId } },
    );
  }
  return { ordinal, from };
}

/**
 * The last day before the reporting window — where an opening balance is measured.
 *
 * Computed in UTC from the window's own start date, which is a plain `YYYY-MM-DD`
 * out of `date::text`. Local time is never involved, so the answer cannot shift by
 * a day depending on where the process runs — a one-day shift here would move a
 * month-end entry between the opening balance and the movement.
 */
function dayBefore(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const previous = new Date(Date.UTC(y, m - 1, d - 1));
  return previous.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// The balances
// ---------------------------------------------------------------------------

interface AccountBalanceRow {
  account_id: string;
  code: string;
  name: string;
  account_type: AccountTypeCode;
  normal_balance: NormalBalance;
  subtype: string | null;
  group_code: string | null;
  group_name: string | null;
  cash_flow_classification: CashFlowClassification | null;
  is_cash_equivalent: boolean;
  opening_debit: string;
  opening_credit: string;
  period_debit: string;
  period_credit: string;
  ytd_debit: string;
  ytd_credit: string;
  comparative_debit: string;
  comparative_credit: string;
}

/**
 * `is_cash_equivalent` is read defensively.
 *
 * 0053 adds the column, and this package refuses to compose a cash flow without
 * it rather than treating "no cash accounts" as "no cash movement" — a cash flow
 * over an empty set of cash accounts reconciles 0 against 0 and reports success
 * about something it never measured.
 */
const ACCOUNT_COLUMNS = `
  a.id AS account_id, a.code, a.name, a.account_type::text AS account_type,
  a.normal_balance::text AS normal_balance, a.subtype,
  g.code AS group_code, g.name AS group_name,
  a.cash_flow_classification, a.is_cash_equivalent`;

const ACCOUNT_GROUP_BY = `
  a.id, a.code, a.name, a.account_type, a.normal_balance, a.subtype, g.code, g.name,
  a.cash_flow_classification, a.is_cash_equivalent, a.is_posting, a.status`;

/**
 * An account is on the trial balance if it could carry a balance, or if it does.
 *
 * The second half is not redundant. An archived account, or one demoted to a
 * heading, still holds every amount ever posted to it; dropping it would produce
 * a trial balance that does not balance and a statement that silently loses the
 * money. So the filter is a HAVING over the summed columns rather than a WHERE
 * over the account's flags.
 */
const ACCOUNT_HAVING = `(a.is_posting AND a.status = 'ACTIVE')
   OR coalesce(sum(m.debit), 0) <> 0 OR coalesce(sum(m.credit), 0) <> 0`;

function balanceQuery(source: BalanceSource): string {
  const movements =
    source === 'journal_lines'
      ? `SELECT l.account_id, c.ordinal, l.base_debit AS debit, l.base_credit AS credit,
                false AS is_opening
           FROM journal_lines l
           JOIN journal_entries e ON e.id = l.journal_entry_id
           JOIN cal c ON c.accounting_period_id = l.accounting_period_id
          WHERE l.accounting_book_id = $2 AND e.status IN ('POSTED','REVERSED')`
      : // The projection carries an opening balance per period, so "everything
        // before the window" is the first in-window period's opening rather than a
        // sum of prior movement. Both forms are emitted as movement rows with an
        // `is_opening` marker so one set of FILTERs serves both sources.
        `SELECT b.account_id, c.ordinal, b.period_debit AS debit, b.period_credit AS credit,
                false AS is_opening
           FROM ledger_account_balances b
           JOIN cal c ON c.accounting_period_id = b.accounting_period_id
          WHERE b.accounting_book_id = $2
          UNION ALL
         SELECT b.account_id, c.ordinal, b.opening_debit, b.opening_credit, true
           FROM ledger_account_balances b
           JOIN cal c ON c.accounting_period_id = b.accounting_period_id
          WHERE b.accounting_book_id = $2`;

  const openingFilter =
    source === 'journal_lines'
      ? `NOT m.is_opening AND m.ordinal < $3::int`
      : `m.is_opening AND m.ordinal = $3::int`;

  return `
    WITH cal AS (
      SELECT accounting_period_id, ordinal FROM report_period_calendar($1::uuid)
    ),
    movements AS (${movements})
    SELECT ${ACCOUNT_COLUMNS},
           coalesce(sum(m.debit)  FILTER (WHERE ${openingFilter}), 0)::text AS opening_debit,
           coalesce(sum(m.credit) FILTER (WHERE ${openingFilter}), 0)::text AS opening_credit,
           coalesce(sum(m.debit)  FILTER (WHERE NOT m.is_opening
                                            AND m.ordinal BETWEEN $3::int AND $4::int), 0)::text
             AS period_debit,
           coalesce(sum(m.credit) FILTER (WHERE NOT m.is_opening
                                            AND m.ordinal BETWEEN $3::int AND $4::int), 0)::text
             AS period_credit,
           coalesce(sum(m.debit)  FILTER (WHERE NOT m.is_opening
                                            AND m.ordinal BETWEEN $5::int AND $4::int), 0)::text
             AS ytd_debit,
           coalesce(sum(m.credit) FILTER (WHERE NOT m.is_opening
                                            AND m.ordinal BETWEEN $5::int AND $4::int), 0)::text
             AS ytd_credit,
           coalesce(sum(m.debit)  FILTER (WHERE NOT m.is_opening AND $6::int IS NOT NULL
                                            AND m.ordinal BETWEEN $6::int AND $7::int), 0)::text
             AS comparative_debit,
           coalesce(sum(m.credit) FILTER (WHERE NOT m.is_opening AND $6::int IS NOT NULL
                                            AND m.ordinal BETWEEN $6::int AND $7::int), 0)::text
             AS comparative_credit
      FROM accounts a
      LEFT JOIN account_groups g ON g.id = a.group_id
      LEFT JOIN movements m ON m.account_id = a.id
     WHERE a.legal_entity_id = $1
     GROUP BY ${ACCOUNT_GROUP_BY}
    HAVING ${ACCOUNT_HAVING}
     ORDER BY a.code`;
}

export interface LoadTrialBalanceInput {
  readonly accountingBookId: string;
  readonly periodFrom?: string | null;
  readonly periodTo?: string | null;
  readonly comparativeFrom?: string | null;
  readonly comparativeTo?: string | null;
  readonly source?: BalanceSource;
}

export async function loadTrialBalance(
  client: PoolClient,
  tenantId: string,
  input: LoadTrialBalanceInput,
): Promise<LoadedTrialBalance> {
  const book = await loadBookScope(client, tenantId, input.accountingBookId);
  const source: BalanceSource = input.source ?? 'projection';

  const window = await resolveWindow(
    client,
    book.legalEntityId,
    input.periodFrom ?? null,
    input.periodTo ?? null,
  );
  const comparativeRequested = input.comparativeFrom != null || input.comparativeTo != null;
  const comparativeWindow = comparativeRequested
    ? await resolveWindow(
        client,
        book.legalEntityId,
        input.comparativeFrom ?? null,
        input.comparativeTo ?? null,
      )
    : null;

  const lastPeriodId = window.periodIds[window.periodIds.length - 1]!;
  const fiscalYear = await fiscalYearStart(client, book.legalEntityId, lastPeriodId);
  const fyFirst = fiscalYear.ordinal;
  const policy = await loadAccountingPolicy(client, book, window.to);

  const { rows } = await client.query<AccountBalanceRow>(balanceQuery(source), [
    book.legalEntityId,
    book.bookId,
    window.firstOrdinal,
    window.lastOrdinal,
    fyFirst,
    comparativeWindow?.firstOrdinal ?? null,
    comparativeWindow?.lastOrdinal ?? null,
  ]);

  const equityRoleOf = (accountId: string): EquityRole | null => {
    if (accountId === policy.retainedEarningsAccountId) return 'RETAINED_EARNINGS';
    if (accountId === policy.currentYearEarningsAccountId) return 'CURRENT_YEAR_EARNINGS';
    return null;
  };

  const trialBalanceRows: TrialBalanceRow[] = rows.map((row) => {
    const account: StatementAccount = {
      accountId: row.account_id,
      code: row.code,
      name: row.name,
      accountType: row.account_type,
      normalBalance: row.normal_balance,
      subtype: row.subtype,
      groupCode: row.group_code,
      groupName: row.group_name,
      equityRole: equityRoleOf(row.account_id),
      isCash: row.is_cash_equivalent,
      cashFlowClassification: row.cash_flow_classification,
    };
    return {
      account,
      opening: windowOf({ debit: row.opening_debit, credit: row.opening_credit }),
      period: windowOf({ debit: row.period_debit, credit: row.period_credit }),
      yearToDate: windowOf({ debit: row.ytd_debit, credit: row.ytd_credit }),
      comparative: comparativeWindow
        ? windowOf({ debit: row.comparative_debit, credit: row.comparative_credit })
        : null,
    };
  });

  const overrides = await loadCashFlowOverrideTotals(client, book, window, fyFirst);

  return {
    book,
    policy,
    source,
    window,
    comparativeWindow,
    fiscalYearFirstOrdinal: fyFirst,
    fiscalYearFrom: fiscalYear.from,
    openingTo: dayBefore(window.from),
    rows: trialBalanceRows,
    overrides,
  };
}

// ---------------------------------------------------------------------------
// Line-level cash-flow overrides (0053)
// ---------------------------------------------------------------------------

/**
 * doc 12's "controlled overrides", totalled per account and classification.
 *
 * 0053 records an override against a JOURNAL LINE, because a posted line is
 * immutable and the classification is least likely to be known at posting time.
 * The statement engine's cash flow classifies an ACCOUNT. The two models are not
 * the same shape, and the gap is not papered over here: an account whose lines
 * are overridden is SPLIT into one engine row per effective classification, with
 * the residual — the account's movement less the overridden lines — carrying the
 * account's own configured classification. The split is exact, so the sections
 * still sum to the movement in cash.
 *
 * Always read from journal lines, whatever `source` the balances came from: an
 * override is a fact about a line, and the projection has no lines in it.
 */
async function loadCashFlowOverrideTotals(
  client: PoolClient,
  book: BookScope,
  window: ResolvedWindow,
  fiscalYearFirst: number,
): Promise<CashFlowOverrideTotals[]> {
  const { rows } = await client.query<{
    account_id: string;
    classification: CashFlowClassification;
    period_debit: string;
    period_credit: string;
    ytd_debit: string;
    ytd_credit: string;
    line_count: number;
    reason: string;
  }>(
    `WITH cal AS (
       SELECT accounting_period_id, ordinal FROM report_period_calendar($1::uuid)
     ),
     overridden AS (
       SELECT l.account_id, o.classification, c.ordinal,
              l.base_debit, l.base_credit, o.reason
         FROM cash_flow_overrides o
         JOIN journal_lines l ON l.id = o.journal_line_id
         JOIN journal_entries e ON e.id = l.journal_entry_id
         JOIN cal c ON c.accounting_period_id = l.accounting_period_id
        WHERE l.accounting_book_id = $2
          AND e.status IN ('POSTED','REVERSED')
          AND c.ordinal BETWEEN least($3::int, $4::int) AND $5::int
     )
     SELECT account_id, classification,
            coalesce(sum(base_debit)  FILTER (WHERE ordinal BETWEEN $3::int AND $5::int), 0)::text
              AS period_debit,
            coalesce(sum(base_credit) FILTER (WHERE ordinal BETWEEN $3::int AND $5::int), 0)::text
              AS period_credit,
            coalesce(sum(base_debit)  FILTER (WHERE ordinal BETWEEN $4::int AND $5::int), 0)::text
              AS ytd_debit,
            coalesce(sum(base_credit) FILTER (WHERE ordinal BETWEEN $4::int AND $5::int), 0)::text
              AS ytd_credit,
            count(*)::int AS line_count,
            min(reason) AS reason
       FROM overridden
      GROUP BY account_id, classification
      ORDER BY account_id, classification`,
    [book.legalEntityId, book.bookId, window.firstOrdinal, fiscalYearFirst, window.lastOrdinal],
  );

  return rows.map((row) => ({
    accountId: row.account_id,
    classification: row.classification,
    period: windowOf({ debit: row.period_debit, credit: row.period_credit }),
    yearToDate: windowOf({ debit: row.ytd_debit, credit: row.ytd_credit }),
    lineCount: row.line_count,
    reason: row.reason,
  }));
}

/**
 * The engine rows a cash flow is composed from: the trial balance, with every
 * overridden account split into its effective classifications.
 *
 * Exact by construction and checked rather than assumed. The residual is the
 * account's window movement less the overridden lines, and a NEGATIVE residual
 * column is refused: it means the overridden lines sum to more than the balances
 * say the account moved, which happens when the balance source is a projection
 * that has fallen behind the journal lines the overrides were read from. Absorbed
 * silently it would move money between cash-flow sections; named, it is a stale
 * projection and the caller can rebuild it or re-run against journal_lines.
 */
export function cashFlowRows(loaded: LoadedTrialBalance): readonly TrialBalanceRow[] {
  if (loaded.overrides.length === 0) return loaded.rows;

  const byAccount = new Map<string, CashFlowOverrideTotals[]>();
  for (const override of loaded.overrides) {
    const list = byAccount.get(override.accountId);
    if (list) list.push(override);
    else byAccount.set(override.accountId, [override]);
  }

  const out: TrialBalanceRow[] = [];
  for (const row of loaded.rows) {
    const overrides = byAccount.get(row.account.accountId);
    if (overrides === undefined) {
      out.push(row);
      continue;
    }

    const subtract = (
      total: TrialBalanceWindow,
      parts: readonly TrialBalanceWindow[],
      label: string,
    ): TrialBalanceWindow => {
      const debit = parts.reduce<Decimal>((acc, p) => acc.sub(p.debit), total.debit);
      const credit = parts.reduce<Decimal>((acc, p) => acc.sub(p.credit), total.credit);
      if (debit.isNegative() || credit.isNegative()) {
        throw new AppError(
          'VALIDATION_FAILED',
          `CASH_FLOW_OVERRIDE_EXCEEDS_BALANCE: account ${row.account.code} ${row.account.name} ` +
            `has cash-flow overrides on journal lines totalling more than its ${label} movement ` +
            `in the ${loaded.source} balances (${debit.toString()} / ${credit.toString()} ` +
            `remaining). The overrides are read from journal lines and the balances from the ` +
            `projection, so the projection is behind the ledger. Rebuild it, or ask for this ` +
            `report with source=journal_lines.`,
          {
            details: {
              account_id: row.account.accountId,
              account_code: row.account.code,
              window: label,
              source: loaded.source,
            },
          },
        );
      }
      return { debit, credit };
    };

    const residualPeriod = subtract(
      row.period,
      overrides.map((o) => o.period),
      'period',
    );
    const residualYtd = subtract(
      row.yearToDate,
      overrides.map((o) => o.yearToDate),
      'year-to-date',
    );

    // The residual keeps the real account id, so a drill from a cash flow line
    // still names an account that exists. Only the override slices are synthetic,
    // and they carry the real id in their code so the reader can find it.
    out.push({
      account: row.account,
      opening: row.opening,
      period: residualPeriod,
      yearToDate: residualYtd,
      comparative: row.comparative ?? null,
    });

    for (const override of overrides) {
      out.push({
        account: {
          ...row.account,
          accountId: `${row.account.accountId}:${override.classification}`,
          code: row.account.code,
          name: `${row.account.name} (${override.lineCount} line(s) reclassified to ${
            override.classification
          }: ${override.reason})`,
          cashFlowClassification: override.classification,
          // An override never applies to a cash account (0053 refuses it), and an
          // override slice is never an equity role — both would double-count.
          isCash: false,
          equityRole: null,
        },
        opening: { debit: ZERO, credit: ZERO },
        period: override.period,
        yearToDate: override.yearToDate,
        comparative: row.comparative ? { debit: ZERO, credit: ZERO } : null,
      });
    }
  }
  return out;
}

/** The real account behind a cash-flow row id, synthetic or not. */
export function realAccountId(accountId: string): string {
  const colon = accountId.indexOf(':');
  return colon === -1 ? accountId : accountId.slice(0, colon);
}
