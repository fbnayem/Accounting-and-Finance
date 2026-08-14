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

interface BankAccount {
  id: string;
  legal_entity_id: string;
  account_id: string;
  bank_connection_id: string | null;
  kind: string;
  name: string;
  bank_name: string | null;
  masked_account_number: string | null;
  currency: string;
  status: string;
}

interface BankConnection {
  id: string;
  provider: string;
  external_id: string | null;
  status: string;
  consent_expires_at: string | null;
  last_sync_at: string | null;
  last_error: string | null;
}

const KINDS = ['BANK', 'CREDIT_CARD', 'CASH', 'WALLET', 'PROCESSOR_CLEARING'];

/**
 * Bank and cash accounts, and the feed connections behind them — doc 06.
 *
 * Two things on this screen are deliberate rather than incidental.
 *
 * The GL account is required and picked from posting accounts only, because a
 * bank account that maps to nothing has no book balance, and every
 * reconciliation's book side comes from that link. The API refuses a heading
 * account with ACCOUNT_NOT_POSTABLE; the picker not offering one is the courtesy
 * version of the same rule.
 *
 * The connection form has no credential field, and it is not an omission that a
 * later version fills in. doc 16 and the platform rule are absolute: a connector
 * never receives database credentials, and what is stored is a *reference* into
 * a secret manager created out of band. The API rejects anything resembling a
 * credential, and the list endpoint never returns the reference it does hold.
 */
