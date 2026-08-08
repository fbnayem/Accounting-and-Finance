'use client';

import { useState } from 'react';
import { api, newIdempotencyKey } from '../../../lib/api';
import { Button, DataTable, ErrorBanner, PageHeader, useResource } from '../../../components/ui';

interface Session {
  id: string;
  user: { display_name: string; email: string };
  device_label: string | null;
  ip_address: string | null;
  last_seen_at: string;
  expires_at: string;
  mfa_satisfied: boolean;
  is_current: boolean;
}

/**
 * Session list and revocation — doc 02, ADR-0005 §2.
 *
 * Revocation takes effect on the next request rather than at token expiry, because
 * the session row is read on every request. That is the whole reason the tokens
 * here are opaque rather than self-contained.
 */
export default function SessionsPage() {
  const sessions = useResource(() => api<{ data: Session[] }>('/sessions'));
  const [error, setError] = useState<unknown>(null);

  const revoke = async (session: Session) => {
    setError(null);
    try {
      await api(`/sessions/${session.id}/revoke`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('revoke'),
      });
      sessions.reload();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <>
      <PageHeader
        title="Sessions"
        description="Active sessions in this tenant. Revoking one ends it on the next request it makes."
      />
      <ErrorBanner error={error} />
      <DataTable<Session>
        caption="Active sessions"
        rows={sessions.data?.data ?? []}
        rowKey={(row) => row.id}
        columns={[
          {
            key: 'user',
            header: 'User',
            render: (row) => (
              <>
                {row.user.display_name}
                {row.is_current ? <span className="tag"> this session</span> : null}
              </>
            ),
          },
          { key: 'ip', header: 'IP address', render: (row) => row.ip_address ?? 'unknown' },
          {
            key: 'seen',
            header: 'Last seen',
            render: (row) => new Date(row.last_seen_at).toLocaleString(),
          },
          {
            key: 'expires',
            header: 'Expires',
            render: (row) => new Date(row.expires_at).toLocaleString(),
          },
          {
            key: 'mfa',
            header: 'MFA',
            render: (row) => (row.mfa_satisfied ? 'Satisfied' : 'Not satisfied'),
          },
          {
            key: 'actions',
            header: 'Actions',
            render: (row) => (
              <Button variant="danger" onClick={() => void revoke(row)}>
                Revoke
              </Button>
            ),
          },
        ]}
      />
    </>
  );
}
