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
import {
  Money,
  SummaryList,
  day,
  enumOptions,
  today,
  useMinorUnits,
} from '../../../components/phase5';

interface Project {
  id: string;
  organization_id: string;
  legal_entity_id: string | null;
  customer_id: string | null;
  code: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  contract_value: string | null;
  currency: string | null;
  billing_method: string | null;
  status: string;
  closed_at: string | null;
}

interface BillingProposal {
  id: string;
  project_id: string;
  period_start: string | null;
  period_end: string | null;
  currency: string;
  proposed_amount: string;
  previously_billed: string;
  unbilled_amount: string;
  status: string;
  invoice_id: string | null;
  time_entry_count: number;
  invoice: { id: string; invoice_number: string; status: string; total: string };
}

const STATUSES = ['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CLOSED'];
const BILLING_METHODS = [
  'FIXED_FEE',
  'MILESTONE',
  'TIME_AND_MATERIALS',
  'EXPENSE_REIMBURSEMENT',
  'RETAINER',
  'PROGRESS',
];

/**
 * Projects — doc 10.
 *
 * The one thing worth insisting on here is what a billing proposal is: it
 * gathers approved, billable, unbilled time and produces an AR invoice DRAFT.
 * The project module never posts revenue itself — the invoice does, on the
 * invoices screen, under its own permission. So this screen shows the proposal's
 * amount and the draft invoice it created, and says plainly that nothing has
 * been recognised yet.
 */
