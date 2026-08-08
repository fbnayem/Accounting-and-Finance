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
  useResource,
} from '../../../components/ui';

interface Sequence {
  id: string;
  document_type: string;
  prefix: string | null;
  suffix: string | null;
  padding: number;
  next_number: string;
  reset_rule: string;
  status: string;
  allocated_count: string;
}

/**
 * Number sequences — doc 02's core screen.
 *
 * doc 02: "Allocate final numbers on posting/approval according to document
 * policy. Concurrency-safe. Never reuse posted/voided numbers." All three follow
 * from ADR-0004 §1: allocation takes a row lock on the sequence as late as possible
 * in the posting transaction. PostgreSQL sequences are unusable here because they
 * are gap-tolerant by design, and a statutory series with holes in it is a finding.
 */
export default function NumberSequencesPage() {
  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');
  const sequences = useResource(
    () =>
      entityId
        ? api<{ data: Sequence[] }>('/number-sequences', { query: { legal_entity_id: entityId } })
        : Promise.resolve({ data: [] }),
    [entityId],
  );

  const [form, setForm] = useState({
    document_type: 'SALES_INVOICE',
    prefix: 'INV-{YYYY}-',
    suffix: '',
    padding: '5',
    reset_rule: 'ANNUAL',
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/number-sequences', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('seq'),
        body: {
          legal_entity_id: entityId,
          document_type: form.document_type,
          prefix: form.prefix || undefined,
          suffix: form.suffix || undefined,
          padding: Number(form.padding),
          reset_rule: form.reset_rule,
        },
      });
      sequences.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Number sequences"
        description="Human-readable document numbers, separate from internal identifiers."
      />
      <ErrorBanner error={error} />
      <Notice>
        A number is allocated when the document is posted or approved, not when it is drafted, so an
        abandoned draft does not consume one. Allocated numbers are never reused — a voided document
        keeps its number and stays visible in the sequence, which is what an auditor checks for.
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

      {entityId ? (
        <>
          <DataTable<Sequence>
            caption="Number sequences"
            rows={sequences.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No sequences yet. An entity needs at least one before it can be activated."
            columns={[
              { key: 'type', header: 'Document type', render: (row) => row.document_type },
              {
                key: 'pattern',
                header: 'Next number looks like',
                render: (row) =>
                  `${(row.prefix ?? '').replace('{YYYY}', String(new Date().getUTCFullYear()))}` +
                  `${row.next_number.padStart(row.padding, '0')}${row.suffix ?? ''}`,
              },
              { key: 'next', header: 'Next', numeric: true, render: (row) => row.next_number },
              { key: 'reset', header: 'Resets', render: (row) => row.reset_rule.toLowerCase() },
              {
                key: 'allocated',
                header: 'Allocated',
                numeric: true,
                render: (row) => row.allocated_count,
              },
            ]}
          />

          <form onSubmit={create} className="card">
            <h2>New sequence</h2>
            <Field
              label="Document type"
              name="document_type"
              value={form.document_type}
              onChange={set('document_type')}
              required
              hint="Upper snake case, e.g. SALES_INVOICE, VENDOR_BILL, JOURNAL."
            />
            <Field
              label="Prefix"
              name="prefix"
              value={form.prefix}
              onChange={set('prefix')}
              hint="{YYYY}, {YY}, {MM} and {DD} expand when the number is allocated."
            />
            <Field label="Suffix" name="suffix" value={form.suffix} onChange={set('suffix')} />
            <Field
              label="Padding"
              name="padding"
              type="number"
              value={form.padding}
              onChange={set('padding')}
              hint="Zero-padded width of the counter."
            />
            <Field
              label="Reset cycle"
              name="reset_rule"
              value={form.reset_rule}
              onChange={set('reset_rule')}
              options={[
                { value: 'NEVER', label: 'Never — one continuous series' },
                { value: 'ANNUAL', label: 'Annually' },
                { value: 'MONTHLY', label: 'Monthly' },
              ]}
            />
            <Button type="submit" variant="primary" busy={busy}>
              Create sequence
            </Button>
          </form>
        </>
      ) : null}
    </>
  );
}
