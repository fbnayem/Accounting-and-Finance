'use client';

import { api } from '../../../lib/api';
import { DataTable, ErrorBanner, Notice, PageHeader, useResource } from '../../../components/ui';

interface Permission {
  code: string;
  resource: string;
  action: string;
  description: string;
  is_high_risk: boolean;
  min_phase: number;
}

/**
 * The permission registry — doc 02's core screen, served from the generated table.
 *
 * The list is not editable, and that is the point. ADR-0005 §3 makes the registry a
 * build artifact generated from `contracts/openapi.yaml`, so a permission exists
 * because a route requires it. A screen that let someone add one would create a
 * permission no route checks, which is worse than no permission at all: it looks
 * like a control and is not one.
 */
export default function PermissionsPage() {
  const { data, error } = useResource(() =>
    api<{ data: Permission[]; meta: { total: number; high_risk: number; source: string } }>(
      '/permissions',
    ),
  );

  return (
    <>
      <PageHeader
        title="Permissions"
        description="The full registry. Generated from the API contract, so a route and its permission cannot drift apart."
      />
      <ErrorBanner error={error} />
      {data ? (
        <Notice>
          {data.meta.total} permissions, {data.meta.high_risk} of them high-risk. Source:{' '}
          <code>{data.meta.source}</code>. A high-risk permission requires multi-factor
          authentication within the last fifteen minutes, every time it is exercised.
        </Notice>
      ) : null}
      <DataTable<Permission>
        caption="Permission registry"
        rows={data?.data ?? []}
        rowKey={(row) => row.code}
        columns={[
          { key: 'code', header: 'Code', render: (row) => <code>{row.code}</code> },
          { key: 'resource', header: 'Resource', render: (row) => row.resource.replace(/_/g, ' ') },
          { key: 'action', header: 'Action', render: (row) => row.action.replace(/_/g, ' ') },
          {
            key: 'risk',
            header: 'Risk',
            render: (row) => (row.is_high_risk ? 'High risk' : 'Standard'),
          },
          { key: 'phase', header: 'From phase', numeric: true, render: (row) => row.min_phase },
          { key: 'description', header: 'Where it applies', render: (row) => row.description },
        ]}
      />
    </>
  );
}
