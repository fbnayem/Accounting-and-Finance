'use client';

import { useState } from 'react';
import { api } from '../../../lib/api';
import {
  DataTable,
  ErrorBanner,
  Field,
  PageHeader,
  Status,
  useResource,
} from '../../../components/ui';

interface LedgerLine {
  id: string;
  posting_date: string;
  entry_number: string | null;
  description: string | null;
  entry_status: string;
  account_code: string;
  account_name: string;
  line_description: string | null;
  debit: string;
  credit: string;
  running_balance: string;
}

interface RegisterEntry {
  id: string;
  entry_number: string | null;
  posting_date: string;
  description: string | null;
  status: string;
  journal_code: string;
  journal_type: string;
  period_name: string;
  posted_by_name: string | null;
  total_debit: string;
  line_count: number;
}

const money = (value: string): string =>
  Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * General Ledger and Journal Register — the other two of doc 03's ledger reads.
 *
 * Together on one screen because they answer the same question from two directions:
 * the register is "what did we post", the general ledger is "what happened to this
 * account". An accountant chasing a balance moves between them constantly, and two
 * navigation clicks between them is two too many.
 *
 * The running balance is computed by the database over the same ordering the rows
 * are returned in. Computing it in the browser would be wrong the moment the list
 * is truncated, and it is truncated by default.
 */
export default function GeneralLedgerPage() {
  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const books = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; base_currency: string }[] }>('/accounting-books', {
            query: { legal_entity_id: entityId },
          })
        : Promise.resolve({ data: [] }),
    [entityId],
  );
  const bookId = books.data?.data[0]?.id ?? '';

  const accounts = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; name: string }[] }>('/accounts', {
            query: { legal_entity_id: entityId, posting_only: 'true' },
          })
        : Promise.resolve({ data: [] }),
    [entityId],
  );

  const query = {
    book_id: bookId,
    ...(accountId ? { account_id: accountId } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };

  const ledger = useResource(
    () =>
      bookId
        ? api<{ data: LedgerLine[] }>('/reports/general-ledger', { query })
        : Promise.resolve({ data: [] }),
    [bookId, accountId, from, to],
  );
  const register = useResource(
    () =>
      bookId
        ? api<{ data: RegisterEntry[] }>('/reports/journal-register', {
            query: { book_id: bookId, ...(from ? { from } : {}), ...(to ? { to } : {}) },
          })
        : Promise.resolve({ data: [] }),
    [bookId, from, to],
  );

  return (
    <>
      <PageHeader
        title="General ledger"
        description="Every posted line, and the journals they came from. Reversed entries are shown: their lines still exist, and the reversing entry carries the opposite amounts."
      />
      <ErrorBanner error={ledger.error ?? register.error} />

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
          label="Account"
          name="account"
          value={accountId}
          onChange={setAccountId}
          options={(accounts.data?.data ?? []).map((a) => ({
            value: a.id,
            label: `${a.code} — ${a.name}`,
          }))}
          hint="Leave blank for every account. The running balance restarts per account."
        />
        <Field label="From" name="from" type="date" value={from} onChange={setFrom} />
        <Field label="To" name="to" type="date" value={to} onChange={setTo} />
      </div>

      {bookId ? (
        <>
          <DataTable<LedgerLine>
            caption="General ledger"
            rows={ledger.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="Nothing posted in this range."
            columns={[
              { key: 'date', header: 'Date', render: (row) => row.posting_date },
              { key: 'number', header: 'Entry', render: (row) => row.entry_number ?? '—' },
              {
                key: 'account',
                header: 'Account',
                render: (row) => `${row.account_code} — ${row.account_name}`,
              },
              {
                key: 'description',
                header: 'Description',
                render: (row) => row.line_description ?? row.description ?? '—',
              },
              { key: 'debit', header: 'Debit', numeric: true, render: (row) => money(row.debit) },
              {
                key: 'credit',
                header: 'Credit',
                numeric: true,
                render: (row) => money(row.credit),
              },
              {
                key: 'balance',
                header: 'Balance',
                numeric: true,
                render: (row) => money(row.running_balance),
              },
              {
                key: 'status',
                header: 'Entry status',
                render: (row) => <Status value={row.entry_status} />,
              },
            ]}
          />

          <h2>Journal register</h2>
          <DataTable<RegisterEntry>
            caption="Journal register"
            rows={register.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No journals posted in this range."
            columns={[
              { key: 'number', header: 'Entry', render: (row) => row.entry_number ?? '—' },
              { key: 'date', header: 'Date', render: (row) => row.posting_date },
              { key: 'journal', header: 'Journal', render: (row) => row.journal_code },
              { key: 'period', header: 'Period', render: (row) => row.period_name },
              {
                key: 'description',
                header: 'Description',
                render: (row) => row.description ?? '—',
              },
              {
                key: 'total',
                header: 'Total',
                numeric: true,
                render: (row) => money(row.total_debit),
              },
              { key: 'lines', header: 'Lines', numeric: true, render: (row) => row.line_count },
              { key: 'by', header: 'Posted by', render: (row) => row.posted_by_name ?? '—' },
              { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
            ]}
          />
        </>
      ) : null}
    </>
  );
}