export default function ProjectsPage() {
  const held = useHeldPermissions();
  const can = (permission: string) => !held || held.has(permission);
  const keys = useIdempotencyKeys();
  const units = useMinorUnits();

  const organizations = useResource(() =>
    api<{ data: { id: string; name: string }[] }>('/organizations'),
  );
  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const customers = useResource(() =>
    api<{ data: { id: string; legal_name: string; code: string | null }[] }>('/customers'),
  );

  const [entityId, setEntityId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

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
  const accounts = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; name: string }[] }>('/accounts', {
            query: { legal_entity_id: entityId, posting_only: 'true' },
          })
        : Promise.resolve({ data: [] as { id: string; code: string; name: string }[] }),
    [entityId],
  );

  const projects = useResource(
    () =>
      api<{ data: Project[] }>('/projects', {
        query: { legal_entity_id: entityId, status: statusFilter },
      }),
    [entityId, statusFilter],
  );

  const [form, setForm] = useState({
    organization_id: '',
    code: '',
    name: '',
    customer_id: '',
    start_date: '',
    end_date: '',
    contract_value: '',
    currency: '',
    billing_method: 'TIME_AND_MATERIALS',
  });
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });

  const [billFor, setBillFor] = useState<Project | null>(null);
  const [billing, setBilling] = useState({
    accounting_book_id: '',
    revenue_account_id: '',
    posting_date: today(),
    period_start: '',
    period_end: '',
    due_date: '',
    notes: '',
  });
  const [proposal, setProposal] = useState<BillingProposal | null>(null);

  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      organization_id: form.organization_id,
      code: form.code,
      name: form.name,
      legal_entity_id: entityId || null,
      customer_id: form.customer_id || null,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      contract_value: form.contract_value || null,
      currency: form.currency || null,
      billing_method: form.billing_method || null,
    };
    try {
      await api('/projects', {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor('project', body),
      });
      keys.settle('project');
      setNotice(`${form.code} created.`);
      setForm({ ...form, code: '', name: '', contract_value: '' });
      projects.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const propose = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!billFor) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setProposal(null);
    const body = {
      accounting_book_id: billing.accounting_book_id || (books.data?.data[0]?.id ?? ''),
      revenue_account_id: billing.revenue_account_id,
      posting_date: billing.posting_date,
      ...(billing.period_start ? { period_start: billing.period_start } : {}),
      ...(billing.period_end ? { period_end: billing.period_end } : {}),
      ...(billing.due_date ? { due_date: billing.due_date } : {}),
      ...(billing.notes ? { notes: billing.notes } : {}),
    };
    try {
      const created = await api<BillingProposal>(`/projects/${billFor.id}/billing-proposals`, {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor(`billing-${billFor.id}`, body),
      });
      keys.settle(`billing-${billFor.id}`);
      setProposal(created);
      setNotice(
        `Draft invoice ${created.invoice.invoice_number} created from ${created.time_entry_count} ` +
          'time entries. No revenue is recognised until that invoice is posted.',
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const customerLabel = (id: string | null) =>
    id
      ? ((customers.data?.data ?? []).find((c) => c.id === id)?.legal_name ?? id.slice(0, 8))
      : '—';

  return (
    <>
      <PageHeader
        title="Projects"
        description="Project masters and billing proposals. A proposal gathers billable facts into a draft invoice; it never posts revenue itself."
      />
      <ErrorBanner error={error ?? projects.error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

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
          hint="A project may span an organization and belong to no single entity; leave empty to see those too."
        />
        <Field
          label="Status"
          name="status"
          value={statusFilter}
          onChange={setStatusFilter}
          options={enumOptions(STATUSES)}
        />
      </div>

      <DataTable<Project>
        caption="Projects"
        rows={projects.data?.data ?? []}
        rowKey={(row) => row.id}
        empty="No projects match these filters."
        columns={[
          { key: 'code', header: 'Code', render: (row) => row.code },
          { key: 'name', header: 'Name', render: (row) => row.name },
          { key: 'customer', header: 'Customer', render: (row) => customerLabel(row.customer_id) },
          {
            key: 'method',
            header: 'Billing',
            render: (row) => row.billing_method?.replace(/_/g, ' ').toLowerCase() ?? '—',
          },
          { key: 'start', header: 'Start', render: (row) => day(row.start_date) },
          { key: 'end', header: 'End', render: (row) => day(row.end_date) },
          {
            key: 'contract',
            header: 'Contract value',
            numeric: true,
            render: (row) => <Money value={row.contract_value} minorUnit={units(row.currency)} />,
          },
          { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
          {
            key: 'bill',
            header: 'Billing',
            render: (row) =>
              can('project.bill') ? (
                <Button
                  onClick={() => {
                    setBillFor(row);
                    setProposal(null);
                  }}
                >
                  Propose
                  <span className="visually-hidden"> billing for {row.code}</span>
                </Button>
              ) : (
                <span className="field-hint">needs project.bill</span>
              ),
          },
        ]}
      />

      {billFor ? (
        <form onSubmit={propose} className="card">
          <h2>
            Billing proposal — {billFor.code} {billFor.name}
          </h2>
          <p className="page-description">
            Gathers approved, billable, unbilled time and prices it at each entry&rsquo;s rate. An
            entry without a rate is refused rather than skipped: skipping it would understate the
            proposal by exactly the amount nobody is looking at.
          </p>
          <Field
            label="Accounting book"
            name="billing_book"
            value={billing.accounting_book_id || (books.data?.data[0]?.id ?? '')}
            onChange={(v) => setBilling({ ...billing, accounting_book_id: v })}
            required
            options={(books.data?.data ?? []).map((b) => ({
              value: b.id,
              label: `${b.code} (${b.base_currency})`,
            }))}
          />
          <Field
            label="Revenue account"
            name="billing_revenue"
            value={billing.revenue_account_id}
            onChange={(v) => setBilling({ ...billing, revenue_account_id: v })}
            required
            options={(accounts.data?.data ?? []).map((a) => ({
              value: a.id,
              label: `${a.code} — ${a.name}`,
            }))}
          />
          <Field
            label="Posting date"
            name="billing_posting_date"
            type="date"
            value={billing.posting_date}
            onChange={(v) => setBilling({ ...billing, posting_date: v })}
            required
          />
          <Field
            label="Period start"
            name="billing_period_start"
            type="date"
            value={billing.period_start}
            onChange={(v) => setBilling({ ...billing, period_start: v })}
          />
          <Field
            label="Period end"
            name="billing_period_end"
            type="date"
            value={billing.period_end}
            onChange={(v) => setBilling({ ...billing, period_end: v })}
          />
          <Field
            label="Invoice due date"
            name="billing_due_date"
            type="date"
            value={billing.due_date}
            onChange={(v) => setBilling({ ...billing, due_date: v })}
          />
          <Field
            label="Notes"
            name="billing_notes"
            value={billing.notes}
            onChange={(v) => setBilling({ ...billing, notes: v })}
          />
          <div className="button-row">
            <Button type="submit" variant="primary" busy={busy}>
              Create proposal
            </Button>
            <Button onClick={() => setBillFor(null)}>Cancel</Button>
          </div>

          {proposal ? (
            <SummaryList
              items={[
                {
                  term: 'Proposed',
                  value: (
                    <Money value={proposal.proposed_amount} minorUnit={units(proposal.currency)} />
                  ),
                  hint: `${proposal.time_entry_count} time entries, priced at their own rates.`,
                },
                {
                  term: 'Previously billed',
                  value: (
                    <Money
                      value={proposal.previously_billed}
                      minorUnit={units(proposal.currency)}
                    />
                  ),
                },
                {
                  term: 'Draft invoice',
                  value: proposal.invoice.invoice_number,
                  hint: 'Open it on the invoices screen to review and post it — that is where revenue is recognised.',
                },
                {
                  term: 'Invoice total',
                  value: (
                    <Money value={proposal.invoice.total} minorUnit={units(proposal.currency)} />
                  ),
                },
                { term: 'Invoice status', value: <Status value={proposal.invoice.status} /> },
              ]}
            />
          ) : null}
        </form>
      ) : null}

      {can('project.create') ? (
        <form onSubmit={create} className="card">
          <h2>New project</h2>
          <Field
            label="Organization"
            name="project_organization"
            value={form.organization_id}
            onChange={set('organization_id')}
            required
            options={(organizations.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
          />
          <Field
            label="Code"
            name="project_code"
            value={form.code}
            onChange={set('code')}
            required
          />
          <Field
            label="Name"
            name="project_name"
            value={form.name}
            onChange={set('name')}
            required
          />
          <Field
            label="Customer"
            name="project_customer"
            value={form.customer_id}
            onChange={set('customer_id')}
            options={(customers.data?.data ?? []).map((c) => ({
              value: c.id,
              label: c.code ? `${c.code} — ${c.legal_name}` : c.legal_name,
            }))}
            hint="Required before the project can be billed; internal projects have none."
          />
          <Field
            label="Billing method"
            name="project_billing_method"
            value={form.billing_method}
            onChange={set('billing_method')}
            options={enumOptions(BILLING_METHODS)}
          />
          <Field
            label="Start date"
            name="project_start"
            type="date"
            value={form.start_date}
            onChange={set('start_date')}
          />
          <Field
            label="End date"
            name="project_end"
            type="date"
            value={form.end_date}
            onChange={set('end_date')}
          />
          <Field
            label="Contract value"
            name="project_contract_value"
            value={form.contract_value}
            onChange={set('contract_value')}
            placeholder="0.00"
          />
          <Field
            label="Currency"
            name="project_currency"
            value={form.currency}
            onChange={set('currency')}
            hint="Three letters. Leave empty to take the entity's."
          />
          <Button type="submit" variant="primary" busy={busy}>
            Create project
          </Button>
        </form>
      ) : null}
    </>
  );
}
