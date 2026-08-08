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

interface Organization {
  id: string;
  name: string;
  display_name: string | null;
  status: string;
  version: string;
  settings?: Record<string, unknown>;
}

/**
 * Company setup — doc 02's second core screen.
 *
 * The rename uses `If-Match` with the row's version, which the API requires rather
 * than merely accepts. An optional precondition is one that the client which most
 * needs it — a retrying script, two administrators in the same room — is least
 * likely to send, and the failure is a silently lost update.
 */
export default function CompanyPage() {
  const { data, error, loading, reload } = useResource(() =>
    api<{ data: Organization[] }>('/organizations'),
  );
  const [editing, setEditing] = useState<Organization | null>(null);
  const [name, setName] = useState('');
  const [saveError, setSaveError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const startEdit = async (organization: Organization) => {
    // Re-read before editing: the list may be minutes old, and the version in it
    // is what If-Match will send.
    const fresh = await api<Organization>(`/organizations/${organization.id}`);
    setEditing(fresh);
    setName(fresh.name);
    setSaveError(null);
  };

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    setSaveError(null);
    try {
      await api(`/organizations/${editing.id}`, {
        method: 'PATCH',
        body: { name },
        ifMatch: editing.version,
      });
      setEditing(null);
      reload();
    } catch (err) {
      setSaveError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Company setup"
        description="Organizations are the customer workspace. Legal entities, their books and their fiscal calendars live underneath."
      />
      <ErrorBanner error={error} />
      {loading ? <p>Loading…</p> : null}

      <DataTable<Organization>
        caption="Organizations in this tenant"
        rows={data?.data ?? []}
        rowKey={(row) => row.id}
        columns={[
          { key: 'name', header: 'Name', render: (row) => row.name },
          { key: 'display', header: 'Display name', render: (row) => row.display_name ?? '—' },
          { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
          { key: 'version', header: 'Version', numeric: true, render: (row) => row.version },
          {
            key: 'actions',
            header: 'Actions',
            render: (row) => <Button onClick={() => void startEdit(row)}>Rename</Button>,
          },
        ]}
      />

      {editing ? (
        <form onSubmit={save} className="card">
          <h2>Rename {editing.name}</h2>
          <Notice>
            Saving sends <code>If-Match: {editing.version}</code>. If somebody else has changed this
            organization since you opened it, the change is refused rather than overwriting theirs.
          </Notice>
          <ErrorBanner error={saveError} />
          <Field label="Name" name="name" value={name} onChange={setName} required />
          <div className="button-row">
            <Button type="submit" variant="primary" busy={busy}>
              Save
            </Button>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </form>
      ) : null}
    </>
  );
}
