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

interface Dimension {
  id: string;
  code: string;
  name: string;
  hierarchy_enabled: boolean;
  status: string;
  value_count: number;
}

interface DimensionValue {
  id: string;
  dimension_id: string;
  dimension_code: string;
  code: string;
  name: string;
  valid_from: string | null;
  valid_to: string | null;
  status: string;
}

interface DimensionRule {
  dimension_id: string;
  dimension_code: string;
  dimension_name: string;
  rule: 'REQUIRED' | 'OPTIONAL' | 'PROHIBITED' | 'DEFAULTED';
  default_value_id: string | null;
  default_value_code: string | null;
}

/**
 * Dimensions, their values, and the per-account rules.
 *
 * The rules panel is the part doc 03 asks for and nothing could previously
 * configure: "For each account/source module configure dimension rule: REQUIRED,
 * OPTIONAL, PROHIBITED, DEFAULTED." Step 9 of the posting algorithm validates
 * against exactly this, so without a screen the validation had nothing to validate.
 */
export default function DimensionsPage() {
  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');
  const [accountId, setAccountId] = useState('');

  const dimensions = useResource(
    () =>
      entityId
        ? api<{ data: Dimension[] }>('/dimensions', { query: { legal_entity_id: entityId } })
        : Promise.resolve({ data: [] }),
    [entityId],
  );
  const values = useResource(
    () =>
      entityId
        ? api<{ data: DimensionValue[] }>('/dimension-values', {
            query: { legal_entity_id: entityId },
          })
        : Promise.resolve({ data: [] }),
    [entityId],
  );
  const accounts = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; name: string }[] }>('/accounts', {
            query: { legal_entity_id: entityId, posting_only: 'true' },
          })
        : Promise.resolve({ data: [] }),
    [entityId],
  );
  const rules = useResource(
    () =>
      accountId
        ? api<{ data: DimensionRule[] }>(`/accounts/${accountId}/dimension-rules`)
        : Promise.resolve({ data: [] }),
    [accountId],
  );

  const [dimensionForm, setDimensionForm] = useState({ code: '', name: '', hierarchy: 'no' });
  const [valueForm, setValueForm] = useState({ dimension_id: '', code: '', name: '' });
  const [draft, setDraft] = useState<Record<string, DimensionRule['rule']>>({});
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const fieldError = (name: string) =>
    error instanceof ApiError ? error.forField(name) : undefined;

  const createDimension = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await api('/dimensions', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('dimension'),
        body: {
          legal_entity_id: entityId,
          code: dimensionForm.code,
          name: dimensionForm.name,
          hierarchy_enabled: dimensionForm.hierarchy === 'yes',
        },
      });
      setDimensionForm({ code: '', name: '', hierarchy: 'no' });
      dimensions.reload();
    } catch (err) {
      setError(err);
    }
  };

  const createValue = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    try {
      await api('/dimension-values', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('dimension-value'),
        body: {
          dimension_id: valueForm.dimension_id,
          code: valueForm.code,
          name: valueForm.name,
        },
      });
      setValueForm({ ...valueForm, code: '', name: '' });
      values.reload();
      dimensions.reload();
    } catch (err) {
      setError(err);
    }
  };

  const saveRules = async () => {
    setBusy(true);
    setError(null);
    try {
      const current = rules.data?.data ?? [];
      await api(`/accounts/${accountId}/dimension-rules`, {
        method: 'PUT',
        body: {
          rules: current
            .map((r) => ({
              dimension_id: r.dimension_id,
              rule: draft[r.dimension_id] ?? r.rule,
              ...(defaults[r.dimension_id] ? { default_value_id: defaults[r.dimension_id] } : {}),
            }))
            .filter((r) => r.rule !== 'OPTIONAL'),
        },
      });
      setDraft({});
      setDefaults({});
      rules.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Dimensions"
        description="Analytical axes — department, cost centre, project, fund. Journal lines carry them, and each account decides whether they are required, optional, prohibited or defaulted."
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
          <DataTable<Dimension>
            caption="Dimensions"
            rows={dimensions.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No dimensions yet."
            columns={[
              { key: 'code', header: 'Code', render: (row) => row.code },
              { key: 'name', header: 'Name', render: (row) => row.name },
              {
                key: 'hierarchy',
                header: 'Hierarchical',
                render: (row) => (row.hierarchy_enabled ? 'Yes' : 'No'),
              },
              { key: 'values', header: 'Values', numeric: true, render: (row) => row.value_count },
              { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
            ]}
          />

          <DataTable<DimensionValue>
            caption="Dimension values"
            rows={values.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No values yet."
            columns={[
              { key: 'dimension', header: 'Dimension', render: (row) => row.dimension_code },
              { key: 'code', header: 'Code', render: (row) => row.code },
              { key: 'name', header: 'Name', render: (row) => row.name },
              { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
            ]}
          />

          <h2>Dimension rules per account</h2>
          <Notice>
            REQUIRED refuses a line without the value. PROHIBITED refuses one that supplies it.
            DEFAULTED fills in a value when none is given. OPTIONAL is the default and is not stored
            — it is the absence of a rule.
          </Notice>
          <div className="card">
            <Field
              label="Account"
              name="rule_account"
              value={accountId}
              onChange={setAccountId}
              options={(accounts.data?.data ?? []).map((a) => ({
                value: a.id,
                label: `${a.code} — ${a.name}`,
              }))}
            />
          </div>

          {accountId ? (
            <>
              <DataTable<DimensionRule>
                caption="Rules for the selected account"
                rows={rules.data?.data ?? []}
                rowKey={(row) => row.dimension_id}
                empty="This entity has no dimensions to configure."
                columns={[
                  {
                    key: 'dimension',
                    header: 'Dimension',
                    render: (row) => `${row.dimension_code} — ${row.dimension_name}`,
                  },
                  {
                    key: 'rule',
                    header: 'Rule',
                    render: (row) => (
                      <Field
                        label={`Rule for ${row.dimension_code}`}
                        name={`rule-${row.dimension_id}`}
                        value={draft[row.dimension_id] ?? row.rule}
                        onChange={(v) =>
                          setDraft({ ...draft, [row.dimension_id]: v as DimensionRule['rule'] })
                        }
                        options={[
                          { value: 'OPTIONAL', label: 'Optional' },
                          { value: 'REQUIRED', label: 'Required' },
                          { value: 'PROHIBITED', label: 'Prohibited' },
                          { value: 'DEFAULTED', label: 'Defaulted' },
                        ]}
                      />
                    ),
                  },
                  {
                    key: 'default',
                    header: 'Default value',
                    render: (row) =>
                      (draft[row.dimension_id] ?? row.rule) === 'DEFAULTED' ? (
                        <Field
                          label={`Default value for ${row.dimension_code}`}
                          name={`default-${row.dimension_id}`}
                          value={defaults[row.dimension_id] ?? row.default_value_id ?? ''}
                          onChange={(v) => setDefaults({ ...defaults, [row.dimension_id]: v })}
                          options={(values.data?.data ?? [])
                            .filter((v) => v.dimension_id === row.dimension_id)
                            .map((v) => ({ value: v.id, label: `${v.code} — ${v.name}` }))}
                          error={fieldError('default_value_id')}
                        />
                      ) : (
                        <span className="field-hint">—</span>
                      ),
                  },
                ]}
              />
              <div className="button-row">
                <Button variant="primary" busy={busy} onClick={() => void saveRules()}>
                  Save rules for this account
                </Button>
              </div>
            </>
          ) : null}

          <form onSubmit={createDimension} className="card">
            <h2>New dimension</h2>
            <Field
              label="Code"
              name="dim_code"
              value={dimensionForm.code}
              onChange={(v) => setDimensionForm({ ...dimensionForm, code: v })}
              required
              placeholder="DEPT"
            />
            <Field
              label="Name"
              name="dim_name"
              value={dimensionForm.name}
              onChange={(v) => setDimensionForm({ ...dimensionForm, name: v })}
              required
              placeholder="Department"
            />
            <Field
              label="Hierarchical"
              name="dim_hierarchy"
              value={dimensionForm.hierarchy}
              onChange={(v) => setDimensionForm({ ...dimensionForm, hierarchy: v })}
              options={[
                { value: 'no', label: 'Flat' },
                { value: 'yes', label: 'Values can have parents' },
              ]}
            />
            <Button type="submit">Create dimension</Button>
          </form>

          <form onSubmit={createValue} className="card">
            <h2>New dimension value</h2>
            <Field
              label="Dimension"
              name="value_dimension"
              value={valueForm.dimension_id}
              onChange={(v) => setValueForm({ ...valueForm, dimension_id: v })}
              required
              options={(dimensions.data?.data ?? []).map((d) => ({
                value: d.id,
                label: `${d.code} — ${d.name}`,
              }))}
            />
            <Field
              label="Code"
              name="value_code"
              value={valueForm.code}
              onChange={(v) => setValueForm({ ...valueForm, code: v })}
              required
              placeholder="SALES"
            />
            <Field
              label="Name"
              name="value_name"
              value={valueForm.name}
              onChange={(v) => setValueForm({ ...valueForm, name: v })}
              required
              placeholder="Sales department"
            />
            <Button type="submit">Create value</Button>
          </form>
        </>
      ) : null}
    </>
  );
}
