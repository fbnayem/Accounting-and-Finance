'use client';

import { useState } from 'react';
import { api } from '../../../lib/api';
import {
  DataTable,
  ErrorBanner,
  Field,
  Notice,
  PageHeader,
  useResource,
} from '../../../components/ui';

interface AuditEvent {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  actor_kind: string;
  actor_id: string | null;
  occurred_at: string;
  correlation_id: string | null;
  reason: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
}

/**
 * The audit trail.
 *
 * Append-only and hash-chained: each row carries the hash of the one before it, so
 * a deletion or an edit breaks the chain and is detectable rather than merely
 * discouraged. Gate B requires that "audit trail records sensitive setup/permission
 * changes", which is what this reads back.
 */
export default function AuditPage() {
  const [filters, setFilters] = useState({ resource_type: '', action: '' });
  const { data, error } = useResource(
    () =>
      api<{ data: AuditEvent[] }>('/audit-events', {
        query: {
          resource_type: filters.resource_type || undefined,
          action: filters.action || undefined,
          limit: 100,
        },
      }),
    [filters.resource_type, filters.action],
  );

  return (
    <>
      <PageHeader
        title="Audit trail"
        description="Every administrative change, with who, when, why, and what it was before."
      />
      <ErrorBanner error={error} />
      <Notice>
        Append-only. Each entry carries the hash of the previous one, so removing or altering a row
        breaks the chain — and the application database role cannot UPDATE or DELETE this table at
        all, which is enforced by a revoked privilege rather than by the code above it.
      </Notice>

      <div className="card">
        <Field
          label="Resource type"
          name="resource_type"
          value={filters.resource_type}
          onChange={(value) => setFilters({ ...filters, resource_type: value })}
          hint="e.g. accounting_period, legal_entity, role"
        />
        <Field
          label="Action"
          name="action"
          value={filters.action}
          onChange={(value) => setFilters({ ...filters, action: value })}
          hint="e.g. accounting_period.hard_closed"
        />
      </div>

      <DataTable<AuditEvent>
        caption="Audit events"
        rows={data?.data ?? []}
        rowKey={(row) => row.id}
        columns={[
          {
            key: 'when',
            header: 'When',
            render: (row) => new Date(row.occurred_at).toLocaleString(),
          },
          { key: 'action', header: 'Action', render: (row) => row.action },
          { key: 'resource', header: 'Resource', render: (row) => row.resource_type },
          { key: 'actor', header: 'Actor', render: (row) => row.actor_id ?? row.actor_kind },
          { key: 'reason', header: 'Reason', render: (row) => row.reason ?? '—' },
          {
            key: 'change',
            header: 'Change',
            render: (row) =>
              row.before_data ? (
                <details>
                  <summary>before / after</summary>
                  <pre>{JSON.stringify({ before: row.before_data, after: row.after_data }, null, 1)}</pre>
                </details>
              ) : (
                '—'
              ),
          },
        ]}
      />
    </>
  );
}
