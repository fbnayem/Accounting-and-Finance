'use client';

import { useState } from 'react';
import { api } from '../../../lib/api';
import {
  Button,
  DataTable,
  ErrorBanner,
  Field,
  Notice,
  PageHeader,
  Status,
  useResource,
} from '../../../components/ui';
import { useHeldPermissions, useIdempotencyKeys } from '../../../components/document-lines';
import { Money, SummaryList, enumOptions, today, useMinorUnits } from '../../../components/phase5';

interface Budget {
  id: string;
  legal_entity_id: string;
  accounting_book_id: string;
  fiscal_year_id: string;
  name: string;
  version: number;
  scenario: string | null;
  currency: string;
  status: string;
  control_policy: string;
  control_threshold_pct: string | null;
  supersedes_budget_id: string | null;
  total_amount: string;
  line_count: number;
}

interface VarianceRow {
  account_id: string;
  account_code: string;
  account_name: string;
  accounting_period_id: string;
  period_name: string;
  period_no: number;
  budget_amount: string;
  actual_amount: string;
  open_commitments: string;
  variance: string;
  consumed_pct: string | null;
}

interface PeriodRollup {
  accounting_period_id: string;
  period_name: string;
  period_no: number;
  budget_amount: string;
  actual_amount: string;
  variance: string;
  open_commitments: string;
}

interface Variance {
  budget_id: string;
  name: string;
  version: number;
  status: string;
  budget_currency: string;
  actuals_currency: string | null;
  source: string;
  data: VarianceRow[];
  by_period: PeriodRollup[];
  totals: {
    budget_amount: string;
    actual_amount: string;
    variance: string;
    open_commitments: string;
  };
}

interface ControlResult {
  budget_id: string | null;
  budget_name: string | null;
  budget_version: number | null;
  policy: string;
  decision: string;
  approved_budget: string;
  actual_posted: string;
  open_commitments: string;
  pending_approved_spend: string;
  available: string;
  proposed_spend: string;
  available_after: string;
  over_budget: boolean;
  over_budget_by: string;
  warn_threshold_pct: string | null;
  explanation: string;
  source: string;
}

interface Forecast {
  id: string;
  name: string;
  scenario: string | null;
  as_of_date: string;
  currency: string;
  fiscal_year_id: string;
  total_amount?: string;
  line_count?: number;
}

interface PlanLine {
  key: string;
  accounting_period_id: string;
  account_id: string;
  amount: string;
}

const POLICIES = ['INFORMATIONAL', 'WARN', 'BLOCK', 'REQUIRE_OVERRIDE'];
const STATUSES = ['DRAFT', 'REVIEW', 'APPROVED', 'ACTIVE', 'SUPERSEDED', 'CLOSED'];

const newPlanLine = (): PlanLine => ({
  key: globalThis.crypto?.randomUUID?.() ?? `plan-${Math.random().toString(36).slice(2)}`,
  accounting_period_id: '',
  account_id: '',
  amount: '',
});

/**
 * Budgets, variance and budget control — doc 10.
 *
 * Doc 10's formula is
 *
 *   Available = Approved Budget − Actual Posted − Open Commitments − Pending Approved Spend
 *
 * and every one of those four terms is named on this screen, because a refusal a
 * user cannot reconstruct is a refusal they will work around. The check panel
 * shows the server's own evaluation — the same arithmetic the spending routes
 * run inside their transaction — so "blocked" arrives with the numbers that
 * blocked it rather than as a verdict.
 *
 * Actuals are read from posted journal lines every time (`source: journal_lines`,
 * Phase 5 exit criterion 6). Nothing here stores or re-adds a total: a budget
 * with a currency other than the book's base is shown as a mismatch rather than
 * silently compared, because this screen converts nothing.
 *
 * An approved budget is never overwritten. A change is a revision, which creates
 * a new version and supersedes the old one — which is why both are listed.
 */
