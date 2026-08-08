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

interface Membership {
  membership_id: string;
  role_code: string;
  legal_entity_id: string | null;
  status: string;
  suspended_at: string | null;
}

interface User {
  id: string;
  email: string;
  display_name: string;
  status: string;
  mfa_enrolled: boolean;
  last_login_at: string | null;
  memberships: Membership[];
}

/**
 * Users — doc 02's core screen for people, and the invite half of the
 * invite/accept flow.
 *
 * Two things worth knowing while reading this screen, both from ADR-0005:
 * suspending someone here suspends their *membership of this tenant*, not their
 * account, so a bookkeeper is not locked out of their other clients; and the
 * invitation token is shown exactly once, because only its hash is stored.
 */
export default function UsersPage() {
  const users = useResource(() => api<{ data: User[] }>('/users'));
  const roles = useResource(() =>
    api<{ data: { id: string; code: string; name: string }[] }>('/roles'),
  );
  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );

  const [form, setForm] = useState({ email: '', role_id: '', legal_entity_id: '' });
  const [invitation, setInvitation] = useState<{ token: string; url: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });
  const fieldError = (name: string) =>
    error instanceof ApiError ? error.forField(name) : undefined;

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setInvitation(null);
    try {
      const result = await api<{ invitation_token: string; accept_url: string }>('/users/invite', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('invite'),
        body: {
          email: form.email,
          role_id: form.role_id,
          legal_entity_id: form.legal_entity_id || undefined,
        },
      });
      setInvitation({ token: result.invitation_token, url: result.accept_url });
      setForm({ ...form, email: '' });
      users.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const setSuspension = async (user: User, suspended: boolean) => {
    setError(null);
    try {
      await api(`/users/${user.id}/${suspended ? 'suspend' : 'reactivate'}`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('suspend'),
      });
      users.reload();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Users"
        description="Everyone with a membership in this tenant. Identity is platform-wide; access is per tenant and comes only from memberships."
      />
      <ErrorBanner error={error} />

      {invitation ? (
        <Notice tone="success">
          <p>
            Invitation created. Send this link — it is shown once and cannot be retrieved again.
          </p>
          <p>
            <code className="token">{invitation.url}</code>
          </p>
        </Notice>
      ) : null}

      <DataTable<User>
        caption="Users in this tenant"
        rows={users.data?.data ?? []}
        rowKey={(row) => row.id}
        columns={[
          { key: 'name', header: 'Name', render: (row) => row.display_name },
          { key: 'email', header: 'Email', render: (row) => row.email },
          {
            key: 'roles',
            header: 'Roles',
            render: (row) =>
              row.memberships
                .map((m) => (m.legal_entity_id ? `${m.role_code} (one entity)` : m.role_code))
                .join(', '),
          },
          {
            key: 'mfa',
            header: 'MFA',
            render: (row) => (row.mfa_enrolled ? 'Enrolled' : 'Not enrolled'),
          },
          {
            key: 'status',
            header: 'Membership',
            render: (row) => (
              <Status value={row.memberships.some((m) => m.suspended_at) ? 'INACTIVE' : 'ACTIVE'} />
            ),
          },
          {
            key: 'actions',
            header: 'Actions',
            render: (row) =>
              row.memberships.some((m) => m.suspended_at) ? (
                <Button onClick={() => void setSuspension(row, false)}>Reactivate</Button>
              ) : (
                <Button variant="danger" onClick={() => void setSuspension(row, true)}>
                  Suspend
                </Button>
              ),
          },
        ]}
      />

      <form onSubmit={invite} className="card">
        <h2>Invite someone</h2>
        <Notice>
          Leaving the entity blank grants the role across every entity in the tenant. Choosing one
          restricts them to it — they will not see the others at all, not merely be refused when
          they try.
        </Notice>
        <Field
          label="Email address"
          name="email"
          type="email"
          value={form.email}
          onChange={set('email')}
          required
          error={fieldError('email')}
        />
        <Field
          label="Role"
          name="role_id"
          value={form.role_id}
          onChange={set('role_id')}
          required
          options={(roles.data?.data ?? []).map((r) => ({ value: r.id, label: r.name }))}
          hint="You can only grant a role whose permissions you hold yourself."
          error={fieldError('role_id')}
        />
        <Field
          label="Restrict to legal entity"
          name="legal_entity_id"
          value={form.legal_entity_id}
          onChange={set('legal_entity_id')}
          options={(entities.data?.data ?? []).map((e) => ({
            value: e.id,
            label: `${e.code} — ${e.legal_name}`,
          }))}
          hint="Optional. Leave blank for tenant-wide access."
        />
        <Button type="submit" variant="primary" busy={busy}>
          Send invitation
        </Button>
      </form>
    </>
  );
}
