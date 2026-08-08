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

interface Currency {
  code: string;
  name: string;
  minor_unit: number;
  cash_rounding_increment: string | null;
  symbol: string | null;
}

interface Rate {
  id: string;
  rate_date: string;
  from_currency: string;
  to_currency: string;
  rate_type: string;
  rate: string;
  source: string;
  is_manual_override: boolean;
  is_platform_rate: boolean;
}

/**
 * Currency setup — doc 02's core screen.
 *
 * The decimal count is shown prominently because ADR-0006 makes it the scale every
 * rounding boundary rounds to. It is not a formatting preference: a wrong value
 * produces a rounding difference on every line of every document in that currency,
 * and the difference lands in the rounding account.
 */
export default function CurrenciesPage() {
  const currencies = useResource(() => api<{ data: Currency[] }>('/currencies'));
  const rates = useResource(() => api<{ data: Rate[] }>('/exchange-rates'));
  const [form, setForm] = useState({
    rate_date: '',
    from_currency: '',
    to_currency: '',
    rate: '',
    rate_type: 'SPOT',
    source: 'manual',
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });

  const addRate = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/exchange-rates', {
        method: 'POST',
        idempotencyKey: newIdempotencyKey('rate'),
        body: form,
      });
      rates.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Currencies"
        description="ISO 4217 reference data, and effective-dated exchange rates."
      />
      <ErrorBanner error={error} />

      <DataTable<Currency>
        caption="Active currencies"
        rows={currencies.data?.data ?? []}
        rowKey={(row) => row.code}
        columns={[
          { key: 'code', header: 'Code', render: (row) => row.code },
          { key: 'name', header: 'Name', render: (row) => row.name },
          { key: 'minor', header: 'Decimals', numeric: true, render: (row) => row.minor_unit },
          {
            key: 'cash',
            header: 'Cash rounding',
            render: (row) => row.cash_rounding_increment ?? 'none',
          },
          { key: 'symbol', header: 'Symbol', render: (row) => row.symbol ?? '—' },
        ]}
      />

      <h2>Exchange rates</h2>
      <Notice>
        A historical rate is never updated in place. Correcting one means adding another
        effective-dated row, so a document posted last March still resolves the rate it actually
        used. Overriding a provider rate needs its own permission and a written reason.
      </Notice>
      <DataTable<Rate>
        caption="Exchange rates"
        rows={rates.data?.data ?? []}
        rowKey={(row) => row.id}
        empty="No rates recorded yet."
        columns={[
          { key: 'date', header: 'Date', render: (row) => row.rate_date },
          {
            key: 'pair',
            header: 'Pair',
            render: (row) => `${row.from_currency} → ${row.to_currency}`,
          },
          { key: 'type', header: 'Type', render: (row) => row.rate_type },
          { key: 'rate', header: 'Rate', numeric: true, render: (row) => row.rate },
          { key: 'source', header: 'Source', render: (row) => row.source },
          {
            key: 'origin',
            header: 'Origin',
            render: (row) =>
              row.is_manual_override
                ? 'Manual override'
                : row.is_platform_rate
                  ? 'Platform'
                  : 'Provider',
          },
        ]}
      />

      <form onSubmit={addRate} className="card">
        <h2>Record a rate</h2>
        <Field
          label="Date"
          name="rate_date"
          type="date"
          value={form.rate_date}
          onChange={set('rate_date')}
          required
        />
        <Field
          label="From"
          name="from_currency"
          value={form.from_currency}
          onChange={set('from_currency')}
          required
          placeholder="GBP"
        />
        <Field
          label="To"
          name="to_currency"
          value={form.to_currency}
          onChange={set('to_currency')}
          required
          placeholder="USD"
        />
        <Field
          label="Rate"
          name="rate"
          value={form.rate}
          onChange={set('rate')}
          required
          hint="A decimal string, never a JSON number: a rate is stored at twelve decimal places and a float cannot hold one exactly."
        />
        <Field
          label="Rate type"
          name="rate_type"
          value={form.rate_type}
          onChange={set('rate_type')}
          options={[
            { value: 'SPOT', label: 'Spot / transaction' },
            { value: 'AVERAGE', label: 'Average' },
            { value: 'CLOSING', label: 'Closing' },
            { value: 'HISTORICAL', label: 'Historical' },
          ]}
        />
        <Field label="Source" name="source" value={form.source} onChange={set('source')} required />
        <Button type="submit" variant="primary" busy={busy}>
          Record rate
        </Button>
      </form>
    </>
  );
}
