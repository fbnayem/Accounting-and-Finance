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

interface Account {
  id: string;
  code: string;
  name: string;
  account_type: string;
  normal_balance: string;
  subtype: string | null;
  is_posting: boolean;
  is_control: boolean;
  is_system: boolean;
  status: string;
  version: string;
  group_code: string | null;
  has_postings: boolean;
}

/**
 * Chart of accounts — doc 03's first data object.
 *
 * The screen shows `has_postings` on every row because three of doc 03's chart
 * rules turn on it: a used account is archived rather than deleted, its type cannot
 * change once posted to, and a control account rejects manual posting. Showing the
 * fact rather than only enforcing it means the rules are visible before someone
 * runs into them.
 */
export default function AccountsPage() {
  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');
  const [search, setSearch] = useState('');

  const accounts = useResource(
    () =>
      entityId
        ? api<{ data: Account[] }>('/accounts', {
            query: { legal_entity_id: entityId, ...(search ? { search } : {}) },
          })
        : Promise.resolve({ data: [] }),
    [entityId, search],
  );
  const groups = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; name: string }[] }>('/account-groups', {
            query: { legal_entity_id: entityId },
          })
        : Promise.resolve({ data: [] }),
    [entityId],
  );

  const [form, setForm] = useState({
    code: '',
    name: '',
    account_type: 'EXPENSE',
    subtype: '',
    group_id: '',
    is_control: 'no',
    is_posting: 'yes',
  });
  const [groupForm, setGroupForm] = useState({ code: '', name: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });
  const fieldError = (name: string) =>
    error instanceof ApiError ? error.forField(name) : undefined;

  const createAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/accounts', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('account'),
        body: {
          legal_entity_id: entityId,
          code: form.code,
          name: form.name,
          account_type: form.account_type,
          ...(form.subtype ? { subtype: form.subtype } : {}),
          ...(form.group_id ? { group_id: form.group_id } : {}),
          is_control: form.is_control === 'yes',
          is_posting: form.is_posting === 'yes',
        },
      });
      setForm({ ...form, code: '', name: '', subtype: '' });
      accounts.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const createGroup = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await api('/account-groups', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('group'),
        body: { legal_entity_id: entityId, code: groupForm.code, name: groupForm.name },
      });
      setGroupForm({ code: '', name: '' });
      groups.reload();
    } catch (err) {
      setError(err);
    }
  };

  const archive = async (account: Account) => {
    setError(null);
    try {
      await api(`/accounts/${account.id}`, {
        method: 'PATCH',
        ifMatch: account.version,
        body: { status: 'ARCHIVED' },
      });
      accounts.reload();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Chart of accounts"
        description="Accounts are scoped to a legal entity, not to a book — one chart, with book-specific overrides where a book genuinely differs (ADR-0003 §2)."
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

      {entityId ? (
        <>
          <Notice>
            An account that has been posted to is archived, never deleted, and its type is locked —
            changing it would restate every period it appears in. Both rules are enforced by the
            database as well as here.
          </Notice>

          <div className="card">
            <Field
              label="Search"
              name="search"
              value={search}
              onChange={setSearch}
              placeholder="Code or name"
            />
          </div>

          <DataTable<Account>
            caption="Accounts"
            rows={accounts.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No accounts yet. Create the first one below."
            columns={[
              { key: 'code', header: 'Code', render: (row) => row.code },
              { key: 'name', header: 'Name', render: (row) => row.name },
              { key: 'type', header: 'Type', render: (row) => row.account_type },
              { key: 'balance', header: 'Normal', render: (row) => row.normal_balance },
              { key: 'group', header: 'Group', render: (row) => row.group_code ?? '—' },
              {
                key: 'flags',
                header: 'Flags',
                render: (row) => (
                  <>
                    {row.is_control ? <span className="tag">control</span> : null}
                    {!row.is_posting ? <span className="tag">heading</span> : null}
                    {row.is_system ? <span className="tag">system</span> : null}
                    {row.has_postings ? <span className="tag">posted to</span> : null}
                  </>
                ),
              },
              { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
              {
                key: 'actions',
                header: 'Actions',
                render: (row) =>
                  row.status === 'ACTIVE' && !row.is_system ? (
                    <Button onClick={() => void archive(row)}>Archive</Button>
                  ) : (
                    <span className="field-hint">—</span>
                  ),
              },
            ]}
          />

          <form onSubmit={createAccount} className="card">
            <h2>New account</h2>
            <Field
              label="Code"
              name="code"
              value={form.code}
              onChange={set('code')}
              required
              placeholder="6000"
              error={fieldError('code')}
            />
            <Field
              label="Name"
              name="name"
              value={form.name}
              onChange={set('name')}
              required
              placeholder="Operating expense"
              error={fieldError('name')}
            />
            <Field
              label="Type"
              name="account_type"
              value={form.account_type}
              onChange={set('account_type')}
              options={[
                { value: 'ASSET', label: 'Asset' },
                { value: 'LIABILITY', label: 'Liability' },
                { value: 'EQUITY', label: 'Equity' },
                { value: 'REVENUE', label: 'Revenue' },
                { value: 'EXPENSE', label: 'Expense' },
              ]}
              hint="Sets the normal balance. A contra account can override it after creation."
            />
            <Field
              label="Subtype"
              name="subtype"
              value={form.subtype}
              onChange={set('subtype')}
              placeholder="bank, accumulated_depreciation, retained_earnings…"
            />
            <Field
              label="Group"
              name="group_id"
              value={form.group_id}
              onChange={set('group_id')}
              options={(groups.data?.data ?? []).map((g) => ({
                value: g.id,
                label: `${g.code} — ${g.name}`,
              }))}
              hint="Reporting hierarchy. The Balance Sheet groups by this."
            />
            <Field
              label="Control account"
              name="is_control"
              value={form.is_control}
              onChange={set('is_control')}
              options={[
                { value: 'no', label: 'No' },
                { value: 'yes', label: 'Yes — reconciles to a subledger' },
              ]}
              hint="A manual posting to a control account needs journal.post_control, because it breaks the subledger reconciliation Gate D tests."
            />
            <Field
              label="Accepts postings"
              name="is_posting"
              value={form.is_posting}
              onChange={set('is_posting')}
              options={[
                { value: 'yes', label: 'Yes' },
                { value: 'no', label: 'No — a reporting heading only' },
              ]}
            />
            <Button type="submit" variant="primary" busy={busy}>
              Create account
            </Button>
          </form>

          <form onSubmit={createGroup} className="card">
            <h2>New account group</h2>
            <Field
              label="Code"
              name="group_code"
              value={groupForm.code}
              onChange={(v) => setGroupForm({ ...groupForm, code: v })}
              required
              placeholder="CURRENT_ASSETS"
            />
            <Field
              label="Name"
              name="group_name"
              value={groupForm.name}
              onChange={(v) => setGroupForm({ ...groupForm, name: v })}
              required
              placeholder="Current assets"
            />
            <Button type="submit">Create group</Button>
          </form>
        </>
      ) : null}
    </>
  );
}
