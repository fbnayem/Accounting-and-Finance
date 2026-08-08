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

interface Policy {
  id: string;
  version: number;
  valid_from: string;
  valid_to: string | null;
  retained_earnings_method: string;
  rounding_mode: string;
  rounding_tolerance: string;
  three_way_match_tolerance_pct: string;
  closed_period_behaviour: string;
}

interface EffectiveSettings {
  settings: Record<string, unknown>;
  provenance: Record<string, { level: string; sourceId: string | null }>;
  chain: { level: string; source_id: string | null }[];
}

/**
 * Accounting settings — doc 02's core screen, and doc 01's precedence chain.
 *
 * Two different things share this page because they answer the same question from
 * opposite ends. The policy is the versioned, effective-dated record every posting
 * rule resolves its accounts through; the effective settings are the resolved
 * answer for one scope, with the level that supplied each value. "Why is this
 * entity behaving differently" is otherwise four queries and a guess.
 */
export default function SettingsPage() {
  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');
  const policies = useResource(
    () =>
      entityId
        ? api<{ data: Policy[] }>('/accounting-policies', { query: { legal_entity_id: entityId } })
        : Promise.resolve({ data: [] }),
    [entityId],
  );
  const effective = useResource(
    () =>
      entityId
        ? api<EffectiveSettings>('/settings/effective', { query: { legal_entity_id: entityId } })
        : Promise.resolve(null),
    [entityId],
  );

  const [form, setForm] = useState({
    valid_from: '',
    retained_earnings_method: 'DERIVED',
    rounding_mode: 'HALF_UP',
    closed_period_behaviour: 'REJECT',
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });

  const createVersion = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/accounting-policies', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('policy'),
        body: { legal_entity_id: entityId, ...form },
      });
      policies.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const settings = effective.data;

  return (
    <>
      <PageHeader
        title="Accounting settings"
        description="The versioned accounting policy, and the resolved configuration for a scope."
      />
      <ErrorBanner error={error} />

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
          <h2>Accounting policy versions</h2>
          <Notice>
            A policy is never edited. Changing one creates a new version with its own effective
            date, and the previous version is closed at that date — so a document posted last year
            still resolves the policy it actually used. The retained-earnings method becomes
            immutable once a period has been hard-closed under it.
          </Notice>
          <DataTable<Policy>
            caption="Accounting policy versions"
            rows={policies.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No policy yet. An entity needs one before it can be activated."
            columns={[
              { key: 'version', header: 'Version', numeric: true, render: (row) => row.version },
              { key: 'from', header: 'Effective from', render: (row) => row.valid_from },
              { key: 'to', header: 'Until', render: (row) => row.valid_to ?? 'current' },
              {
                key: 'retained',
                header: 'Retained earnings',
                render: (row) =>
                  row.retained_earnings_method === 'DERIVED'
                    ? 'Derived (no closing journal)'
                    : 'Closing journal',
              },
              { key: 'rounding', header: 'Rounding', render: (row) => row.rounding_mode },
              {
                key: 'closed',
                header: 'Closed period',
                render: (row) => row.closed_period_behaviour.toLowerCase().replace(/_/g, ' '),
              },
            ]}
          />

          <form onSubmit={createVersion} className="card">
            <h2>New policy version</h2>
            <Field
              label="Effective from"
              name="valid_from"
              type="date"
              value={form.valid_from}
              onChange={set('valid_from')}
              required
              hint="Must be after the current version's effective date — a policy cannot be back-dated over documents that already used it."
            />
            <Field
              label="Retained earnings method"
              name="retained_earnings_method"
              value={form.retained_earnings_method}
              onChange={set('retained_earnings_method')}
              options={[
                { value: 'DERIVED', label: 'Derived — equity is computed, no closing journal' },
                {
                  value: 'CLOSING_JOURNAL',
                  label: 'Closing journal — an explicit year-end transfer',
                },
              ]}
              hint="Both are supported. The choice is yours, and it cannot be changed once a year has been closed under it."
            />
            <Field
              label="Rounding mode"
              name="rounding_mode"
              value={form.rounding_mode}
              onChange={set('rounding_mode')}
              options={['HALF_UP', 'HALF_EVEN', 'HALF_DOWN', 'UP', 'DOWN', 'TRUNCATE'].map((m) => ({
                value: m,
                label: m.replace(/_/g, ' ').toLowerCase(),
              }))}
            />
            <Field
              label="Posting into a closed period"
              name="closed_period_behaviour"
              value={form.closed_period_behaviour}
              onChange={set('closed_period_behaviour')}
              options={[
                { value: 'REJECT', label: 'Reject' },
                { value: 'ALLOW_WITH_APPROVAL', label: 'Allow with approval' },
              ]}
            />
            <Button type="submit" variant="primary" busy={busy}>
              Create version
            </Button>
          </form>

          <h2>Effective settings</h2>
          <Notice>
            Resolved through the precedence chain: platform default, then localization, then
            organization, then legal entity, then branch. The level column says which one supplied
            each value.
          </Notice>
          {settings ? (
            <DataTable
              caption="Effective settings for this entity"
              rows={Object.entries(settings.settings).map(([key, value]) => ({
                key,
                value,
                level: settings.provenance[key]?.level ?? 'platform',
              }))}
              rowKey={(row) => row.key}
              columns={[
                { key: 'setting', header: 'Setting', render: (row) => row.key.replace(/_/g, ' ') },
                { key: 'value', header: 'Value', render: (row) => String(row.value) },
                {
                  key: 'level',
                  header: 'Set at',
                  render: (row) => row.level.replace(/_/g, ' '),
                },
              ]}
            />
          ) : null}
        </>
      ) : null}
    </>
  );
}