export default function BudgetsPage() {
  const held = useHeldPermissions();
  const can = (permission: string) => !held || held.has(permission);
  const keys = useIdempotencyKeys();
  const units = useMinorUnits();

  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');

  const books = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; base_currency: string }[] }>(
            '/accounting-books',
            {
              query: { legal_entity_id: entityId },
            },
          )
        : Promise.resolve({ data: [] as { id: string; code: string; base_currency: string }[] }),
    [entityId],
  );
  const [bookId, setBookId] = useState('');
  const book = (books.data?.data ?? []).find((b) => b.id === bookId) ?? books.data?.data[0];

  const years = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; name: string }[] }>('/fiscal-years', {
            query: { legal_entity_id: entityId },
          })
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    [entityId],
  );
  const [fiscalYearId, setFiscalYearId] = useState('');

  const periods = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; name: string; fiscal_year_id: string; status: string }[] }>(
            '/accounting-periods',
            { query: { legal_entity_id: entityId } },
          )
        : Promise.resolve({
            data: [] as { id: string; name: string; fiscal_year_id: string; status: string }[],
          }),
    [entityId],
  );
  const periodOptions = (periods.data?.data ?? [])
    .filter((p) => !fiscalYearId || p.fiscal_year_id === fiscalYearId)
    .map((p) => ({ value: p.id, label: p.name }));

  const accounts = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; name: string }[] }>('/accounts', {
            query: { legal_entity_id: entityId, posting_only: 'true' },
          })
        : Promise.resolve({ data: [] as { id: string; code: string; name: string }[] }),
    [entityId],
  );
  const accountOptions = (accounts.data?.data ?? []).map((a) => ({
    value: a.id,
    label: `${a.code} — ${a.name}`,
  }));

  const [statusFilter, setStatusFilter] = useState('');
  const budgets = useResource(
    () =>
      api<{ data: Budget[] }>('/budgets', {
        query: {
          legal_entity_id: entityId,
          accounting_book_id: bookId,
          fiscal_year_id: fiscalYearId,
          status: statusFilter,
        },
      }),
    [entityId, bookId, fiscalYearId, statusFilter],
  );

  const [openId, setOpenId] = useState<string | null>(null);
  const variance = useResource(
    () => (openId ? api<Variance>(`/budgets/${openId}/variance`) : Promise.resolve(null)),
    [openId],
  );

  const forecasts = useResource(
    () =>
      api<{ data: Forecast[] }>('/forecasts', {
        query: {
          legal_entity_id: entityId,
          accounting_book_id: bookId,
          fiscal_year_id: fiscalYearId,
        },
      }),
    [entityId, bookId, fiscalYearId],
  );

  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- create / revise ------------------------------------------------------
  const [form, setForm] = useState({
    name: '',
    currency: '',
    scenario: '',
    control_policy: 'INFORMATIONAL',
    control_threshold_pct: '',
  });
  const [lines, setLines] = useState<PlanLine[]>([newPlanLine()]);
  const updateLine = (index: number, patch: Partial<PlanLine>) =>
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  const [reviseWithLines, setReviseWithLines] = useState('copy');

  // --- the control check ----------------------------------------------------
  const [check, setCheck] = useState({ accounting_period_id: '', account_id: '', amount: '' });
  const [checkResult, setCheckResult] = useState<ControlResult | null>(null);

  // --- forecasts ------------------------------------------------------------
  const [forecastForm, setForecastForm] = useState({
    name: '',
    scenario: '',
    as_of_date: today(),
    currency: '',
  });

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      legal_entity_id: entityId,
      accounting_book_id: bookId || (books.data?.data[0]?.id ?? ''),
      fiscal_year_id: fiscalYearId,
      name: form.name,
      currency: form.currency || (book?.base_currency ?? ''),
      scenario: form.scenario || undefined,
      control_policy: form.control_policy,
      control_threshold_pct: form.control_threshold_pct || null,
      lines: lines
        .filter((l) => l.accounting_period_id && l.account_id && l.amount)
        .map((l) => ({
          accounting_period_id: l.accounting_period_id,
          account_id: l.account_id,
          amount: l.amount,
        })),
    };
    try {
      const created = await api<Budget>('/budgets', {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor('budget', body),
      });
      keys.settle('budget');
      setNotice(`${created.name} v${created.version} created as a draft.`);
      setLines([newPlanLine()]);
      budgets.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const approve = async (budget: Budget) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/budgets/${budget.id}/approve`, {
        method: 'POST',
        idempotencyKey: keys.keyFor(`approve-budget-${budget.id}`, { id: budget.id }),
      });
      keys.settle(`approve-budget-${budget.id}`);
      setNotice(
        `${budget.name} v${budget.version} is now the current approved budget. Any version that ` +
          'held that place is superseded, not deleted.',
      );
      budgets.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const revise = async (budget: Budget) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const replacement = lines
      .filter((l) => l.accounting_period_id && l.account_id && l.amount)
      .map((l) => ({
        accounting_period_id: l.accounting_period_id,
        account_id: l.account_id,
        amount: l.amount,
      }));
    // Scenario, control policy and threshold are deliberately NOT sent. Omitted,
    // the service carries the source budget's forward; sent from the create
    // form's fields they would arrive as whatever that form happens to hold —
    // and `control_threshold_pct: null` is an explicit *clear*, so a revision of
    // a BLOCK-at-90% budget would quietly become an unthresholded one. A
    // revision changes the numbers, not the control.
    const body = {
      // Omitted copies the approved lines forward; given, it replaces them
      // entirely — two different intentions, so the screen asks which.
      ...(reviseWithLines === 'replace' ? { lines: replacement } : {}),
    };
    try {
      const created = await api<Budget>(`/budgets/${budget.id}/revise`, {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor(`revise-budget-${budget.id}`, body),
      });
      keys.settle(`revise-budget-${budget.id}`);
      setNotice(
        `Revision created as ${created.name} v${created.version}, in draft. The approved version is ` +
          'untouched until this one is approved.',
      );
      budgets.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const runCheck = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setCheckResult(null);
    try {
      // Deliberately NOT pinned to whichever budget is open above: the control
      // that actually gates a purchase order resolves the ACTIVE version, and a
      // panel that answered for a draft would be a rehearsal of a decision
      // nobody will make. The result names the budget it used.
      const result = await api<ControlResult>('/budget-control/check', {
        query: {
          legal_entity_id: entityId,
          accounting_book_id: bookId || (books.data?.data[0]?.id ?? ''),
          accounting_period_id: check.accounting_period_id,
          account_id: check.account_id,
          amount: check.amount,
        },
      });
      setCheckResult(result);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const createForecast = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      legal_entity_id: entityId,
      accounting_book_id: bookId || (books.data?.data[0]?.id ?? ''),
      fiscal_year_id: fiscalYearId,
      name: forecastForm.name,
      as_of_date: forecastForm.as_of_date,
      currency: forecastForm.currency || (book?.base_currency ?? ''),
      scenario: forecastForm.scenario || undefined,
      lines: lines
        .filter((l) => l.accounting_period_id && l.account_id && l.amount)
        .map((l) => ({
          accounting_period_id: l.accounting_period_id,
          account_id: l.account_id,
          amount: l.amount,
        })),
    };
    try {
      await api('/forecasts', {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor('forecast', body),
      });
      keys.settle('forecast');
      setNotice(`Forecast ${forecastForm.name} snapshot taken as of ${forecastForm.as_of_date}.`);
      setLines([newPlanLine()]);
      forecasts.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const view = variance.data;
  const varianceCurrency = units(view?.budget_currency);
  const currencyMismatch =
    view != null && view.actuals_currency != null && view.actuals_currency !== view.budget_currency;

  /** The plan-line grid, shared by budgets, revisions and forecasts. */
  const planLines = (
    <div className="grid-wrapper">
      <table className="journal-grid document-grid">
        <caption>Budget lines — one amount per period and account</caption>
        <thead>
          <tr>
            <th scope="col" className="grid-line-no">
              #
            </th>
            <th scope="col">Period</th>
            <th scope="col">Account</th>
            <th scope="col" className="numeric">
              Amount
            </th>
            <th scope="col">
              <span className="visually-hidden">Row actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, index) => (
            <tr key={line.key}>
              <td className="grid-line-no">{index + 1}</td>
              <td>
                <label className="visually-hidden" htmlFor={`period-${line.key}`}>
                  Period for line {index + 1}
                </label>
                <select
                  id={`period-${line.key}`}
                  value={line.accounting_period_id}
                  onChange={(e) => updateLine(index, { accounting_period_id: e.target.value })}
                >
                  <option value="">Select a period…</option>
                  {periodOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <label className="visually-hidden" htmlFor={`account-${line.key}`}>
                  Account for line {index + 1}
                </label>
                <select
                  id={`account-${line.key}`}
                  value={line.account_id}
                  onChange={(e) => updateLine(index, { account_id: e.target.value })}
                >
                  <option value="">Select an account…</option>
                  {accountOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </td>
              <td className="numeric">
                <label className="visually-hidden" htmlFor={`amount-${line.key}`}>
                  Amount for line {index + 1}
                </label>
                <input
                  id={`amount-${line.key}`}
                  className="numeric"
                  inputMode="decimal"
                  value={line.amount}
                  onChange={(e) => updateLine(index, { amount: e.target.value })}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() =>
                    setLines(
                      lines.length <= 1 ? [newPlanLine()] : lines.filter((_, i) => i !== index),
                    )
                  }
                >
                  Remove
                  <span className="visually-hidden"> line {index + 1}</span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="button-row">
        <Button onClick={() => setLines([...lines, newPlanLine()])}>Add line</Button>
      </div>
    </div>
  );

  return (
    <>
      <PageHeader
        title="Budgets"
        description="Approved budget against posted actuals and open commitments, and what a proposed spend would leave available."
      />
      <ErrorBanner error={error ?? budgets.error ?? variance.error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <div className="card">
        <Field
          label="Legal entity"
          name="entity"
          value={entityId}
          onChange={setEntityId}
          required
          options={(entities.data?.data ?? []).map((e) => ({
            value: e.id,
            label: `${e.code} — ${e.legal_name}`,
          }))}
        />
        <Field
          label="Accounting book"
          name="book"
          value={bookId}
          onChange={setBookId}
          options={(books.data?.data ?? []).map((b) => ({
            value: b.id,
            label: `${b.code} (${b.base_currency})`,
          }))}
        />
        <Field
          label="Fiscal year"
          name="fiscal_year"
          value={fiscalYearId}
          onChange={setFiscalYearId}
          options={(years.data?.data ?? []).map((y) => ({ value: y.id, label: y.name }))}
        />
        <Field
          label="Status"
          name="status"
          value={statusFilter}
          onChange={setStatusFilter}
          options={enumOptions(STATUSES)}
        />
      </div>

      <DataTable<Budget>
        caption="Budgets"
        rows={budgets.data?.data ?? []}
        rowKey={(row) => row.id}
        empty="No budgets match these filters."
        columns={[
          { key: 'name', header: 'Name', render: (row) => row.name },
          { key: 'version', header: 'Version', numeric: true, render: (row) => row.version },
          { key: 'scenario', header: 'Scenario', render: (row) => row.scenario ?? '—' },
          {
            key: 'policy',
            header: 'Control',
            render: (row) =>
              `${row.control_policy.replace(/_/g, ' ').toLowerCase()}${
                row.control_threshold_pct ? ` at ${row.control_threshold_pct}%` : ''
              }`,
          },
          {
            key: 'total',
            header: 'Budgeted',
            numeric: true,
            render: (row) => <Money value={row.total_amount} minorUnit={units(row.currency)} />,
          },
          { key: 'lines', header: 'Lines', numeric: true, render: (row) => row.line_count },
          { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
          {
            key: 'variance',
            header: 'Variance',
            render: (row) => (
              <Button onClick={() => setOpenId(row.id)}>
                Open
                <span className="visually-hidden">
                  {' '}
                  variance for {row.name} version {row.version}
                </span>
              </Button>
            ),
          },
          {
            key: 'approve',
            header: 'Approve',
            render: (row) =>
              row.status === 'DRAFT' || row.status === 'REVIEW' ? (
                can('budget.approve') ? (
                  <Button variant="primary" busy={busy} onClick={() => approve(row)}>
                    Approve
                  </Button>
                ) : (
                  <span className="field-hint">needs budget.approve</span>
                )
              ) : row.status === 'ACTIVE' && can('budget.revise') ? (
                <Button busy={busy} onClick={() => revise(row)}>
                  Revise
                </Button>
              ) : (
                <span className="field-hint">—</span>
              ),
          },
        ]}
      />

      {view ? (
        <div className="card">
          <h2>
            {view.name} v{view.version} — variance <Status value={view.status} />
          </h2>
          <SummaryList
            items={[
              {
                term: 'Approved budget',
                value: <Money value={view.totals.budget_amount} minorUnit={varianceCurrency} />,
              },
              {
                term: 'Actual posted',
                value: <Money value={view.totals.actual_amount} minorUnit={varianceCurrency} />,
                hint: `Summed from ${view.source.replace(/_/g, ' ')} at read time — never a stored document total.`,
              },
              {
                term: 'Open commitments',
                value: <Money value={view.totals.open_commitments} minorUnit={varianceCurrency} />,
                hint: 'Approved purchase orders not yet invoiced.',
              },
              {
                term: 'Variance',
                value: <Money value={view.totals.variance} minorUnit={varianceCurrency} />,
                hint: 'Budget less actual: negative means over budget.',
              },
              {
                term: 'Currency',
                value: view.budget_currency,
                hint: currencyMismatch
                  ? `Actuals are in ${view.actuals_currency}. Nothing here converts, so these two columns are not comparable.`
                  : undefined,
              },
            ]}
          />
          {currencyMismatch ? (
            <Notice tone="warning">
              This budget is in {view.budget_currency} and the book&rsquo;s actuals are in{' '}
              {view.actuals_currency}. The comparison below is unconverted — read it as two
              currencies side by side, not as a variance.
            </Notice>
          ) : null}

          <DataTable<VarianceRow>
            caption="Variance by account and period"
            rows={view.data}
            rowKey={(row) => `${row.accounting_period_id}-${row.account_id}`}
            empty="This budget has no lines."
            columns={[
              { key: 'period', header: 'Period', render: (row) => row.period_name },
              {
                key: 'account',
                header: 'Account',
                render: (row) => `${row.account_code} — ${row.account_name}`,
              },
              {
                key: 'budget',
                header: 'Approved',
                numeric: true,
                render: (row) => <Money value={row.budget_amount} minorUnit={varianceCurrency} />,
              },
              {
                key: 'actual',
                header: 'Actual posted',
                numeric: true,
                render: (row) => <Money value={row.actual_amount} minorUnit={varianceCurrency} />,
              },
              {
                key: 'commitments',
                header: 'Open commitments',
                numeric: true,
                render: (row) => (
                  <Money value={row.open_commitments} minorUnit={varianceCurrency} />
                ),
              },
              {
                key: 'variance',
                header: 'Variance',
                numeric: true,
                render: (row) => <Money value={row.variance} minorUnit={varianceCurrency} />,
              },
              {
                key: 'consumed',
                header: 'Consumed',
                numeric: true,
                // null rather than a percentage when the budget is zero: spend
                // against nothing is infinite consumption, and a made-up number
                // would sort and threshold as if it were finite.
                render: (row) => (row.consumed_pct === null ? 'no budget' : `${row.consumed_pct}%`),
              },
            ]}
          />

          <DataTable<PeriodRollup>
            caption="By period"
            rows={view.by_period}
            rowKey={(row) => row.accounting_period_id}
            empty="No periods."
            columns={[
              { key: 'period', header: 'Period', render: (row) => row.period_name },
              {
                key: 'budget',
                header: 'Approved',
                numeric: true,
                render: (row) => <Money value={row.budget_amount} minorUnit={varianceCurrency} />,
              },
              {
                key: 'actual',
                header: 'Actual posted',
                numeric: true,
                render: (row) => <Money value={row.actual_amount} minorUnit={varianceCurrency} />,
              },
              {
                key: 'commitments',
                header: 'Open commitments',
                numeric: true,
                render: (row) => (
                  <Money value={row.open_commitments} minorUnit={varianceCurrency} />
                ),
              },
              {
                key: 'variance',
                header: 'Variance',
                numeric: true,
                render: (row) => <Money value={row.variance} minorUnit={varianceCurrency} />,
              },
            ]}
          />
          <div className="button-row">
            <Button onClick={() => setOpenId(null)}>Close variance</Button>
          </div>
        </div>
      ) : null}

      {entityId ? (
        <form onSubmit={runCheck} className="card">
          <h2>What would this spend leave?</h2>
          <p className="page-description">
            Doc 10: available = approved budget − actual posted − open commitments − pending
            approved spend. This is the server&rsquo;s own evaluation — the same arithmetic a
            purchase order approval runs inside its transaction — so the numbers here are the
            numbers that would decide it. It evaluates the budget that governs — the ACTIVE version,
            which is not necessarily the one open above — and the answer names which one it used.
            This form only asks; it commits nothing.
          </p>
          <Field
            label="Period"
            name="check_period"
            value={check.accounting_period_id}
            onChange={(v) => setCheck({ ...check, accounting_period_id: v })}
            required
            options={periodOptions}
          />
          <Field
            label="Account"
            name="check_account"
            value={check.account_id}
            onChange={(v) => setCheck({ ...check, account_id: v })}
            required
            options={accountOptions}
          />
          <Field
            label="Proposed spend"
            name="check_amount"
            value={check.amount}
            onChange={(v) => setCheck({ ...check, amount: v })}
            required
            placeholder="0.00"
          />
          <Button type="submit" variant="primary" busy={busy}>
            Check
          </Button>

          {checkResult ? (
            <>
              <SummaryList
                items={[
                  {
                    term: 'Decision',
                    value: checkResult.decision.replace(/_/g, ' ').toLowerCase(),
                    hint: `Policy: ${checkResult.policy.replace(/_/g, ' ').toLowerCase()}${
                      checkResult.warn_threshold_pct
                        ? `, warning at ${checkResult.warn_threshold_pct}%`
                        : ''
                    }.`,
                  },
                  {
                    term: 'Approved budget',
                    value: (
                      <Money
                        value={checkResult.approved_budget}
                        minorUnit={units(book?.base_currency)}
                      />
                    ),
                    hint: checkResult.budget_name
                      ? `${checkResult.budget_name} v${checkResult.budget_version}`
                      : 'No budget line covers this account and period.',
                  },
                  {
                    term: 'Actual posted',
                    value: (
                      <Money
                        value={checkResult.actual_posted}
                        minorUnit={units(book?.base_currency)}
                      />
                    ),
                    hint: `From ${checkResult.source.replace(/_/g, ' ')}.`,
                  },
                  {
                    term: 'Open commitments',
                    value: (
                      <Money
                        value={checkResult.open_commitments}
                        minorUnit={units(book?.base_currency)}
                      />
                    ),
                  },
                  {
                    term: 'Pending approved spend',
                    value: (
                      <Money
                        value={checkResult.pending_approved_spend}
                        minorUnit={units(book?.base_currency)}
                      />
                    ),
                    hint: 'Approved bills not yet posted.',
                  },
                  {
                    term: 'Available',
                    value: (
                      <Money value={checkResult.available} minorUnit={units(book?.base_currency)} />
                    ),
                    hint: 'The four terms above, in doc 10 order.',
                  },
                  {
                    term: 'Proposed spend',
                    value: (
                      <Money
                        value={checkResult.proposed_spend}
                        minorUnit={units(book?.base_currency)}
                      />
                    ),
                  },
                  {
                    term: 'Available afterwards',
                    value: (
                      <Money
                        value={checkResult.available_after}
                        minorUnit={units(book?.base_currency)}
                      />
                    ),
                    hint: checkResult.over_budget
                      ? `Over by ${checkResult.over_budget_by}.`
                      : undefined,
                  },
                ]}
              />
              <Notice tone={checkResult.over_budget ? 'warning' : 'info'}>
                {checkResult.explanation}
              </Notice>
            </>
          ) : null}
        </form>
      ) : null}

      {entityId && can('budget.create') ? (
        <form onSubmit={create} className="card">
          <h2>New budget</h2>
          <p className="page-description">
            Lines are entered with the header: approval freezes them, and there is no add-line route
            afterwards. A revision is how an approved budget changes.
          </p>
          <Field
            label="Name"
            name="budget_name"
            value={form.name}
            onChange={(v) => setForm({ ...form, name: v })}
            required
          />
          <Field
            label="Currency"
            name="budget_currency"
            value={form.currency || (book?.base_currency ?? '')}
            onChange={(v) => setForm({ ...form, currency: v })}
            required
            hint="Actuals are summed in the book's base currency; a budget in another currency is shown side by side, never converted."
          />
          <Field
            label="Scenario"
            name="budget_scenario"
            value={form.scenario}
            onChange={(v) => setForm({ ...form, scenario: v })}
            hint="Optional label — base case, downside, and so on."
          />
          <Field
            label="Control policy"
            name="budget_policy"
            value={form.control_policy}
            onChange={(v) => setForm({ ...form, control_policy: v })}
            options={enumOptions(POLICIES)}
            hint="Block refuses spend beyond the budget; warn lets it through and says so; require override demands an explicit override."
          />
          <Field
            label="Warning threshold (%)"
            name="budget_threshold"
            value={form.control_threshold_pct}
            onChange={(v) => setForm({ ...form, control_threshold_pct: v })}
            placeholder="90"
          />
          {planLines}
          <Button
            type="submit"
            variant="primary"
            busy={busy}
            disabled={!fiscalYearId || !(bookId || books.data?.data[0]?.id)}
          >
            Create budget
          </Button>
          <p className="field-hint">
            A fiscal year and an accounting book are required — a budget line lives in a period of
            one year, measured against one book.
          </p>
        </form>
      ) : null}

      {entityId && can('budget.revise') ? (
        <div className="card">
          <h2>Revising an approved budget</h2>
          <p className="page-description">
            Use the Revise button on an active budget above. The revision is a new version in draft;
            the approved one keeps working until the revision is itself approved. Scenario, control
            policy and threshold carry forward from the version being revised — a revision changes
            the numbers, not the control.
          </p>
          <Field
            label="Lines in the revision"
            name="revise_lines"
            value={reviseWithLines}
            onChange={setReviseWithLines}
            options={[
              { value: 'copy', label: 'copy the approved lines forward' },
              { value: 'replace', label: 'replace them with the lines entered above' },
            ]}
            hint="Copying and replacing are different intentions, so the choice is explicit."
          />
        </div>
      ) : null}

      <DataTable<Forecast>
        caption="Forecasts"
        rows={forecasts.data?.data ?? []}
        rowKey={(row) => row.id}
        empty="No forecast snapshots."
        columns={[
          { key: 'name', header: 'Name', render: (row) => row.name },
          { key: 'scenario', header: 'Scenario', render: (row) => row.scenario ?? '—' },
          { key: 'as_of', header: 'As of', render: (row) => row.as_of_date.slice(0, 10) },
          { key: 'currency', header: 'Currency', render: (row) => row.currency },
          {
            key: 'total',
            header: 'Total',
            numeric: true,
            render: (row) => (
              <Money value={row.total_amount ?? null} minorUnit={units(row.currency)} />
            ),
          },
        ]}
      />

      {entityId && can('forecast.manage') ? (
        <form onSubmit={createForecast} className="card">
          <h2>New forecast snapshot</h2>
          <p className="page-description">
            A forecast is a dated snapshot of the same (period, account, amount) shape as a budget.
            It never controls spend; it records what was expected on a day.
          </p>
          <Field
            label="Name"
            name="forecast_name"
            value={forecastForm.name}
            onChange={(v) => setForecastForm({ ...forecastForm, name: v })}
            required
          />
          <Field
            label="As of"
            name="forecast_as_of"
            type="date"
            value={forecastForm.as_of_date}
            onChange={(v) => setForecastForm({ ...forecastForm, as_of_date: v })}
            required
          />
          <Field
            label="Currency"
            name="forecast_currency"
            value={forecastForm.currency || (book?.base_currency ?? '')}
            onChange={(v) => setForecastForm({ ...forecastForm, currency: v })}
            required
          />
          <Field
            label="Scenario"
            name="forecast_scenario"
            value={forecastForm.scenario}
            onChange={(v) => setForecastForm({ ...forecastForm, scenario: v })}
          />
          <p className="field-hint">
            The forecast uses the same lines entered above — enter them once and submit whichever of
            the two this is.
          </p>
          <Button type="submit" busy={busy} disabled={!fiscalYearId}>
            Take snapshot
          </Button>
        </form>
      ) : null}
    </>
  );
}
