'use client';

import { useState } from 'react';
import { ApiError, api } from '../../../lib/api';
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
import { useHeldPermissions, useIdempotencyKeys } from '../../../components/document-lines';

interface TaxComponent {
  id: string;
  code: string;
  name: string;
  sequence: number;
  compound_on_previous: boolean;
}

interface TaxCode {
  id: string;
  legal_entity_id: string;
  code: string;
  name: string;
  kind: string;
  treatment: string;
  is_inclusive_default: boolean;
  status: string;
  components: TaxComponent[];
}

interface TaxRate {
  id: string;
  tax_component_id: string;
  component_code: string;
  tax_code: string;
  rate: string;
  recoverable_percent: string | null;
  valid_from: string;
  valid_to: string | null;
}

interface ComponentDraft {
  key: string;
  code: string;
  name: string;
  compound: boolean;
}

const newComponent = (): ComponentDraft => ({
  key: globalThis.crypto?.randomUUID?.() ?? `comp-${Math.random().toString(36).slice(2)}`,
  code: '',
  name: '',
  compound: false,
});

/**
 * Tax codes and rates — doc 07's tax foundation.
 *
 * A code is a label; the components under it are what actually carry rates, and
 * rates are effective-dated with overlaps structurally refused (F-025). The
 * rate is a decimal string — "0.20" is twenty percent — because a percentage
 * as a float is exactly the kind of number ADR-0006 exists to forbid.
 */
