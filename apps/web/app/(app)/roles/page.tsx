'use client';

import { useState } from 'react';
import { api } from '../../../lib/api';
import {
  Button,
  DataTable,
  ErrorBanner,
  Notice,
  PageHeader,
  useResource,
} from '../../../components/ui';

interface Role {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_system: boolean;
  permissions: string[];
  member_count: number;
  etag: string;
}

/**
 * Roles — doc 02's core screen for RBAC.
 *
 * The eleven system roles are the tenant's own copy of the templates, not a live
 * link to them, so a tenant can adjust one without changing everybody else's. A
 * system role that is edited stops being marked as a template, because a role
 * called "Accountant" that no longer matches the Accountant template is more
 * confusing labelled than unlabelled.
 */
export default function RolesPage() {
  const roles = useResource(() => api<{ data: Role[] }>('/roles'));
  const permissions = useResource(() =>
    api<{
      data: { code: string; resource: string; action: string; is_high_risk: boolean }[];
    }>('/permissions'),
  );

  const [editing, setEditing] = useState<Role | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const startEdit = (role: Role) => {
    setEditing(role);
    setSelected(new Set(role.permissions));
    setError(null);
  };

  const toggle = (code: string) => {
    const next = new Set(selected);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    setSelected(next);
  };

  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/roles/${editing.id}`, {
        method: 'PATCH',
        ifMatch: editing.etag,
        body: { permissions: [...selected] },
      });
      setEditing(null);
      roles.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const grouped = new Map<string, { code: string; is_high_risk: boolean }[]>();
  for (const permission of permissions.data?.data ?? []) {
    const list = grouped.get(permission.resource) ?? [];
    list.push({ code: permission.code, is_high_risk: permission.is_high_risk });
    grouped.set(permission.resource, list);
  }

  return (
    <>
      <PageHeader
        title="Roles"
        description="A role is a named set of permissions. Assignment is scoped to the tenant, an organization, a legal entity or a branch."
      />
      <ErrorBanner error={error} />

      <DataTable<Role>
        caption="Roles in this tenant"
        rows={roles.data?.data ?? []}
        rowKey={(row) => row.id}
        columns={[
          { key: 'name', header: 'Role', render: (row) => row.name },
          {
            key: 'kind',
            header: 'Origin',
            render: (row) => (row.is_system ? 'System template' : 'Customised'),
          },
          {
            key: 'permissions',
            header: 'Permissions',
            numeric: true,
            render: (row) => row.permissions.length,
          },
          { key: 'members', header: 'Members', numeric: true, render: (row) => row.member_count },
          {
            key: 'actions',
            header: 'Actions',
            render: (row) => <Button onClick={() => startEdit(row)}>Edit permissions</Button>,
          },
        ]}
      />

      {editing ? (
        <section className="card">
          <h2>{editing.name}</h2>
          <p className="page-description">{editing.description}</p>
          <Notice>
            You can only grant permissions you hold yourself. Anything else would make &ldquo;manage
            roles&rdquo; equivalent to every permission in the system — create a role holding
            everything, assign it to yourself, done.
          </Notice>
          <div className="permission-grid">
            {[...grouped.entries()].map(([resource, list]) => (
              <fieldset key={resource}>
                <legend>{resource.replace(/_/g, ' ')}</legend>
                {list.map((permission) => (
                  <label key={permission.code} className="checkbox">
                    <input
                      type="checkbox"
                      checked={selected.has(permission.code)}
                      onChange={() => toggle(permission.code)}
                    />
                    <span>
                      {permission.code.split('.')[1]?.replace(/_/g, ' ')}
                      {permission.is_high_risk ? (
                        <span className="tag tag-danger"> high risk</span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </fieldset>
            ))}
          </div>
          <div className="button-row">
            <Button variant="primary" onClick={() => void save()} busy={busy}>
              Save {selected.size} permissions
            </Button>
            <Button onClick={() => setEditing(null)}>Cancel</Button>
          </div>
        </section>
      ) : null}
    </>
  );
}
