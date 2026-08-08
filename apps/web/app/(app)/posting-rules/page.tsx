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

interface RuleVersion {
  id: string;
  event_type: string;
  version: number;
  valid_from: string;
  valid_to: string | null;
  framework: string;
  status: string;
  entries_posted: number;
  rule_definition: unknown;
}

interface SimulatedLine {
  lineNo: number;
  accountCode: string;
  accountName: string;
  description: string | null;
  baseDebit: string;
  baseCredit: string;
  isControl: boolean;
}

const EXAMPLE = JSON.stringify(
  {
    event_type: 'SALES_INVOICE_POSTED',
    description: 'Dr AR gross; Cr revenue per line; Cr output tax per component.',
    lines: [
      {
        role: 'Accounts receivable',
        account: { policy: 'ar_control_account_id' },
        side: 'DEBIT',
        amount: { event: 'gross' },
      },
      {
        role: 'Revenue',
        account: { event: 'revenue_account_id' },
        side: 'CREDIT',
        amount: { event: 'net' },
        forEach: 'lines',
      },
      {
        role: 'Output tax',
        account: { event: 'tax_account_id' },
        side: 'CREDIT',
        amount: { event: 'amount' },
        forEach: 'tax_components',
      },
    ],
  },
  null,
  2,
);

/**
 * Posting rules and the simulation endpoint.
 *
 * doc 01 rule 7 makes versioned, effective-dated posting rules non-negotiable, and
 * the reason is on this screen: a rule that has posted entries can never be edited,
 * only superseded from a date. `entries_posted` is shown for exactly that reason —
 * it is the number that tells you whether a mistake is fixable by editing or only
 * by a new version and a set of reversals.
 *
 * The simulation runs the same resolution and the same balance rules as a real
 * posting and writes nothing. doc 03 asks it to show "the journal that would be
 * created", and the only way to keep that promise is for it to be the same journal.
 */
