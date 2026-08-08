'use client';

import { useState } from 'react';
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

interface Period {
  id: string;
  period_no: number;
  name: string;
  start_date: string;
  end_date: string;
  is_adjustment: boolean;
  status: 'OPEN' | 'SOFT_CLOSED' | 'HARD_CLOSED';
  closed_reason: string | null;
  reopened_reason: string | null;
}

/**
 * Fiscal calendar — doc 02's core screen for periods, and the surface behind
 * Phase 1 exit criterion 3.
 *
 * The three transitions are separate routes on purpose (the contract supersedes
 * doc 02's single `PATCH /periods/{id}/status`): they need different permissions,
 * hard close and reopen need a reason, and reopen is one of doc 02's seven
 * high-risk permissions and demands recent multi-factor authentication.
 */
export default function FiscalCalendarPage() {
  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');
  const years = useResource(
    () =>
      entityId
        ? api<{
            data: {
              id: string;
              name: string;
              start_date: string;
              end_date: string;
              period_count: number;
            }[];
          }>('/fiscal-years', { query: { legal_entity_id: entityId } })
        : Promise.resolve({ data: [] }),
    [entityId],
  );
  const periods = useResource(
    () =>
      entityId
        ? api<{ data: Period[] }>('/accounting-periods', { query: { legal_entity_id: entityId } })
        : Promise.resolve({ data: [] }),
    [entityId],
  );

  const [form, setForm] = useState({
    name: '',
    start_date: '',
    end_date: '',
    adjustment_periods: '1',
    period_length: 'MONTHLY',
  });
  const [reason, setReason] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });
  const fieldError = (name: string) =>
    error instanceof ApiError ? error.forField(name) : undefined;

  const createYear = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/fiscal-years', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('fy'),
        body: {
          legal_entity_id: entityId,
          name: form.name,
          start_date: form.start_date,
          end_date: form.end_date,
          period_length: form.period_length,
          adjustment_periods: Number(form.adjustment_periods),
        },
      });
      years.reload();
      periods.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const transition = async (period: Period, action: 'soft-close' | 'hard-close' | 'reopen') => {
    setError(null);
    try {
      await api(`/accounting-periods/${period.id}/${action}`, {
        method: 'POST',
        // x-idempotency: required on all three. The key includes the period, so one
        // key can never be reused to close a different month.
        idempotencyKey: newIdempotencyKey(`${action}-${period.id}`),
        body: reason ? { reason } : {},
      });
      setReason('');
      periods.reload();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Fiscal calendar"
        description="Fiscal years and their accounting periods. posting_date decides which period a document lands in."
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
          hint="Each entity keeps its own calendar."
        />
      </div>

      {entityId ? (
        <>
          <DataTable
            caption="Fiscal years"
            rows={years.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No fiscal year yet. Create one below — periods are generated with it."
            columns={[
              { key: 'name', header: 'Name', render: (row) => row.name },
              { key: 'start', header: 'Starts', render: (row) => row.start_date },
              { key: 'end', header: 'Ends', render: (row) => row.end_date },
              {
                key: 'periods',
                header: 'Periods',
                numeric: true,
                render: (row) => row.period_count,
              },
            ]}
          />

          <h2>Periods</h2>
          <Notice>
            A soft close still admits privileged posting; a hard close does not. Periods are
            hard-closed in order, because a posting into an earlier one would move the opening
            balances a later one was signed off against. Reopening is high-risk: it needs a reason,
            an audit entry and recent multi-factor authentication.
          </Notice>
          <div className="card">
            <Field
              label="Reason"
              name="reason"
              value={reason}
              onChange={setReason}
              hint="Required for a hard close and for a reopen. Recorded in the audit trail."
              error={fieldError('reason')}
            />
          </div>
          <DataTable<Period>
            caption="Accounting periods"
            rows={periods.data?.data ?? []}
            rowKey={(row) => row.id}
            columns={[
              { key: 'no', header: '#', numeric: true, render: (row) => row.period_no },
              {
                key: 'name',
                header: 'Period',
                render: (row) => (
                  <>
                    {row.name}
                    {row.is_adjustment ? <span className="tag"> adjustment</span> : null}
                  </>
                ),
              },
              { key: 'start', header: 'Starts', render: (row) => row.start_date },
              { key: 'end', header: 'Ends', render: (row) => row.end_date },
              { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
              {
                key: 'actions',
                header: 'Actions',
                render: (row) => (
                  <div className="button-row">
                    {row.status === 'OPEN' ? (
                      <Button onClick={() => void transition(row, 'soft-close')}>Soft close</Button>
                    ) : null}
                    {row.status !== 'HARD_CLOSED' ? (
                      <Button onClick={() => void transition(row, 'hard-close')}>Hard close</Button>
                    ) : null}
                    {row.status !== 'OPEN' ? (
                      <Button variant="danger" onClick={() => void transition(row, 'reopen')}>
                        Reopen
                      </Button>
                    ) : null}
                  </div>
                ),
              },
            ]}
          />

          <form onSubmit={createYear} className="card">
            <h2>New fiscal year</h2>
            <Field
              label="Name"
              name="name"
              value={form.name}
              onChange={set('name')}
              required
              placeholder="FY2027"
              error={fieldError('name')}
            />
            <Field
              label="Starts"
              name="start_date"
              type="date"
              value={form.start_date}
              onChange={set('start_date')}
              required
              error={fieldError('start_date')}
            />
            <Field
              label="Ends"
              name="end_date"
              type="date"
              value={form.end_date}
              onChange={set('end_date')}
              required
              error={fieldError('end_date')}
            />
            <Field
              label="Period length"
              name="period_length"
              value={form.period_length}
              onChange={set('period_length')}
              options={[
                { value: 'MONTHLY', label: 'Monthly (12 periods)' },
                { value: 'QUARTERLY', label: 'Quarterly (4 periods)' },
              ]}
            />
            <Field
              label="Adjustment periods"
              name="adjustment_periods"
              type="number"
              value={form.adjustment_periods}
              onChange={set('adjustment_periods')}
              hint="Overlap the last regular period and carry year-end and audit entries, so they do not move the trading months."
            />
            <Button type="submit" variant="primary" busy={busy}>
              Create fiscal year and periods
            </Button>
          </form>
        </>
      ) : null}
    </>
  );
}