export default function TaxCodesPage() {
  const held = useHeldPermissions();
  const can = (permission: string) => !held || held.has(permission);
  const keys = useIdempotencyKeys();

  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');

  const taxCodes = useResource(
    () =>
      entityId
        ? api<{ data: TaxCode[] }>('/tax-codes', { query: { legal_entity_id: entityId } })
        : Promise.resolve({ data: [] }),
    [entityId],
  );
  const rates = useResource(
    () => (entityId ? api<{ data: TaxRate[] }>('/tax-rates') : Promise.resolve({ data: [] })),
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
  const accountOptions = (accounts.data?.data ?? []).map((a) => ({
    value: a.id,
    label: `${a.code} — ${a.name}`,
  }));

  const [form, setForm] = useState({
    code: '',
    name: '',
    kind: 'VAT',
    treatment: 'STANDARD',
    is_inclusive_default: 'no',
    payable_account_id: '',
    receivable_account_id: '',
    nonrecoverable_account_id: '',
  });
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });
  const [components, setComponents] = useState<ComponentDraft[]>([newComponent()]);

  const [rateForm, setRateForm] = useState({
    tax_component_id: '',
    rate: '',
    recoverable_percent: '',
    valid_from: '',
    valid_to: '',
  });
  const setRate = (key: keyof typeof rateForm) => (value: string) =>
    setRateForm({ ...rateForm, [key]: value });

  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fieldError = (name: string) =>
    error instanceof ApiError ? error.forField(name) : undefined;

  const updateComponent = (index: number, patch: Partial<ComponentDraft>): void => {
    setComponents(components.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  };

  const createTaxCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      legal_entity_id: entityId,
      code: form.code,
      name: form.name,
      kind: form.kind,
      treatment: form.treatment,
      is_inclusive_default: form.is_inclusive_default === 'yes',
      ...(form.payable_account_id ? { payable_account_id: form.payable_account_id } : {}),
      ...(form.receivable_account_id ? { receivable_account_id: form.receivable_account_id } : {}),
      ...(form.nonrecoverable_account_id
        ? { nonrecoverable_account_id: form.nonrecoverable_account_id }
        : {}),
      components: components
        .filter((c) => c.code && c.name)
        .map((c, index) => ({
          code: c.code,
          name: c.name,
          sequence: index + 1,
          ...(c.compound ? { compound_on_previous: true } : {}),
        })),
    };
    try {
      await api('/tax-codes', {
        method: 'POST',
        idempotencyKey: keys.keyFor('create-tax-code', body),
        body,
      });
      keys.settle('create-tax-code');
      setNotice(
        `${form.code} created. Now give each component a rate below — a code without a current rate refuses to calculate rather than guessing zero.`,
      );
      setForm({ ...form, code: '', name: '' });
      setComponents([newComponent()]);
      taxCodes.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const createTaxRate = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      tax_component_id: rateForm.tax_component_id,
      // A decimal string, never a float: "0.20" is 20% (ADR-0006 §1).
      rate: rateForm.rate,
      valid_from: rateForm.valid_from,
      ...(rateForm.recoverable_percent
        ? { recoverable_percent: rateForm.recoverable_percent }
        : {}),
      ...(rateForm.valid_to ? { valid_to: rateForm.valid_to } : {}),
    };
    try {
      await api('/tax-rates', {
        method: 'POST',
        idempotencyKey: keys.keyFor('create-tax-rate', body),
        body,
      });
      keys.settle('create-tax-rate');
      setNotice('Rate recorded.');
      setRateForm({ ...rateForm, rate: '', valid_from: '', valid_to: '' });
      rates.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const componentOptions = (taxCodes.data?.data ?? []).flatMap((code) =>
    code.components.map((component) => ({
      value: component.id,
      label: `${code.code} · ${component.code} — ${component.name}`,
    })),
  );

  return (
    <>
      <PageHeader
        title="Tax codes"
        description="Tax codes, their components, and effective-dated rates. Rates never overlap: close the current rate with a valid-to date before opening the next (F-025)."
      />
      <ErrorBanner error={error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

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
          <DataTable<TaxCode>
            caption="Tax codes"
            rows={taxCodes.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No tax codes yet. Create the first one below."
            columns={[
              { key: 'code', header: 'Code', render: (row) => row.code },
              { key: 'name', header: 'Name', render: (row) => row.name },
              { key: 'kind', header: 'Kind', render: (row) => row.kind },
              { key: 'treatment', header: 'Treatment', render: (row) => row.treatment },
              {
                key: 'inclusive',
                header: 'Inclusive by default',
                render: (row) => (row.is_inclusive_default ? 'yes' : 'no'),
              },
              {
                key: 'components',
                header: 'Components',
                render: (row) =>
                  row.components.length === 0
                    ? '—'
                    : row.components
                        .map((c) => `${c.code}${c.compound_on_previous ? ' (compound)' : ''}`)
                        .join(', '),
              },
              { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
            ]}
          />

          <DataTable<TaxRate>
            caption="Tax rates, newest first per component"
            rows={rates.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No rates yet. A tax code cannot calculate anything until its components have a rate in force."
            columns={[
              { key: 'code', header: 'Tax code', render: (row) => row.tax_code },
              { key: 'component', header: 'Component', render: (row) => row.component_code },
              { key: 'rate', header: 'Rate', numeric: true, render: (row) => row.rate },
              {
                key: 'recoverable',
                header: 'Recoverable',
                numeric: true,
                render: (row) => row.recoverable_percent ?? '1',
              },
              { key: 'from', header: 'Valid from', render: (row) => row.valid_from },
              { key: 'to', header: 'Valid to', render: (row) => row.valid_to ?? 'open-ended' },
            ]}
          />

          {can('tax_code.manage') ? (
            <>
              <form onSubmit={createTaxCode} className="card">
                <h2>New tax code</h2>
                <Field
                  label="Code"
                  name="code"
                  value={form.code}
                  onChange={set('code')}
                  required
                  placeholder="VAT20"
                  error={fieldError('code')}
                />
                <Field
                  label="Name"
                  name="name"
                  value={form.name}
                  onChange={set('name')}
                  required
                  placeholder="Standard rate VAT"
                  error={fieldError('name')}
                />
                <Field
                  label="Kind"
                  name="kind"
                  value={form.kind}
                  onChange={set('kind')}
                  options={[
                    { value: 'VAT', label: 'VAT' },
                    { value: 'GST', label: 'GST' },
                    { value: 'SALES_TAX', label: 'Sales tax' },
                    { value: 'WITHHOLDING', label: 'Withholding' },
                    { value: 'EXCISE', label: 'Excise' },
                    { value: 'SUPPLEMENTARY', label: 'Supplementary' },
                    { value: 'OTHER', label: 'Other' },
                  ]}
                  error={fieldError('kind')}
                />
                <Field
                  label="Treatment"
                  name="treatment"
                  value={form.treatment}
                  onChange={set('treatment')}
                  options={[
                    { value: 'STANDARD', label: 'Standard' },
                    { value: 'ZERO_RATED', label: 'Zero rated' },
                    { value: 'EXEMPT', label: 'Exempt' },
                    { value: 'OUTSIDE_SCOPE', label: 'Outside scope' },
                    { value: 'REVERSE_CHARGE', label: 'Reverse charge' },
                  ]}
                  hint="Zero rated and exempt both charge nothing; they differ in what the return reports."
                  error={fieldError('treatment')}
                />
                <Field
                  label="Prices include tax by default"
                  name="is_inclusive_default"
                  value={form.is_inclusive_default}
                  onChange={set('is_inclusive_default')}
                  options={[
                    { value: 'no', label: 'No — tax is added on top' },
                    { value: 'yes', label: 'Yes — tax is extracted from the price' },
                  ]}
                />
                <Field
                  label="Payable account (output tax)"
                  name="payable_account_id"
                  value={form.payable_account_id}
                  onChange={set('payable_account_id')}
                  options={accountOptions}
                  hint="Where tax charged on sales is credited."
                  error={fieldError('payable_account_id')}
                />
                <Field
                  label="Receivable account (input tax)"
                  name="receivable_account_id"
                  value={form.receivable_account_id}
                  onChange={set('receivable_account_id')}
                  options={accountOptions}
                  hint="Where recoverable tax on purchases is debited."
                  error={fieldError('receivable_account_id')}
                />
                <Field
                  label="Non-recoverable account"
                  name="nonrecoverable_account_id"
                  value={form.nonrecoverable_account_id}
                  onChange={set('nonrecoverable_account_id')}
                  options={accountOptions}
                  hint="Where the non-recoverable share of input tax goes when recoverable percent is below 1."
                  error={fieldError('nonrecoverable_account_id')}
                />

                <h2>Components</h2>
                <p className="field-hint">
                  Most codes have one component. Multiple components exist for taxes assessed in
                  parts (state plus county, or a compound levy assessed on the taxed amount).
                </p>
                {components.map((component, index) => (
                  <fieldset key={component.key} className="card">
                    <legend>Component {index + 1}</legend>
                    <Field
                      label="Component code"
                      name={`component_code_${index}`}
                      value={component.code}
                      onChange={(v) => updateComponent(index, { code: v })}
                      placeholder="VAT20"
                    />
                    <Field
                      label="Component name"
                      name={`component_name_${index}`}
                      value={component.name}
                      onChange={(v) => updateComponent(index, { name: v })}
                      placeholder="Standard rate"
                    />
                    <Field
                      label="Compounds on the previous component"
                      name={`component_compound_${index}`}
                      value={component.compound ? 'yes' : 'no'}
                      onChange={(v) => updateComponent(index, { compound: v === 'yes' })}
                      options={[
                        { value: 'no', label: 'No — assessed on the net amount' },
                        { value: 'yes', label: 'Yes — assessed on net plus the previous tax' },
                      ]}
                    />
                    <Button onClick={() => setComponents(components.filter((_, i) => i !== index))}>
                      Remove component
                    </Button>
                  </fieldset>
                ))}
                <div className="button-row">
                  <Button onClick={() => setComponents([...components, newComponent()])}>
                    Add component
                  </Button>
                  <Button type="submit" variant="primary" busy={busy}>
                    Create tax code
                  </Button>
                </div>
              </form>

              <form onSubmit={createTaxRate} className="card">
                <h2>New tax rate</h2>
                <Field
                  label="Component"
                  name="tax_component_id"
                  value={rateForm.tax_component_id}
                  onChange={setRate('tax_component_id')}
                  required
                  options={componentOptions}
                  error={fieldError('tax_component_id')}
                />
                <Field
                  label="Rate"
                  name="rate"
                  value={rateForm.rate}
                  onChange={setRate('rate')}
                  required
                  placeholder="0.20"
                  hint='A decimal fraction: "0.20" is twenty percent.'
                  error={fieldError('rate')}
                />
                <Field
                  label="Recoverable percent"
                  name="recoverable_percent"
                  value={rateForm.recoverable_percent}
                  onChange={setRate('recoverable_percent')}
                  placeholder="1"
                  hint='How much of the input tax is recoverable — "1" (the default) is fully, "0.5" is half.'
                  error={fieldError('recoverable_percent')}
                />
                <Field
                  label="Valid from"
                  name="valid_from"
                  type="date"
                  value={rateForm.valid_from}
                  onChange={setRate('valid_from')}
                  required
                  error={fieldError('valid_from')}
                />
                <Field
                  label="Valid to"
                  name="valid_to"
                  type="date"
                  value={rateForm.valid_to}
                  onChange={setRate('valid_to')}
                  hint="Leave empty for open-ended. To change a rate later, close this one first — overlapping rates are refused."
                  error={fieldError('valid_to')}
                />
                <Button type="submit" variant="primary" busy={busy}>
                  Create rate
                </Button>
              </form>
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
