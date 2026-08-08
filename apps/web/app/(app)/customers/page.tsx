'use client';

import { useState } from 'react';
import { ApiError, api } from '../../../lib/api';
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

interface Customer {
  id: string;
  organization_id: string;
  legal_entity_id: string | null;
  code: string | null;
  legal_name: string;
  display_name: string | null;
  email: string | null;
  default_currency: string | null;
  payment_terms_days: number | null;
  credit_limit: string | null;
  status: string;
  version: string;
}

interface Duplicate {
  id: string;
  legal_name: string;
  matched_on: string;
}

interface StatementLine {
  kind: string;
  reference: string | null;
  date: string;
  currency: string;
  debit: string;
  credit: string;
  document_id: string;
  due_date: string | null;
}

interface Statement {
  customer_id: string;
  customer_name?: string;
  period?: { from: string; to: string };
  opening_balance: string;
  lines: StatementLine[];
  closing_balance: string;
}

const money = (value: string | null): string =>
  value == null
    ? '—'
    : Number(value).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const monthStart = (): string => today().slice(0, 8) + '01';

/**
 * Customers — doc 04's customer master.
 *
 * Duplicate signals from the API arrive as a warning on the created record, not
 * as a refusal: doc 02 warns rather than refuses because two branches of one
 * group genuinely do share a tax identifier, and refusing would make the
 * legitimate case impossible while the accidental one is merely inconvenient.
 */
