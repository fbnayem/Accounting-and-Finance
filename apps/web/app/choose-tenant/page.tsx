'use client';

import { useRouter } from 'next/navigation';
import { api, session } from '../../lib/api';
import { Button, ErrorBanner, useResource } from '../../components/ui';

/**
 * ADR-0005's second login step.
 *
 * One identity spans every tenant a person works in, and the tenant binds to the
 * *session* rather than to the credential. That is what lets a bookkeeper move
 * between clients without a login for each, which is the problem the Phase 9
 * accountant portal exists to solve.
 */
export default function ChooseTenantPage() {
  const router = useRouter();
  const { data, error, loading } = useResource(() =>
    api<{ data: { id: string; name: string; slug: string }[] }>('/auth/tenants'),
  );

  const choose = async (tenantId: string) => {
    await api(`/auth/tenants/${tenantId}/select`, { method: 'POST' });
    session.store({ tenant_id: tenantId });
    router.push('/company');
  };

  return (
    <div className="auth-page">
      <h1>Choose a tenant</h1>
      <ErrorBanner error={error} />
      {loading ? <p>Loading…</p> : null}
      <ul className="tenant-list">
        {(data?.data ?? []).map((tenant) => (
          <li key={tenant.id}>
            <Button variant="secondary" onClick={() => void choose(tenant.id)}>
              {tenant.name}
            </Button>
          </li>
        ))}
      </ul>
      {data && data.data.length === 0 ? (
        <p>You have no active memberships. Ask an administrator to invite you.</p>
      ) : null}
    </div>
  );
}
