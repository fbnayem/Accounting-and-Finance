'use client';

import { useEffect, useMemo, useState } from 'react';
import { ApiError, api, newIdempotencyKey } from '../../../lib/api';
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
import {
  JournalGrid,
  emptyRow,
  type GridAccount,
  type GridRow,
} from '../../../components/journal-grid';

interface JournalEntry {
  id: string;
  entry_number: string | null;
  posting_date: string;
  description: string | null;
  journal_code: string;
  period_name: string;
  status: string;
  approval_state: string;
  base_currency: string;
  total_debit: string;
  line_count: number;
  version: string;
}

/**
 * Manual journals — doc 03's "Manual journals" section, and the screen the whole
 * of Phase 2 exists to make possible.
 *
 * The lifecycle buttons are driven by `status` rather than shown-and-disabled,
 * because a row of five greyed buttons tells a user less than the two that apply.
 * The one exception is Reverse, which is shown on a posted entry precisely so it is
 * obvious that correction happens by reversal and not by editing (doc 01 rule 4).
 */
export default function JournalsPage() {
  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const books = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; name: string; base_currency: string }[] }>(
            '/accounting-books',
            { query: { legal_entity_id: entityId } },
          )
        : Promise.resolve({ data: [] }),
    [entityId],
  );
  const bookId = books.data?.data[0]?.id ?? '';
  const currency = books.data?.data[0]?.base_currency ?? 'GBP';

  const definitions = useResource(
    () =>
      bookId
        ? api<{ data: { id: string; code: string; name: string; journal_type: string }[] }>(
            '/journal-definitions',
            { query: { accounting_book_id: bookId } },
          )
        : Promise.resolve({ data: [] }),
    [bookId],
  );
  const accounts = useResource(
    () =>
      entityId
        ? api<{ data: GridAccount[] }>('/accounts', { query: { legal_entity_id: entityId } })
        : Promise.resolve({ data: [] }),
    [entityId],
  );
  const entries = useResource(
    () =>
      entityId
        ? api<{ data: JournalEntry[] }>('/journals', {
            query: { legal_entity_id: entityId, ...(statusFilter ? { status: statusFilter } : {}) },
          })
        : Promise.resolve({ data: [] }),
    [entityId, statusFilter],
  );

  const [header, setHeader] = useState({ journal_id: '', posting_date: '', description: '' });
  const [rows, setRows] = useState<GridRow[]>([emptyRow(), emptyRow()]);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const fieldError = (name: string) =>
    error instanceof ApiError ? error.forField(name) : undefined;

  // The first GENERAL journal, preselected. Nobody's first action on this screen is
  // choosing between "General" and "General"; the field stays so it can be changed.
  const defaultJournal = useMemo(
    () =>
      definitions.data?.data.find((d) => d.journal_type === 'GENERAL')?.id ??
      definitions.data?.data[0]?.id ??
      '',
    [definitions.data],
  );
  useEffect(() => {
    if (defaultJournal && !header.journal_id) {
      setHeader((h) => ({ ...h, journal_id: defaultJournal }));
    }
  }, [defaultJournal, header.journal_id]);

  const createDraft = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const lines = rows
        .filter((row) => row.accountId && (row.debit || row.credit))
        .map((row) => ({
          account_id: row.accountId,
          ...(row.description ? { description: row.description } : {}),
          ...(row.debit ? { debit: row.debit } : {}),
          ...(row.credit ? { credit: row.credit } : {}),
        }));
      await api('/journals', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('journal'),
        body: {
          accounting_book_id: bookId,
          journal_id: header.journal_id,
          posting_date: header.posting_date,
          ...(header.description ? { description: header.description } : {}),
          lines,
        },
      });
      setRows([emptyRow(), emptyRow()]);
      setHeader({ ...header, description: '' });
      entries.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const act = async (entry: JournalEntry, action: string) => {
    setError(null);
    try {
      await api(`/journals/${entry.id}/${action}`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(`${action}-${entry.id}`),
        body: action === 'reverse' ? { reason } : {},
      });
      setReason('');
      entries.reload();
    } catch (err) {
      setError(err);
    }
  };

  const discard = async (entry: JournalEntry) => {
    setError(null);
    try {
      await api(`/journals/${entry.id}`, { method: 'DELETE' });
      entries.reload();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Journals"
        description="Manual journals. A draft may be unbalanced while you work on it; a posted one never can be, and is corrected by reversal rather than by editing."
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
          label="Status"
          name="status"
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: 'DRAFT', label: 'Draft' },
            { value: 'SUBMITTED', label: 'Submitted' },
            { value: 'APPROVED', label: 'Approved' },
            { value: 'POSTED', label: 'Posted' },
            { value: 'REVERSED', label: 'Reversed' },
          ]}
        />
      </div>

      {entityId && bookId ? (
        <>
          <DataTable<JournalEntry>
            caption="Journal entries"
            rows={entries.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No journals yet."
            columns={[
              { key: 'number', header: 'Number', render: (row) => row.entry_number ?? '—' },
              { key: 'date', header: 'Posting date', render: (row) => row.posting_date },
              { key: 'period', header: 'Period', render: (row) => row.period_name },
              { key: 'journal', header: 'Journal', render: (row) => row.journal_code },
              {
                key: 'description',
                header: 'Description',
                render: (row) => row.description ?? '—',
              },
              {
                key: 'amount',
                header: 'Debit total',
                numeric: true,
                render: (row) => `${Number(row.total_debit).toFixed(2)} ${row.base_currency}`,
              },
              { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
              {
                key: 'actions',
                header: 'Actions',
                render: (row) => (
                  <div className="button-row">
                    {row.status === 'DRAFT' ? (
                      <>
                        <Button onClick={() => void act(row, 'submit')}>Submit</Button>
                        <Button variant="primary" onClick={() => void act(row, 'post')}>
                          Post
                        </Button>
                        <Button variant="danger" onClick={() => void discard(row)}>
                          Discard
                        </Button>
                      </>
                    ) : null}
                    {row.status === 'SUBMITTED' ? (
                      <Button onClick={() => void act(row, 'approve')}>Approve</Button>
                    ) : null}
                    {row.status === 'APPROVED' ? (
                      <Button variant="primary" onClick={() => void act(row, 'post')}>
                        Post
                      </Button>
                    ) : null}
                    {row.status === 'POSTED' ? (
                      <Button variant="danger" onClick={() => void act(row, 'reverse')}>
                        Reverse
                      </Button>
                    ) : null}
                  </div>
                ),
              },
            ]}
          />

          <div className="card">
            <Field
              label="Reversal reason"
              name="reason"
              value={reason}
              onChange={setReason}
              hint="Required to reverse. Recorded on the reversing entry and in the audit trail."
              error={fieldError('reason')}
            />
          </div>

          <form onSubmit={createDraft} className="card">
            <h2>New journal</h2>
            <Notice>
              The period is resolved from the posting date — the regular period containing it, never
              an overlapping adjustment period unless you name one and hold the permission.
            </Notice>
            <Field
              label="Journal"
              name="journal_id"
              value={header.journal_id}
              onChange={(v) => setHeader({ ...header, journal_id: v })}
              required
              options={(definitions.data?.data ?? []).map((d) => ({
                value: d.id,
                label: `${d.code} — ${d.name}`,
              }))}
            />
            <Field
              label="Posting date"
              name="posting_date"
              type="date"
              value={header.posting_date}
              onChange={(v) => setHeader({ ...header, posting_date: v })}
              required
              error={fieldError('posting_date')}
            />
            <Field
              label="Description"
              name="description"
              value={header.description}
              onChange={(v) => setHeader({ ...header, description: v })}
              placeholder="What this journal records"
            />

            <JournalGrid
              rows={rows}
              onChange={setRows}
              accounts={accounts.data?.data ?? []}
              currency={currency}
            />

            <Button type="submit" variant="primary" busy={busy}>
              Save draft
            </Button>
          </form>
        </>
      ) : null}
    </>
  );
}
