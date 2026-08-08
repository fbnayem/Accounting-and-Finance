'use client';

import { useState } from 'react';
import { api, newIdempotencyKey } from '../../../lib/api';
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

interface Branch {
  id: string;
  legal_entity_id: string;
  code: string;
  name: string;
  country_code: string | null;
  valid_from: string | null;
  valid_to: string | null;
  status: string;
}

/**
 * Branch list — doc 02's core screen.
 *
 * doc 02: "Branch is an analytical/operational dimension unless statutory
 * separation requires another legal entity." Worth saying on the screen, because
 * the decision to model a location as a branch or as an entity is the one people
 * get wrong, and it is expensive to reverse once either has posted.
 */
export default function BranchesPage() {
  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');
  const branches = useResource(
    () =>
      api<{ data: Branch[] }>(
        '/branches',
        entityId ? { query: { legal_entity_id: entityId } } : {},
      ),
    [entityId],
  );

  const [form, setForm] = useState({ code: '', name: '', country_code: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/branches', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('branch'),
        body: {
          legal_entity_id: entityId,
          code: form.code,
          name: form.name,
          country_code: form.country_code || undefined,
        },
      });
      setForm({ code: '', name: '', country_code: '' });
      branches.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Branches"
        description="Operational units within a legal entity: locations, depots, shops."
      />
      <ErrorBanner error={error} />
      <Notice>
        A branch is an analytical and operational dimension. If a location needs its own statutory
        books, tax registration or filings, it is a legal entity instead — and choosing wrongly is
        expensive to undo once either has posted.
      </Notice>

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

      <DataTable<Branch>
        caption="Branches"
        rows={branches.data?.data ?? []}
        rowKey={(row) => row.id}
        empty="No branches. Many businesses need none."
        columns={[
          { key: 'code', header: 'Code', render: (row) => row.code },
          { key: 'name', header: 'Name', render: (row) => row.name },
          { key: 'country', header: 'Country', render: (row) => row.country_code ?? '—' },
          { key: 'from', header: 'Valid from', render: (row) => row.valid_from ?? '—' },
          { key: 'to', header: 'Valid to', render: (row) => row.valid_to ?? 'open' },
          { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
        ]}
      />

      {entityId ? (
        <form onSubmit={create} className="card">
          <h2>New branch</h2>
          <Field label="Code" name="code" value={form.code} onChange={set('code')} required />
          <Field label="Name" name="name" value={form.name} onChange={set('name')} required />
          <Field
            label="Country"
            name="country_code"
            value={form.country_code}
            onChange={set('country_code')}
            hint="Optional. ISO 3166-1 alpha-2."
          />
          <Button type="submit" variant="primary" busy={busy}>
            Create branch
          </Button>
        </form>
      ) : null}
    </>
  );
}
