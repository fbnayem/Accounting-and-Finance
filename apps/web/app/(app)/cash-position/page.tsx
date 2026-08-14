'use client';

import { useState } from 'react';
import { api } from '../../../lib/api';
import { DataTable, ErrorBanner, Field, PageHeader, useResource } from '../../../components/ui';

interface PositionRow {
  bank_account_id: string;
  name: string;
  currency: string;
  kind: string;
  book_balance: string;
  book_balance_as_of: string | null;
  bank_balance: string | null;
  bank_balance_as_of: string | null;
  book_balance_source: string;
  bank_balance_source: string | null;
  unreconciled: string;
  unreconciled_count: string;
}

interface CashPosition {
  as_of: string | null;
  accounts: PositionRow[];
  by_currency: {
    currency: string;
    book_balance: string;
    unreconciled: string;
    clearing_balance: string;
  }[];
}

interface UnreconciledRow {
  id: string;
  bank_account_name: string;
  transaction_date: string;
  currency: string;
  amount: string;
  counterparty_name: string | null;
  reference: string | null;
  reconciliation_state: string;
  population: string;
}

interface UnreconciledReport {
  as_of: string | null;
  rows: UnreconciledRow[];
  outstanding_payments: number;
  deposits_in_transit: number;
  net_unreconciled: string;
}

const money = (value: string | null): string =>
  value == null
    ? '—'
    : Number(value).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

/**
 * Cash position and unreconciled transactions — doc 06.
 *
 * The one thing this screen insists on is saying where each number came from.
 * A cash position that shows a bank balance and a book balance side by side
 * without dating them is how a stale feed becomes a decision: the numbers agree
 * to the penny and one of them is four days old. Every row carries its source
 * and its as-of date, and a bank balance that has never been fed says so rather
 * than borrowing the book's figure.
 *
 * The unreconciled report is the other half. A difference between bank and book
 * is not an error until it is unexplained, and the two populations that
 * legitimately explain it — payments that have not cleared, deposits in transit
 * — are separated here rather than summed into one number.
 */
export default function CashPositionPage() {
  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');
  const [asOf, setAsOf] = useState('');

  const position = useResource(
    () =>
      entityId
        ? api<CashPosition>('/cash-position', { query: { legal_entity_id: entityId, as_of: asOf } })
        : Promise.resolve(null),
    [entityId, asOf],
  );

  const unreconciled = useResource(
    () =>
      entityId
        ? api<UnreconciledReport>('/reports/unreconciled', {
            query: { legal_entity_id: entityId, as_of: asOf },
          })
        : Promise.resolve(null),
    [entityId, asOf],
  );

  return (
    <>
      <PageHeader
        title="Cash position"
        description="What every bank, cash and clearing account holds, with the source and age of each figure."
      />
      <ErrorBanner error={position.error ?? unreconciled.error} />

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
          label="As of"
          name="as_of"
          type="date"
          value={asOf}
          onChange={setAsOf}
          hint="Leave empty for the latest position."
        />
      </div>

      {position.data ? (
        <>
          <DataTable<PositionRow>
            caption="By account"
            rows={position.data.accounts}
            rowKey={(row) => row.bank_account_id}
            empty="No active bank accounts for this entity."
            columns={[
              { key: 'name', header: 'Account', render: (row) => row.name },
              { key: 'kind', header: 'Type', render: (row) => row.kind.replace(/_/g, ' ') },
              { key: 'currency', header: 'Currency', render: (row) => row.currency },
              {
                key: 'book',
                header: 'Book balance',
                numeric: true,
                render: (row) => money(row.book_balance),
              },
              {
                key: 'book_as_of',
                header: 'Book as of',
                render: (row) => row.book_balance_as_of?.slice(0, 10) ?? 'no postings',
              },
              {
                key: 'bank',
                header: 'Bank balance',
                numeric: true,
                // Never falls back to the book figure. "We have not heard from
                // the bank" and "the bank agrees with us" are different facts.
                render: (row) => (row.bank_balance === null ? 'not fed' : money(row.bank_balance)),
              },
              {
                key: 'bank_as_of',
                header: 'Bank as of',
                render: (row) => row.bank_balance_as_of?.slice(0, 10) ?? '—',
              },
              {
                key: 'unreconciled',
                header: 'Unreconciled',
                numeric: true,
                render: (row) => `${money(row.unreconciled)} (${row.unreconciled_count})`,
              },
            ]}
          />

          <DataTable<CashPosition['by_currency'][number]>
            caption="By currency"
            rows={position.data.by_currency}
            rowKey={(row) => row.currency}
            empty="Nothing held."
            columns={[
              { key: 'currency', header: 'Currency', render: (row) => row.currency },
              {
                key: 'book',
                header: 'Book balance',
                numeric: true,
                render: (row) => money(row.book_balance),
              },
              {
                key: 'unreconciled',
                header: 'Unreconciled',
                numeric: true,
                render: (row) => money(row.unreconciled),
              },
              {
                key: 'clearing',
                header: 'In clearing',
                numeric: true,
                // Money taken from a customer that the processor has not settled
                // yet. It is ours and it is not in the bank — doc 06 keeps it
                // visible rather than folded into either side.
                render: (row) => money(row.clearing_balance),
              },
            ]}
          />
        </>
      ) : null}

      {unreconciled.data ? (
        <>
          <div className="card">
            <h2>Unreconciled transactions</h2>
            <dl className="summary-list">
              <div>
                <dt>Outstanding payments</dt>
                <dd>{unreconciled.data.outstanding_payments}</dd>
              </div>
              <div>
                <dt>Deposits in transit</dt>
                <dd>{unreconciled.data.deposits_in_transit}</dd>
              </div>
              <div>
                <dt>Net unreconciled</dt>
                <dd>{money(unreconciled.data.net_unreconciled)}</dd>
              </div>
            </dl>
          </div>

          <DataTable<UnreconciledRow>
            caption="Unreconciled bank lines"
            rows={unreconciled.data.rows}
            rowKey={(row) => row.id}
            empty="Everything is reconciled at this date."
            columns={[
              { key: 'date', header: 'Date', render: (row) => row.transaction_date.slice(0, 10) },
              { key: 'account', header: 'Account', render: (row) => row.bank_account_name },
              {
                key: 'counterparty',
                header: 'Counterparty',
                render: (row) => row.counterparty_name ?? '—',
              },
              { key: 'reference', header: 'Reference', render: (row) => row.reference ?? '—' },
              {
                key: 'amount',
                header: 'Amount',
                numeric: true,
                render: (row) => money(row.amount),
              },
              {
                key: 'population',
                header: 'Population',
                render: (row) => row.population.replace(/_/g, ' ').toLowerCase(),
              },
              {
                key: 'state',
                header: 'State',
                render: (row) => row.reconciliation_state.toLowerCase(),
              },
            ]}
          />
        </>
      ) : null}

      {!entityId ? <p className="empty">Choose a legal entity to see its cash position.</p> : null}
    </>
  );
}