export default function PostingRulesPage() {
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
        : Promise.resolve({ data: [] }),
    [entityId],
  );
  const bookId = books.data?.data[0]?.id ?? '';

  const rules = useResource(
    () =>
      bookId
        ? api<{ data: RuleVersion[] }>('/posting-rules', { query: { accounting_book_id: bookId } })
        : Promise.resolve({ data: [] }),
    [bookId],
  );

  const [form, setForm] = useState({
    event_type: 'SALES_INVOICE_POSTED',
    valid_from: '',
    definition: EXAMPLE,
    supersede: 'no',
  });
  const [sim, setSim] = useState({ event_type: '', posting_date: '', payload: '{}' });
  const [simulation, setSimulation] = useState<{
    lines: SimulatedLine[];
    total_debit: string;
    total_credit: string;
    requires_post_control: boolean;
    accounting_period: { name: string; status: string };
  } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const fieldError = (name: string) =>
    error instanceof ApiError ? error.forField(name) : undefined;

  const createRule = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/posting-rules', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('posting-rule'),
        body: {
          accounting_book_id: bookId,
          event_type: form.event_type,
          valid_from: `${form.valid_from}T00:00:00Z`,
          rule_definition: JSON.parse(form.definition),
          supersede: form.supersede === 'yes',
        },
      });
      rules.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const simulate = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSimulation(null);
    try {
      const result = await api<typeof simulation>('/accounting-events/simulate', {
        method: 'POST',
        body: {
          accounting_book_id: bookId,
          event_type: sim.event_type,
          posting_date: sim.posting_date,
          payload: JSON.parse(sim.payload),
        },
      });
      setSimulation(result);
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Posting rules"
        description="How an accounting event becomes a journal. Rules are versioned and effective-dated; a historical document keeps the version it was posted under."
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
      </div>

      {bookId ? (
        <>
          <DataTable<RuleVersion>
            caption="Posting rule versions"
            rows={rules.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No posting rules yet. Phase 3 onwards installs them per module; this screen is where you see and override them."
            columns={[
              { key: 'event', header: 'Event', render: (row) => row.event_type },
              { key: 'version', header: 'Version', numeric: true, render: (row) => row.version },
              { key: 'from', header: 'Effective from', render: (row) => row.valid_from },
              { key: 'to', header: 'Until', render: (row) => row.valid_to ?? 'open' },
              { key: 'framework', header: 'Framework', render: (row) => row.framework },
              {
                key: 'posted',
                header: 'Entries posted',
                numeric: true,
                render: (row) => row.entries_posted,
              },
              { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
            ]}
          />

          <form onSubmit={simulate} className="card">
            <h2>Simulate</h2>
            <Notice>
              Resolves the rule effective on the posting date, builds the lines and validates them
              exactly as a real posting would. Writes nothing.
            </Notice>
            <Field
              label="Event type"
              name="sim_event"
              value={sim.event_type}
              onChange={(v) => setSim({ ...sim, event_type: v })}
              required
              placeholder="SALES_INVOICE_POSTED"
            />
            <Field
              label="Posting date"
              name="sim_date"
              type="date"
              value={sim.posting_date}
              onChange={(v) => setSim({ ...sim, posting_date: v })}
              required
            />
            <div className="field">
              <label htmlFor="sim-payload">Event payload (JSON)</label>
              <textarea
                id="sim-payload"
                rows={8}
                value={sim.payload}
                onChange={(e) => setSim({ ...sim, payload: e.target.value })}
              />
              <p className="field-hint">
                Money is a decimal string, never a JSON number — a number has already been through
                binary floating point by the time it is parsed.
              </p>
            </div>
            <Button type="submit">Simulate</Button>
          </form>

          {simulation ? (
            <>
              <p className="grid-balance" role="status" aria-live="polite">
                Would post into {simulation.accounting_period.name} (
                {simulation.accounting_period.status}). Debits {simulation.total_debit}, credits{' '}
                {simulation.total_credit}.
                {simulation.requires_post_control
                  ? ' Touches a control account, so it would require journal.post_control.'
                  : ''}
              </p>
              <DataTable<SimulatedLine>
                caption="The journal that would be created"
                rows={simulation.lines}
                rowKey={(row) => String(row.lineNo)}
                columns={[
                  { key: 'no', header: '#', numeric: true, render: (row) => row.lineNo },
                  {
                    key: 'account',
                    header: 'Account',
                    render: (row) => `${row.accountCode} — ${row.accountName}`,
                  },
                  { key: 'role', header: 'Role', render: (row) => row.description ?? '—' },
                  {
                    key: 'debit',
                    header: 'Debit',
                    numeric: true,
                    render: (row) => Number(row.baseDebit).toFixed(2),
                  },
                  {
                    key: 'credit',
                    header: 'Credit',
                    numeric: true,
                    render: (row) => Number(row.baseCredit).toFixed(2),
                  },
                ]}
              />
            </>
          ) : null}

          <form onSubmit={createRule} className="card">
            <h2>New rule version</h2>
            <Field
              label="Event type"
              name="event_type"
              value={form.event_type}
              onChange={(v) => setForm({ ...form, event_type: v })}
              required
              error={fieldError('event_type')}
            />
            <Field
              label="Effective from"
              name="valid_from"
              type="date"
              value={form.valid_from}
              onChange={(v) => setForm({ ...form, valid_from: v })}
              required
            />
            <Field
              label="Supersede the current version"
              name="supersede"
              value={form.supersede}
              onChange={(v) => setForm({ ...form, supersede: v })}
              options={[
                { value: 'no', label: 'No — fail if one is already effective' },
                { value: 'yes', label: 'Yes — close the current version at this date' },
              ]}
              hint="Two effective versions of one event would make rule resolution non-deterministic, so the database refuses them outright."
            />
            <div className="field">
              <label htmlFor="rule-definition">Rule definition (JSON)</label>
              <textarea
                id="rule-definition"
                rows={18}
                value={form.definition}
                onChange={(e) => setForm({ ...form, definition: e.target.value })}
                aria-describedby="rule-definition-hint"
              />
              <p className="field-hint" id="rule-definition-hint">
                Each line names a role, an account source (policy, event field or literal code), a
                side and an amount. `forEach` repeats a line over an event array; `balancing` takes
                whatever makes the journal balance.
              </p>
            </div>
            <Button type="submit" variant="primary" busy={busy}>
              Create rule version
            </Button>
          </form>
        </>
      ) : null}
    </>
  );
}
