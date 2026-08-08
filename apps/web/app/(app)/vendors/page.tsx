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

interface Vendor {
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

/**
 * Vendors — doc 05's vendor master.
 *
 * Bank details are deliberately absent from this screen: they have their own
 * high-risk route with its own permission, verification and audit shape, because
 * an ordinary edit must not be a way to reach the field that decides where
 * money goes.
 */
export default function VendorsPage() {
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
  const vendors = useResource(
    () => api<{ data: Vendor[] }>('/vendors', { query: { ...(search ? { search } : {}) } }),
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
    ap_account_id: '',
    expense_account_id: '',
    purchase_tax_code_id: '',
  });
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });

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

  const createVendor = async (event: React.FormEvent) => {
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
      ...(form.ap_account_id ? { ap_account_id: form.ap_account_id } : {}),
      ...(form.expense_account_id ? { expense_account_id: form.expense_account_id } : {}),
      ...(form.purchase_tax_code_id ? { purchase_tax_code_id: form.purchase_tax_code_id } : {}),
    };
    try {
      const result = await api<{ legal_name: string; possible_duplicates?: Duplicate[] }>(
        '/vendors',
        { method: 'POST', idempotencyKey: keys.keyFor('create-vendor', body), body },
      );
      keys.settle('create-vendor');
      setCreated({ name: result.legal_name, duplicates: result.possible_duplicates ?? [] });
      setForm({
        ...form,
        code: '',
        legal_name: '',
        display_name: '',
        email: '',
        phone: '',
        tax_identifier: '',
      });
      vendors.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (vendor: Vendor, status: 'ACTIVE' | 'ARCHIVED') => {
    setError(null);
    try {
      await api(`/vendors/${vendor.id}`, {
        method: 'PATCH',
        ifMatch: vendor.version,
        body: { status },
      });
      vendors.reload();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Vendors"
        description="The vendor master. Bank details are not edited here — they have their own high-risk route with verification and independent approval (doc 05, Gate F)."
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
              A warning rather than a refusal — if this is the same vendor, archive one of the
              records before bills are keyed against both.
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

      <DataTable<Vendor>
        caption="Vendors"
        rows={vendors.data?.data ?? []}
        rowKey={(row) => row.id}
        empty="No vendors yet. Create the first one below."
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
          { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
          {
            key: 'actions',
            header: 'Actions',
            render: (row) =>
              can('vendor.edit') ? (
                row.status === 'ACTIVE' ? (
                  <Button variant="danger" onClick={() => void setStatus(row, 'ARCHIVED')}>
                    Archive
                  </Button>
                ) : (
                  <Button onClick={() => void setStatus(row, 'ACTIVE')}>Reactivate</Button>
                )
              ) : (
                <span className="field-hint">—</span>
              ),
          },
        ]}
      />

      {can('vendor.create') ? (
        <form onSubmit={createVendor} className="card">
          <h2>New vendor</h2>
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
            hint="Leave empty to share the vendor across the whole organization (F-026)."
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
            placeholder="VEND-001"
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
            hint="Bill due dates default to the document date plus this."
            error={fieldError('payment_terms_days')}
          />
          <Field
            label="AP account override"
            name="ap_account_id"
            value={form.ap_account_id}
            onChange={set('ap_account_id')}
            options={(accounts.data?.data ?? []).map((a) => ({
              value: a.id,
              label: `${a.code} — ${a.name}`,
            }))}
            hint={
              form.legal_entity_id
                ? 'Leave empty to use the accounting policy default.'
                : 'Choose a legal entity above to pick entity-scoped defaults.'
            }
            error={fieldError('ap_account_id')}
          />
          <Field
            label="Expense account default"
            name="expense_account_id"
            value={form.expense_account_id}
            onChange={set('expense_account_id')}
            options={(accounts.data?.data ?? []).map((a) => ({
              value: a.id,
              label: `${a.code} — ${a.name}`,
            }))}
            error={fieldError('expense_account_id')}
          />
          <Field
            label="Purchase tax code default"
            name="purchase_tax_code_id"
            value={form.purchase_tax_code_id}
            onChange={set('purchase_tax_code_id')}
            options={(taxCodes.data?.data ?? []).map((t) => ({
              value: t.id,
              label: `${t.code} — ${t.name}`,
            }))}
            error={fieldError('purchase_tax_code_id')}
          />
          <Button type="submit" variant="primary" busy={busy}>
            Create vendor
          </Button>
        </form>
      ) : null}
    </>
  );
}
