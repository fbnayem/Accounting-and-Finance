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

interface Reconciliation {
  id: string;
  bank_account_id: string;
  status: string;
  statement_start_date: string;
  statement_end_date: string;
  statement_closing_balance: string;
  book_closing_balance: string | null;
  difference: string | null;
  completed_at: string | null;
}

interface WorkingView extends Reconciliation {
  statement_opening_balance: string;
  unexplained_total: string;
  adjusted_difference: string;
  unresolved_count: number;
  reopen_reason: string | null;
}

const money = (value: string | null): string =>
  value == null
    ? '—'
    : Number(value).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

/**
 * Bank reconciliation — doc 06.
 *
 * The screen is built around the difference, because the difference is the work.
 * A session opens with the statement's closing balance, the server derives the
 * book side from the GL account the bank account maps to, and what remains is
 * either explained by unmatched lines or it is an error to find. Completing is
 * refused unless that number is within the tenant's tolerance — by the service
 * and again by a database guard — so the button is offered whatever the state
 * and the refusal names both numbers rather than being pre-empted here. A UI
 * that hides the button teaches people the rule; a UI that hides the *reason*
 * teaches them nothing.
 *
 * Reopening is separately permissioned and requires a reason, which is stored.
 * A completed reconciliation is a statement about a period that someone else may
 * have relied on.
 */
