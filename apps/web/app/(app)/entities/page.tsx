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

interface LegalEntity {
  id: string;
  organization_id: string;
  code: string;
  legal_name: string;
  country_code: string;
  functional_currency: string;
  timezone: string;
  status: string;
  posting_enabled: boolean;
  activated_at: string | null;
}

interface ReadinessCheck {
  key: string;
  label: string;
  satisfied: boolean;
  phase: number;
}

/**
 * Entity list — doc 02's third core screen, plus the activation step.
 *
 * doc 02: "Posting remains disabled until required setup validation passes." The
 * activation failure is shown as the full list of what is missing rather than the
 * first thing that failed, because a wizard that reveals one more requirement each
 * time you fix the last one is how setup earns its reputation.
 */
export default function EntitiesPage() {
  const entities = useResource(() => api<{ data: LegalEntity[] }>('/legal-entities'));
  const organizations = useResource(() =>
    api<{ data: { id: string; name: string }[] }>('/organizations'),
  );
  const currencies = useResource(() =>
    api<{ data: { code: string; name: string; minor_unit: number }[] }>('/currencies'),
  );

  const [form, setForm] = useState({
    organization_id: '',
    code: '',
    legal_name: '',
    country_code: '',
    functional_currency: '',
    timezone: 'Europe/London',
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [readiness, setReadiness] = useState<{ id: string; checks: ReadinessCheck[] } | null>(null);
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });
  const fieldError = (name: string) =>
    error instanceof ApiError ? error.forField(name) : undefined;

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/legal-entities', {
        method: 'POST',
        body: form,
        idempotencyKey: newIdempotencyKey('entity'),
      });
      setForm({ ...form, code: '', legal_name: '' });
      entities.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const activate = async (entity: LegalEntity) => {
    setError(null);
    setReadiness(null);
    try {
      const result = await api<{ readiness: ReadinessCheck[] }>(
        `/legal-entities/${entity.id}/activate`,
        { method: 'POST', idempotencyKey: newIdempotencyKey('activate') },
      );
      setReadiness({ id: entity.id, checks: result.readiness });
      entities.reload();
    } catch (err) {
      setError(err);
      if (err instanceof ApiError) {
        const checks = (err as unknown as { details?: { checks?: ReadinessCheck[] } }).details;
        if (checks?.checks) setReadiness({ id: entity.id, checks: checks.checks });
      }
    }
  };

  return (
    <>
      <PageHeader
        title="Legal entities"
        description="Each entity owns its own base currency, books, chart of accounts, fiscal calendar, tax registrations and numbering."
      />
      <ErrorBanner error={error} />

      {readiness ? (
        <Notice tone={readiness.checks.every((c) => c.satisfied) ? 'success' : 'warning'}>
          <p>Setup readiness</p>
          <ul>
            {readiness.checks.map((check) => (
              <li key={check.key}>
                {/* A word, not only a tick: colour and shape alone fail WCAG 1.4.1. */}
                {check.satisfied ? 'Done' : 'Outstanding'} — {check.label}
              </li>
            ))}
          </ul>
        </Notice>
      ) : null}

      <DataTable<LegalEntity>
        caption="Legal entities"
        rows={entities.data?.data ?? []}
        rowKey={(row) => row.id}
        empty="No legal entities yet. Create the first one below."
        columns={[
          { key: 'code', header: 'Code', render: (row) => row.code },
          { key: 'name', header: 'Legal name', render: (row) => row.legal_name },
          { key: 'country', header: 'Country', render: (row) => row.country_code },
          {
            key: 'currency',
            header: 'Functional currency',
            render: (row) => row.functional_currency,
          },
          { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
          {
            key: 'posting',
            header: 'Posting',
            render: (row) => <Status value={row.posting_enabled ? 'OPEN' : 'PENDING'} />,
          },
          {
            key: 'actions',
            header: 'Actions',
            render: (row) =>
              row.posting_enabled ? (
                <span className="muted">Active</span>
              ) : (
                <Button onClick={() => void activate(row)}>Activate</Button>
              ),
          },
        ]}
      />

      <form onSubmit={create} className="card">
        <h2>New legal entity</h2>
        <Notice>
          Creating an entity also creates its primary accounting book, seeded from the functional
          currency you choose here. ADR-0003 makes the book&apos;s base currency authoritative for
          posting, and it cannot be changed once a journal has been posted.
        </Notice>
        <Field
          label="Organization"
          name="organization_id"
          value={form.organization_id}
          onChange={set('organization_id')}
          required
          options={(organizations.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
          error={fieldError('organization_id')}
        />
        <Field
          label="Code"
          name="code"
          value={form.code}
          onChange={set('code')}
          required
          hint="Short and stable — it appears on documents."
          error={fieldError('code')}
        />
        <Field
          label="Legal name"
          name="legal_name"
          value={form.legal_name}
          onChange={set('legal_name')}
          required
          error={fieldError('legal_name')}
        />
        <Field
          label="Country"
          name="country_code"
          value={form.country_code}
          onChange={set('country_code')}
          required
          hint="ISO 3166-1 alpha-2, e.g. GB."
          error={fieldError('country_code')}
        />
        <Field
          label="Functional currency"
          name="functional_currency"
          value={form.functional_currency}
          onChange={set('functional_currency')}
          required
          options={(currencies.data?.data ?? []).map((c) => ({
            value: c.code,
            label: `${c.code} — ${c.name} (${c.minor_unit} decimals)`,
          }))}
          error={fieldError('functional_currency')}
        />
        <Field
          label="Time zone"
          name="timezone"
          value={form.timezone}
          onChange={set('timezone')}
          required
          hint="IANA zone, e.g. Europe/London. Timestamps are stored in UTC; this is what the entity's day boundaries mean."
          error={fieldError('timezone')}
        />
        <Button type="submit" variant="primary" busy={busy}>
          Create entity
        </Button>
      </form>
    </>
  );
}