export default function BankAccountsPage() {
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
        ? api<{ data: { id: string; code: string; name: string }[] }>('/accounts', {
            query: { legal_entity_id: entityId, posting_only: 'true' },
          })
        : Promise.resolve({ data: [] }),
    [entityId],
  );

  const bankAccounts = useResource(
    () =>
      entityId
        ? api<{ data: BankAccount[] }>('/bank-accounts', { query: { legal_entity_id: entityId } })
        : Promise.resolve({ data: [] }),
    [entityId],
  );

  const connections = useResource(
    () =>
      entityId && can('bank_connection.view')
        ? api<{ data: BankConnection[] }>('/bank-connections', {
            query: { legal_entity_id: entityId },
          })
        : Promise.resolve({ data: [] }),
    [entityId],
  );

  const [form, setForm] = useState({
    name: '',
    accountId: '',
    currency: '',
    kind: 'BANK',
    bankName: '',
    maskedAccountNumber: '',
  });
  const [connection, setConnection] = useState({ provider: '', externalId: '', configRef: '' });
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const createAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      legal_entity_id: entityId,
      account_id: form.accountId,
      name: form.name,
      currency: form.currency.toUpperCase(),
      kind: form.kind,
      bank_name: form.bankName || null,
      masked_account_number: form.maskedAccountNumber || null,
    };
    try {
      await api('/bank-accounts', {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor('bank-account', body),
      });
      keys.settle('bank-account');
      setNotice(`${form.name} created.`);
      setForm({
        name: '',
        accountId: '',
        currency: '',
        kind: 'BANK',
        bankName: '',
        maskedAccountNumber: '',
      });
      bankAccounts.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const createConnection = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      legal_entity_id: entityId,
      provider: connection.provider,
      external_id: connection.externalId || null,
      encrypted_config_ref: connection.configRef || null,
    };
    try {
      await api('/bank-connections', {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor('bank-connection', body),
      });
      keys.settle('bank-connection');
      setNotice(`Connection to ${connection.provider} recorded.`);
      setConnection({ provider: '', externalId: '', configRef: '' });
      connections.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Bank and cash accounts"
        description="Every bank, card, cash and processor-clearing account, each mapped to the GL account its book balance comes from."
      />
      <ErrorBanner error={error ?? bankAccounts.error ?? connections.error} />
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
      </div>

      {entityId ? (
        <>
          <DataTable<BankAccount>
            caption="Bank and cash accounts"
            rows={bankAccounts.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No accounts for this entity yet."
            columns={[
              { key: 'name', header: 'Name', render: (row) => row.name },
              { key: 'kind', header: 'Type', render: (row) => row.kind.replace(/_/g, ' ') },
              { key: 'bank', header: 'Institution', render: (row) => row.bank_name ?? '—' },
              {
                key: 'number',
                header: 'Account',
                render: (row) => row.masked_account_number ?? '—',
              },
              { key: 'currency', header: 'Currency', render: (row) => row.currency },
              {
                key: 'feed',
                header: 'Feed',
                render: (row) => (row.bank_connection_id ? 'Connected' : 'Manual import'),
              },
              { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
            ]}
          />

          {can('bank_account.create') ? (
            <form onSubmit={createAccount} className="card">
              <h2>New account</h2>
              <Field
                label="Name"
                name="name"
                value={form.name}
                onChange={(v) => setForm({ ...form, name: v })}
                required
              />
              <Field
                label="GL account"
                name="account_id"
                value={form.accountId}
                onChange={(v) => setForm({ ...form, accountId: v })}
                required
                hint="Where this account's movements land in the ledger. Posting accounts only — a heading has no balance to reconcile against."
                options={(accounts.data?.data ?? []).map((a) => ({
                  value: a.id,
                  label: `${a.code} — ${a.name}`,
                }))}
              />
              <Field
                label="Type"
                name="kind"
                value={form.kind}
                onChange={(v) => setForm({ ...form, kind: v })}
                required
                options={KINDS.map((k) => ({ value: k, label: k.replace(/_/g, ' ') }))}
              />
              <Field
                label="Currency"
                name="currency"
                value={form.currency}
                onChange={(v) => setForm({ ...form, currency: v })}
                required
                placeholder="GBP"
                hint="Three letters, ISO 4217."
              />
              <Field
                label="Institution"
                name="bank_name"
                value={form.bankName}
                onChange={(v) => setForm({ ...form, bankName: v })}
              />
              <Field
                label="Account number"
                name="masked_account_number"
                value={form.maskedAccountNumber}
                onChange={(v) => setForm({ ...form, maskedAccountNumber: v })}
                hint="Masked. Store the last four digits, not the full number."
              />
              <Button type="submit" variant="primary" busy={busy}>
                Create account
              </Button>
            </form>
          ) : null}

          {can('bank_connection.view') ? (
            <>
              <DataTable<BankConnection>
                caption="Feed connections"
                rows={connections.data?.data ?? []}
                rowKey={(row) => row.id}
                empty="No feed connections. Statements can still be imported as files."
                columns={[
                  { key: 'provider', header: 'Provider', render: (row) => row.provider },
                  {
                    key: 'external',
                    header: 'External ID',
                    render: (row) => row.external_id ?? '—',
                  },
                  {
                    key: 'status',
                    header: 'Status',
                    render: (row) => <Status value={row.status} />,
                  },
                  {
                    key: 'consent',
                    header: 'Consent expires',
                    render: (row) => row.consent_expires_at?.slice(0, 10) ?? '—',
                  },
                  {
                    key: 'sync',
                    header: 'Last sync',
                    render: (row) => row.last_sync_at?.slice(0, 10) ?? 'Never',
                  },
                  { key: 'error', header: 'Last error', render: (row) => row.last_error ?? '—' },
                ]}
              />

              {can('bank_connection.manage') ? (
                <form onSubmit={createConnection} className="card">
                  <h2>New connection</h2>
                  <Notice tone="info">
                    There is no password field here by design. A connector never receives
                    credentials — what is stored is a reference to a secret held in the secret
                    manager, created outside this screen. The API refuses anything that looks like a
                    credential.
                  </Notice>
                  <Field
                    label="Provider"
                    name="provider"
                    value={connection.provider}
                    onChange={(v) => setConnection({ ...connection, provider: v })}
                    required
                  />
                  <Field
                    label="External ID"
                    name="external_id"
                    value={connection.externalId}
                    onChange={(v) => setConnection({ ...connection, externalId: v })}
                    hint="The provider's own identifier for this connection, if it issues one."
                  />
                  <Field
                    label="Secret reference"
                    name="encrypted_config_ref"
                    value={connection.configRef}
                    onChange={(v) => setConnection({ ...connection, configRef: v })}
                    hint="A pointer into the secret manager, e.g. a vault path. Never the secret itself."
                  />
                  <Button type="submit" variant="primary" busy={busy}>
                    Record connection
                  </Button>
                </form>
              ) : null}
            </>
          ) : null}
        </>
      ) : (
        <p className="empty">Choose a legal entity to see its bank accounts.</p>
      )}
    </>
  );
}
