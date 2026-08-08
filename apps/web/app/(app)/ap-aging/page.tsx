'use client';

import { useState } from 'react';
import { api } from '../../../lib/api';
import {
  Button,
  DataTable,
  ErrorBanner,
  Field,
  PageHeader,
  useResource,
} from '../../../components/ui';

interface AgingRow {
  contact_id: string;
  contact_name: string;
  currency: string;
  current: string;
  bucket_1: string;
  bucket_2: string;
  bucket_3: string;
  bucket_4: string;
  total: string;
}

interface AgingReport {
  data: AgingRow[];
  as_of: string;
  /** Real day ranges, e.g. ["1-30", "31-60", "61-90", "91+"]. */
  buckets: string[];
  totals: {
    current: string;
    bucket_1: string;
    bucket_2: string;
    bucket_3: string;
    bucket_4: string;
    total: string;
  };
}

const money = (value: string | null): string =>
  value == null
    ? '—'
    : Number(value).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * AP aging — doc 05. The mirror of AR aging: what we owe rather than what we
 * are owed, bucketed by days overdue at an explicit, reproducible date, with
 * the bucket ladder read from the response rather than hardcoded.
 */
export default function ApAgingPage() {
  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  // A filter convenience; a report.view holder without vendor.view simply does
  // not get the dropdown, and the report still runs unfiltered.
  const vendors = useResource(() =>
    api<{ data: { id: string; legal_name: string }[] }>('/vendors'),
  );

  const [entityId, setEntityId] = useState('');
  const [asOf, setAsOf] = useState(today());
  const [buckets, setBuckets] = useState('30,60,90');
  const [contactId, setContactId] = useState('');
  const [applied, setApplied] = useState<{
    entityId: string;
    asOf: string;
    buckets: string;
    contactId: string;
  } | null>(null);

  const report = useResource(
    () =>
      applied
        ? api<AgingReport>('/reports/ap-aging', {
            query: {
              legal_entity_id: applied.entityId,
              as_of: applied.asOf,
              buckets: applied.buckets,
              ...(applied.contactId ? { contact_id: applied.contactId } : {}),
            },
          })
        : Promise.resolve(null),
    [applied],
  );

  const run = (event: React.FormEvent) => {
    event.preventDefault();
    if (entityId && asOf) setApplied({ entityId, asOf, buckets, contactId });
  };

  const data = report.data;

  return (
    <>
      <PageHeader
        title="AP aging"
        description="Open vendor balances bucketed by days overdue at an explicit date. The total reconciles to the AP control account — that reconciliation is Phase 3's first exit criterion."
      />
      <ErrorBanner error={report.error} />

      <form onSubmit={run} className="card">
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
        <Field
          label="As of"
          name="as_of"
          type="date"
          value={asOf}
          onChange={setAsOf}
          required
          hint="Overdue days are counted against this date, so the report can be reproduced later."
        />
        <Field
          label="Buckets"
          name="buckets"
          value={buckets}
          onChange={setBuckets}
          hint='Three ascending day counts, e.g. "30,60,90".'
        />
        {vendors.data ? (
          <Field
            label="Vendor"
            name="contact_id"
            value={contactId}
            onChange={setContactId}
            options={(vendors.data.data ?? []).map((v) => ({
              value: v.id,
              label: v.legal_name,
            }))}
            hint="Leave empty for all vendors."
          />
        ) : null}
        <Button type="submit" variant="primary">
          Run report
        </Button>
      </form>

      {data ? (
        <>
          <DataTable<AgingRow>
            caption={`AP aging as of ${data.as_of}`}
            rows={data.data}
            rowKey={(row) => `${row.contact_id}-${row.currency}`}
            empty="Nothing outstanding at this date."
            columns={[
              { key: 'contact', header: 'Vendor', render: (row) => row.contact_name },
              { key: 'currency', header: 'Currency', render: (row) => row.currency },
              {
                key: 'current',
                header: 'Current',
                numeric: true,
                render: (row) => money(row.current),
              },
              {
                key: 'b1',
                header: `${data.buckets[0] ?? '1-30'} days`,
                numeric: true,
                render: (row) => money(row.bucket_1),
              },
              {
                key: 'b2',
                header: `${data.buckets[1] ?? '31-60'} days`,
                numeric: true,
                render: (row) => money(row.bucket_2),
              },
              {
                key: 'b3',
                header: `${data.buckets[2] ?? '61-90'} days`,
                numeric: true,
                render: (row) => money(row.bucket_3),
              },
              {
                key: 'b4',
                header: `${data.buckets[3] ?? '91+'} days`,
                numeric: true,
                render: (row) => money(row.bucket_4),
              },
              { key: 'total', header: 'Total', numeric: true, render: (row) => money(row.total) },
            ]}
          />

          <div className="card">
            <h2>Totals</h2>
            <dl className="summary-list">
              <div>
                <dt>Current</dt>
                <dd>{money(data.totals.current)}</dd>
              </div>
              <div>
                <dt>{data.buckets[0] ?? '1-30'} days</dt>
                <dd>{money(data.totals.bucket_1)}</dd>
              </div>
              <div>
                <dt>{data.buckets[1] ?? '31-60'} days</dt>
                <dd>{money(data.totals.bucket_2)}</dd>
              </div>
              <div>
                <dt>{data.buckets[2] ?? '61-90'} days</dt>
                <dd>{money(data.totals.bucket_3)}</dd>
              </div>
              <div>
                <dt>{data.buckets[3] ?? '91+'} days</dt>
                <dd>{money(data.totals.bucket_4)}</dd>
              </div>
              <div>
                <dt>Total</dt>
                <dd>{money(data.totals.total)}</dd>
              </div>
            </dl>
          </div>
        </>
      ) : null}
    </>
  );
}
