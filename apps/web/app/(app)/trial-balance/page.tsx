'use client';

import { useState } from 'react';
import { api, newIdempotencyKey } from '../../../lib/api';
import {
  Button,
  DataTable,
  ErrorBanner,
  Field,
  Notice,
  PageHeader,
  useResource,
} from '../../../components/ui';

interface TrialBalanceRow {
  account_code: string;
  account_name: string;
  account_type: string;
  opening_debit: string;
  opening_credit: string;
  period_debit: string;
  period_credit: string;
  closing_debit: string;
  closing_credit: string;
}

interface TrialBalance {
  base_currency: string;
  source: string;
  period_from: string | null;
  period_to: string | null;
  data: TrialBalanceRow[];
  totals: Record<string, string>;
  balances: boolean;
  equation: {
    assets: string;
    liabilities: string;
    equity: string;
    currentYearEarnings: string;
    leftSide: string;
    rightSide: string;
    difference: string;
    balances: boolean;
  };
}

const money = (value: string): string =>
  Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Trial balance — the first of doc 03's ledger reads, and Gate E's first criterion.
 *
 * The `source` selector is not a debugging affordance. doc 03's acceptance criterion
 * is "Rebuilding trial balance from raw journal lines equals cached balance model",
 * and this is that comparison, available to whoever is looking at the numbers rather
 * than only to a test. If the two ever disagree, the person who needs to know is the
 * one reading the report.
 */
export default function TrialBalancePage() {
  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');
  const [source, setSource] = useState<'projection' | 'journal_lines'>('projection');
  const [rebuild, setRebuild] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const books = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; base_currency: string }[] }>(
            '/accounting-books',
            {
              query: { legal_entity_id: entityId },
            },
          )
        : Promise.resolve({ data: [] }),
    [entityId],
  );
  const bookId = books.data?.data[0]?.id ?? '';

  const report = useResource(
    () =>
      bookId
        ? api<TrialBalance>('/reports/trial-balance', { query: { book_id: bookId, source } })
        : Promise.resolve(null),
    [bookId, source],
  );

  const runRebuild = async () => {
    setError(null);
    setRebuild(null);
    try {
      const result = await api<{
        identical: boolean;
        rows_before: number;
        rows_after: number;
        differences: unknown[];
        duration_ms: number;
      }>('/ledger/projections/rebuild', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('rebuild'),
        body: { accounting_book_id: bookId },
      });
      setRebuild(
        result.identical
          ? `Rebuilt ${result.rows_after} rows in ${result.duration_ms}ms. Identical to what was there.`
          : `Rebuilt ${result.rows_after} rows in ${result.duration_ms}ms and found ` +
              `${result.differences.length} difference(s). The projection had drifted; it is now correct.`,
      );
      report.reload();
    } catch (err) {
      setError(err);
    }
  };

  const tb = report.data;

  return (
    <>
      <PageHeader
        title="Trial balance"
        description="Opening, movement and closing per account. The balance model is a projection, never a source of truth — it can be destroyed and rebuilt from posted journal lines at any time."
      />
      <ErrorBanner error={error} />

      <div className="card">
        <Field
          label="Legal entity"
          name="entity"
          value={entityId}
          onChange={setEntityId}
          options={(entities.data?.data ?? []).map((e) => ({
            value: e.id,
            label: `${e.code} — ${e.legal_name}`,
          }))}
        />
        <Field
          label="Computed from"
          name="source"
          value={source}
          onChange={(v) => setSource(v as 'projection' | 'journal_lines')}
          options={[
            { value: 'projection', label: 'The balance projection (fast)' },
            { value: 'journal_lines', label: 'Raw journal lines (authoritative)' },
          ]}
          hint="Both must agree. If they do not, the projection has drifted and the rebuild below will say so."
        />
      </div>

      {bookId ? (
        <>
          <div className="button-row">
            <Button onClick={() => void runRebuild()}>Destroy and rebuild the projection</Button>
          </div>
          {rebuild ? <Notice>{rebuild}</Notice> : null}

          {tb ? (
            <>
              <p className="grid-balance" role="status" aria-live="polite">
                {tb.balances ? (
                  <>
                    <span className="tag">Balanced</span> {money(tb.totals.closing_debit ?? '0')}{' '}
                    {tb.base_currency} on both sides.
                  </>
                ) : (
                  <>
                    <span className="tag">Out of balance</span> debits{' '}
                    {money(tb.totals.closing_debit ?? '0')} against credits{' '}
                    {money(tb.totals.closing_credit ?? '0')} {tb.base_currency}.
                  </>
                )}
              </p>

              <div className="card">
                <h2>Accounting equation</h2>
                <p className="field-hint">
                  Assets = Liabilities + Equity + current-year earnings. The last term is what makes
                  the statement true mid-year: revenue and expense close into equity only at year
                  end, so a cutover on any other date carries them separately.
                </p>
                <dl className="summary-list">
                  <div>
                    <dt>Assets</dt>
                    <dd>{money(tb.equation.assets)}</dd>
                  </div>
                  <div>
                    <dt>Liabilities</dt>
                    <dd>{money(tb.equation.liabilities)}</dd>
                  </div>
                  <div>
                    <dt>Equity</dt>
                    <dd>{money(tb.equation.equity)}</dd>
                  </div>
                  <div>
                    <dt>Current-year earnings</dt>
                    <dd>{money(tb.equation.currentYearEarnings)}</dd>
                  </div>
                  <div>
                    <dt>Difference</dt>
                    <dd>
                      {money(tb.equation.difference)}{' '}
                      {tb.equation.balances ? <span className="tag">balances</span> : null}
                    </dd>
                  </div>
                </dl>
              </div>

              <DataTable<TrialBalanceRow>
                caption={`Trial balance in ${tb.base_currency}, from ${
                  source === 'projection' ? 'the projection' : 'raw journal lines'
                }`}
                rows={tb.data}
                rowKey={(row) => row.account_code}
                empty="Nothing posted yet."
                columns={[
                  { key: 'code', header: 'Account', render: (row) => row.account_code },
                  { key: 'name', header: 'Name', render: (row) => row.account_name },
                  { key: 'type', header: 'Type', render: (row) => row.account_type },
                  {
                    key: 'od',
                    header: 'Opening Dr',
                    numeric: true,
                    render: (row) => money(row.opening_debit),
                  },
                  {
                    key: 'oc',
                    header: 'Opening Cr',
                    numeric: true,
                    render: (row) => money(row.opening_credit),
                  },
                  {
                    key: 'pd',
                    header: 'Movement Dr',
                    numeric: true,
                    render: (row) => money(row.period_debit),
                  },
                  {
                    key: 'pc',
                    header: 'Movement Cr',
                    numeric: true,
                    render: (row) => money(row.period_credit),
                  },
                  {
                    key: 'cd',
                    header: 'Closing Dr',
                    numeric: true,
                    render: (row) => money(row.closing_debit),
                  },
                  {
                    key: 'cc',
                    header: 'Closing Cr',
                    numeric: true,
                    render: (row) => money(row.closing_credit),
                  },
                ]}
              />
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