export default function CustomersPage() {
  const held = useHeldPermissions();
  const can = (permission: string) => !held || held.has(permission);
  const keys = useIdempotencyKeys();

  const organizations = useResource(() =>
    api<{ data: { id: string; name: string }[] }>('/organizations'),
  );
  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );

  const [search, setSearch] = useState('');
  const customers = useResource(
    () => api<{ data: Customer[] }>('/customers', { query: { ...(search ? { search } : {}) } }),
    [search],
  );

  const [form, setForm] = useState({
    organization_id: '',
    legal_entity_id: '',
    code: '',
    legal_name: '',
    display_name: '',
    email: '',
    phone: '',
    tax_identifier: '',
    default_currency: '',
    payment_terms_days: '',
    credit_limit: '',
    ar_account_id: '',
    revenue_account_id: '',
    sales_tax_code_id: '',
  });
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });

  // Account and tax-code defaults belong to the entity the customer is scoped
  // to, so the option lists follow the entity chosen in the form.
  const accounts = useResource(
    () =>
      form.legal_entity_id
        ? api<{ data: { id: string; code: string; name: string }[] }>('/accounts', {
            query: { legal_entity_id: form.legal_entity_id, posting_only: 'true' },
          })
        : Promise.resolve({ data: [] }),
    [form.legal_entity_id],
  );
  const taxCodes = useResource(
    () =>
      form.legal_entity_id
        ? api<{ data: { id: string; code: string; name: string }[] }>('/tax-codes', {
            query: { legal_entity_id: form.legal_entity_id },
          })
        : Promise.resolve({ data: [] }),
    [form.legal_entity_id],
  );

  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; duplicates: Duplicate[] } | null>(null);
  const fieldError = (name: string) =>
    error instanceof ApiError ? error.forField(name) : undefined;

  const createCustomer = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setCreated(null);
    const body = {
      organization_id: form.organization_id,
      legal_name: form.legal_name,
      ...(form.legal_entity_id ? { legal_entity_id: form.legal_entity_id } : {}),
      ...(form.code ? { code: form.code } : {}),
      ...(form.display_name ? { display_name: form.display_name } : {}),
      ...(form.email ? { email: form.email } : {}),
      ...(form.phone ? { phone: form.phone } : {}),
      ...(form.tax_identifier ? { tax_identifier: form.tax_identifier } : {}),
      ...(form.default_currency ? { default_currency: form.default_currency } : {}),
      ...(form.payment_terms_days ? { payment_terms_days: Number(form.payment_terms_days) } : {}),
      ...(form.credit_limit ? { credit_limit: form.credit_limit } : {}),
      ...(form.ar_account_id ? { ar_account_id: form.ar_account_id } : {}),
      ...(form.revenue_account_id ? { revenue_account_id: form.revenue_account_id } : {}),
      ...(form.sales_tax_code_id ? { sales_tax_code_id: form.sales_tax_code_id } : {}),
    };
    try {
      const result = await api<{ legal_name: string; possible_duplicates?: Duplicate[] }>(
        '/customers',
        { method: 'POST', idempotencyKey: keys.keyFor('create-customer', body), body },
      );
      keys.settle('create-customer');
      setCreated({ name: result.legal_name, duplicates: result.possible_duplicates ?? [] });
      setForm({
        ...form,
        code: '',
        legal_name: '',
        display_name: '',
        email: '',
        phone: '',
        tax_identifier: '',
        credit_limit: '',
      });
      customers.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (customer: Customer, status: 'ACTIVE' | 'ARCHIVED') => {
    setError(null);
    try {
      await api(`/customers/${customer.id}`, {
        method: 'PATCH',
        ifMatch: customer.version,
        body: { status },
      });
      customers.reload();
    } catch (err) {
      setError(err);
    }
  };

  // The statement, opened from a row. Dates default to the current month but
  // what is sent is what is in the fields.
  const [statementFor, setStatementFor] = useState<{ id: string; name: string } | null>(null);
  const [statementFrom, setStatementFrom] = useState(monthStart());
  const [statementTo, setStatementTo] = useState(today());
  const statement = useResource(
    () =>
      statementFor && statementFrom && statementTo
        ? api<Statement>(`/customers/${statementFor.id}/statement`, {
            query: { from: statementFrom, to: statementTo },
          })
        : Promise.resolve(null),
    [statementFor?.id, statementFrom, statementTo],
  );

  return (
    <>
      <PageHeader
        title="Customers"
        description="The customer master. A customer may be shared across the organization or scoped to one legal entity; what a customer owes is always per entity."
      />
      <ErrorBanner error={error} />
      {created ? (
        created.duplicates.length > 0 ? (
          <Notice tone="warning">
            <p className="banner-title">
              {created.name} was created, but it may already exist ({created.duplicates.length}{' '}
              possible duplicate{created.duplicates.length === 1 ? '' : 's'}):
            </p>
            <ul>
              {created.duplicates.map((d) => (
                <li key={d.id}>
                  <strong>{d.legal_name}</strong> — matched on {d.matched_on.replace(/_/g, ' ')}
                </li>
              ))}
            </ul>
            <p className="banner-meta">
              A warning rather than a refusal: two branches of one group genuinely do share a tax
              identifier. If this is the same customer, archive one of the records.
            </p>
          </Notice>
        ) : (
          <Notice tone="success">{created.name} was created.</Notice>
        )
      ) : null}

      <div className="card">
        <Field
          label="Search"
          name="search"
          value={search}
          onChange={setSearch}
          placeholder="Name or code"
        />
      </div>

      <DataTable<Customer>
        caption="Customers"
        rows={customers.data?.data ?? []}
        rowKey={(row) => row.id}
        empty="No customers yet. Create the first one below."
        columns={[
          { key: 'code', header: 'Code', render: (row) => row.code ?? '—' },
          { key: 'name', header: 'Legal name', render: (row) => row.legal_name },
          { key: 'email', header: 'Email', render: (row) => row.email ?? '—' },
          { key: 'currency', header: 'Currency', render: (row) => row.default_currency ?? '—' },
          {
            key: 'terms',
            header: 'Terms (days)',
            numeric: true,
            render: (row) =>
              row.payment_terms_days == null ? '—' : String(row.payment_terms_days),
          },
          {
            key: 'limit',
            header: 'Credit limit',
            numeric: true,
            render: (row) => money(row.credit_limit),
          },
          { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
          {
            key: 'actions',
            header: 'Actions',
            render: (row) => (
              <div className="button-row">
                <Button onClick={() => setStatementFor({ id: row.id, name: row.legal_name })}>
                  Statement
                </Button>
                {can('customer.edit') ? (
                  row.status === 'ACTIVE' ? (
                    <Button variant="danger" onClick={() => void setStatus(row, 'ARCHIVED')}>
                      Archive
                    </Button>
                  ) : (
                    <Button onClick={() => void setStatus(row, 'ACTIVE')}>Reactivate</Button>
                  )
                ) : null}
              </div>
            ),
          },
        ]}
      />

      {statementFor ? (
        <div className="card">
          <h2>Statement — {statementFor.name}</h2>
          <Field
            label="From"
            name="statement_from"
            type="date"
            value={statementFrom}
            onChange={setStatementFrom}
            required
          />
          <Field
            label="To"
            name="statement_to"
            type="date"
            value={statementTo}
            onChange={setStatementTo}
            required
          />
          <ErrorBanner error={statement.error} />
          {statement.data ? (
            <>
              <dl className="summary-list">
                <div>
                  <dt>Opening balance</dt>
                  <dd>{money(statement.data.opening_balance)}</dd>
                </div>
                <div>
                  <dt>Closing balance</dt>
                  <dd>{money(statement.data.closing_balance)}</dd>
                </div>
              </dl>
              <DataTable<StatementLine>
                caption={`Movements ${statementFrom} to ${statementTo}`}
                rows={statement.data.lines}
                rowKey={(row) => row.document_id + row.kind}
                empty="No movements in this period."
                columns={[
                  { key: 'date', header: 'Date', render: (row) => row.date },
                  {
                    key: 'kind',
                    header: 'Kind',
                    render: (row) => row.kind.replace(/_/g, ' ').toLowerCase(),
                  },
                  { key: 'reference', header: 'Reference', render: (row) => row.reference ?? '—' },
                  { key: 'currency', header: 'Currency', render: (row) => row.currency },
                  {
                    key: 'debit',
                    header: 'Debit',
                    numeric: true,
                    render: (row) => money(row.debit),
                  },
                  {
                    key: 'credit',
                    header: 'Credit',
                    numeric: true,
                    render: (row) => money(row.credit),
                  },
                ]}
              />
            </>
          ) : null}
          <Button onClick={() => setStatementFor(null)}>Close statement</Button>
        </div>
      ) : null}

      {can('customer.create') ? (
        <form onSubmit={createCustomer} className="card">
          <h2>New customer</h2>
          <Field
            label="Organization"
            name="organization_id"
            value={form.organization_id}
            onChange={set('organization_id')}
            required
            options={(organizations.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
            error={fieldError('organization_id')}
          />
          <Field
            label="Legal entity"
            name="legal_entity_id"
            value={form.legal_entity_id}
            onChange={set('legal_entity_id')}
            options={(entities.data?.data ?? []).map((e) => ({
              value: e.id,
              label: `${e.code} — ${e.legal_name}`,
            }))}
            hint="Leave empty to share the customer across the whole organization (F-026)."
            error={fieldError('legal_entity_id')}
          />
          <Field
            label="Legal name"
            name="legal_name"
            value={form.legal_name}
            onChange={set('legal_name')}
            required
            error={fieldError('legal_name')}
          />
          <Field
            label="Code"
            name="code"
            value={form.code}
            onChange={set('code')}
            placeholder="CUST-001"
            error={fieldError('code')}
          />
          <Field
            label="Display name"
            name="display_name"
            value={form.display_name}
            onChange={set('display_name')}
          />
          <Field
            label="Email"
            name="email"
            type="email"
            value={form.email}
            onChange={set('email')}
            error={fieldError('email')}
          />
          <Field label="Phone" name="phone" value={form.phone} onChange={set('phone')} />
          <Field
            label="Tax identifier"
            name="tax_identifier"
            value={form.tax_identifier}
            onChange={set('tax_identifier')}
            hint="Used for duplicate detection — a match warns rather than refuses."
            error={fieldError('tax_identifier')}
          />
          <Field
            label="Default currency"
            name="default_currency"
            value={form.default_currency}
            onChange={set('default_currency')}
            placeholder="GBP"
            error={fieldError('default_currency')}
          />
          <Field
            label="Payment terms (days)"
            name="payment_terms_days"
            value={form.payment_terms_days}
            onChange={set('payment_terms_days')}
            hint="Due dates default to the document date plus this."
            error={fieldError('payment_terms_days')}
          />
          <Field
            label="Credit limit"
            name="credit_limit"
            value={form.credit_limit}
            onChange={set('credit_limit')}
            hint="A block, not a warning: an invoice that would take exposure past this is refused."
            error={fieldError('credit_limit')}
          />
          <Field
            label="AR account override"
            name="ar_account_id"
            value={form.ar_account_id}
            onChange={set('ar_account_id')}
            options={(accounts.data?.data ?? []).map((a) => ({
              value: a.id,
              label: `${a.code} — ${a.name}`,
            }))}
            hint={
              form.legal_entity_id
                ? 'Leave empty to use the accounting policy default.'
                : 'Choose a legal entity above to pick entity-scoped defaults.'
            }
            error={fieldError('ar_account_id')}
          />
          <Field
            label="Revenue account default"
            name="revenue_account_id"
            value={form.revenue_account_id}
            onChange={set('revenue_account_id')}
            options={(accounts.data?.data ?? []).map((a) => ({
              value: a.id,
              label: `${a.code} — ${a.name}`,
            }))}
            error={fieldError('revenue_account_id')}
          />
          <Field
            label="Sales tax code default"
            name="sales_tax_code_id"
            value={form.sales_tax_code_id}
            onChange={set('sales_tax_code_id')}
            options={(taxCodes.data?.data ?? []).map((t) => ({
              value: t.id,
              label: `${t.code} — ${t.name}`,
            }))}
            error={fieldError('sales_tax_code_id')}
          />
          <Button type="submit" variant="primary" busy={busy}>
            Create customer
          </Button>
        </form>
      ) : null}
    </>
  );
}