export default function BankReconciliationsPage() {
  const held = useHeldPermissions();
  const can = (permission: string) => !held || held.has(permission);
  const keys = useIdempotencyKeys();

  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');

  const accounts = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; name: string; currency: string }[] }>('/bank-accounts', {
            query: { legal_entity_id: entityId },
          })
        : Promise.resolve({ data: [] }),
    [entityId],
  );
  const [accountId, setAccountId] = useState('');

  const sessions = useResource(
    () =>
      accountId
        ? api<{ data: Reconciliation[] }>('/bank-reconciliations', {
            query: { bank_account_id: accountId },
          })
        : Promise.resolve({ data: [] }),
    [accountId],
  );

  const [openId, setOpenId] = useState<string | null>(null);
  const working = useResource(
    () => (openId ? api<WorkingView>(`/bank-reconciliations/${openId}`) : Promise.resolve(null)),
    [openId],
  );

  const [form, setForm] = useState({ start: '', end: '', opening: '', closing: '' });
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      bank_account_id: accountId,
      statement_start_date: form.start,
      statement_end_date: form.end,
      statement_opening_balance: form.opening,
      statement_closing_balance: form.closing,
    };
    try {
      const created = await api<{ id: string }>('/bank-reconciliations', {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor('recon', body),
      });
      keys.settle('recon');
      setForm({ start: '', end: '', opening: '', closing: '' });
      setOpenId(created.id);
      sessions.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const act = async (id: string, action: 'complete' | 'reopen') => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = action === 'reopen' ? { reason } : {};
    try {
      await api(`/bank-reconciliations/${id}/${action}`, {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor(`recon-${action}-${id}`, body),
      });
      keys.settle(`recon-${action}-${id}`);
      setNotice(
        action === 'complete'
          ? 'Completed and locked. Everything it cleared is now reconciled.'
          : 'Reopened. The reason is on the record.',
      );
      setReason('');
      sessions.reload();
      working.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const view = working.data;

  return (
    <>
      <PageHeader
        title="Bank reconciliation"
        description="A session per statement period. Completing is permitted only when the difference is within the tenant's tolerance."
      />
      <ErrorBanner error={error ?? sessions.error ?? working.error} />
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
          label="Bank account"
          name="bank_account"
          value={accountId}
          onChange={setAccountId}
          required
          options={(accounts.data?.data ?? []).map((a) => ({
            value: a.id,
            label: `${a.name} (${a.currency})`,
          }))}
        />
      </div>

      {accountId ? (
        <>
          <DataTable<Reconciliation>
            caption="Reconciliation sessions"
            rows={sessions.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No sessions for this account yet."
            columns={[
              {
                key: 'period',
                header: 'Statement period',
                render: (row) =>
                  `${row.statement_start_date.slice(0, 10)} → ${row.statement_end_date.slice(0, 10)}`,
              },
              {
                key: 'statement',
                header: 'Statement close',
                numeric: true,
                render: (row) => money(row.statement_closing_balance),
              },
              {
                key: 'book',
                header: 'Book close',
                numeric: true,
                render: (row) => money(row.book_closing_balance),
              },
              {
                key: 'difference',
                header: 'Difference',
                numeric: true,
                render: (row) => money(row.difference),
              },
              { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
              {
                key: 'open',
                header: 'Work',
                render: (row) => <Button onClick={() => setOpenId(row.id)}>Open</Button>,
              },
            ]}
          />

          {view ? (
            <div className="card">
              <h2>
                {view.statement_start_date.slice(0, 10)} → {view.statement_end_date.slice(0, 10)}{' '}
                <Status value={view.status} />
              </h2>
              <dl className="summary-list">
                <div>
                  <dt>Statement opening</dt>
                  <dd>{money(view.statement_opening_balance)}</dd>
                </div>
                <div>
                  <dt>Statement closing</dt>
                  <dd>{money(view.statement_closing_balance)}</dd>
                </div>
                <div>
                  <dt>Book closing</dt>
                  <dd>{money(view.book_closing_balance)}</dd>
                </div>
                <div>
                  <dt>Difference</dt>
                  <dd>{money(view.difference)}</dd>
                </div>
                <div>
                  <dt>Explained by unmatched lines</dt>
                  <dd>{money(view.unexplained_total)}</dd>
                </div>
                <div>
                  <dt>Remaining after those</dt>
                  <dd>{money(view.adjusted_difference)}</dd>
                </div>
                <div>
                  <dt>Lines still unresolved</dt>
                  <dd>{view.unresolved_count}</dd>
                </div>
              </dl>

              {view.status === 'COMPLETED' ? (
                <>
                  <Notice tone="info">
                    Completed on {view.completed_at?.slice(0, 10)} and locked. Correcting it means
                    reopening it, which is a separate permission and is recorded with a reason.
                    {view.reopen_reason ? ` Previously reopened: ${view.reopen_reason}` : ''}
                  </Notice>
                  {can('bank.reconcile_reopen') ? (
                    <>
                      <Field
                        label="Reason for reopening"
                        name="reason"
                        value={reason}
                        onChange={setReason}
                        required
                        hint="Stored on the session. Someone may have relied on the closed figure."
                      />
                      <Button
                        variant="danger"
                        busy={busy}
                        disabled={!reason}
                        onClick={() => act(view.id, 'reopen')}
                      >
                        Reopen
                      </Button>
                    </>
                  ) : null}
                </>
              ) : can('bank.reconcile') ? (
                <Button variant="primary" busy={busy} onClick={() => act(view.id, 'complete')}>
                  Complete reconciliation
                </Button>
              ) : null}
            </div>
          ) : null}

          {can('bank.reconcile') ? (
            <form onSubmit={create} className="card">
              <h2>New session</h2>
              <Field
                label="Statement start"
                name="start"
                type="date"
                value={form.start}
                onChange={(v) => setForm({ ...form, start: v })}
                required
              />
              <Field
                label="Statement end"
                name="end"
                type="date"
                value={form.end}
                onChange={(v) => setForm({ ...form, end: v })}
                required
              />
              <Field
                label="Opening balance"
                name="opening"
                value={form.opening}
                onChange={(v) => setForm({ ...form, opening: v })}
                required
                placeholder="0.00"
              />
              <Field
                label="Closing balance"
                name="closing"
                value={form.closing}
                onChange={(v) => setForm({ ...form, closing: v })}
                required
                placeholder="0.00"
                hint="As printed on the statement. The book side is derived; the difference between them is the work."
              />
              <Button type="submit" variant="primary" busy={busy}>
                Open session
              </Button>
            </form>
          ) : null}
        </>
      ) : (
        <p className="empty">Choose a bank account to see its reconciliations.</p>
      )}
    </>
  );
}
