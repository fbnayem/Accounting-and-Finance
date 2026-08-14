'use client';

import { useState } from 'react';
import { api } from '../../../../lib/api';
import {
  DataTable,
  ErrorBanner,
  Field,
  Notice,
  PageHeader,
  useResource,
} from '../../../../components/ui';
import {
  Money,
  SummaryList,
  agreementWord,
  day,
  isZeroDecimal,
  useMinorUnits,
} from '../../../../components/phase5';

interface Side {
  subledger: string;
  gl: string;
  difference: string;
}

interface ReconciliationRow {
  category_id: string;
  cost: Side;
  accumulated_depreciation: Side;
  accumulated_impairment: {
    subledger: string;
    gl: string | null;
    difference: string | null;
  };
  movements: {
    additions: string;
    depreciation: string;
    impairments: string;
    impairment_reversals: string;
    revaluations: string;
  };
  disposals: {
    disposal_count: string;
    cost_removed: string;
    contra_removed: string;
    proceeds: string;
    gain_loss: string;
  };
}

interface AssetReconciliation {
  accounting_book_id: string;
  from: string | null;
  to: string | null;
  data: ReconciliationRow[];
  in_balance: boolean;
}

interface RegisterRow {
  fixed_asset_id: string;
  asset_number: string;
  name: string;
  status: string;
  currency: string;
  category_code: string;
  category_name: string;
  asset_book_id: string;
  method: string;
  cost: string;
  accumulated_depreciation: string;
  accumulated_impairment: string;
  carrying_amount: string;
}

interface CategoryTotal {
  category_id: string;
  category_code: string;
  cost: string;
  accumulated_depreciation: string;
  accumulated_impairment: string;
  carrying_amount: string;
}

interface FixedAssetReport {
  data: RegisterRow[];
  totals_by_category: CategoryTotal[];
}

/**
 * Asset-to-GL reconciliation — doc 09, and the evidence for Phase 5's fourth
 * exit criterion: "fixed asset cost and accumulated depreciation reconcile to GL".
 *
 * Two sides per category and the difference between them, plus the period's
 * additions, depreciation, impairments, revaluations and disposals — because a
 * movement between two reconciliations has to decompose into those, and a
 * difference that appears without one of them naming it is the thing to chase.
 *
 * Both sides are drawn current, deliberately: the subledger side reads the
 * books' running accumulators, which have no as-of history, and a reconciliation
 * whose two halves are dated differently reports a difference that is only a
 * timestamp.
 */
export default function AssetReconciliationPage() {
  const units = useMinorUnits();

  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');

  const books = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; base_currency: string }[] }>(
            '/accounting-books',
            {
              query: { legal_entity_id: entityId },
            },
          )
        : Promise.resolve({ data: [] as { id: string; code: string; base_currency: string }[] }),
    [entityId],
  );
  const [bookId, setBookId] = useState('');
  const book = (books.data?.data ?? []).find((b) => b.id === bookId);
  const minorUnit = units(book?.base_currency);

  const categories = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; name: string }[] }>('/asset-categories', {
            query: { legal_entity_id: entityId },
          })
        : Promise.resolve({ data: [] as { id: string; code: string; name: string }[] }),
    [entityId],
  );
  const categoryLabel = (id: string) => {
    const category = (categories.data?.data ?? []).find((c) => c.id === id);
    return category ? `${category.code} — ${category.name}` : id.slice(0, 8);
  };

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const reconciliation = useResource(
    () =>
      entityId && bookId
        ? api<AssetReconciliation>('/reports/asset-reconciliation', {
            query: { legal_entity_id: entityId, accounting_book_id: bookId, from, to },
          })
        : Promise.resolve(null),
    [entityId, bookId, from, to],
  );

  const register = useResource(
    () =>
      entityId
        ? api<FixedAssetReport>('/reports/fixed-assets', {
            query: { legal_entity_id: entityId, accounting_book_id: bookId },
          })
        : Promise.resolve(null),
    [entityId, bookId],
  );

  const data = reconciliation.data;
  const outOfBalance = (data?.data ?? []).filter(
    (row) =>
      !isZeroDecimal(row.cost.difference) ||
      !isZeroDecimal(row.accumulated_depreciation.difference),
  );

  return (
    <>
      <PageHeader
        title="Asset-to-GL reconciliation"
        description="Cost and accumulated depreciation per category, held against the accounts the category maps to, with the period's movement between them."
      />
      <ErrorBanner error={reconciliation.error ?? register.error} />

      <div className="card">
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
          label="Accounting book"
          name="book"
          value={bookId}
          onChange={setBookId}
          required
          options={(books.data?.data ?? []).map((b) => ({
            value: b.id,
            label: `${b.code} (${b.base_currency})`,
          }))}
          hint="Required: a journal balance only means something inside one book."
        />
        <Field label="Movements from" name="from" type="date" value={from} onChange={setFrom} />
        <Field label="Movements to" name="to" type="date" value={to} onChange={setTo} />
      </div>

      {!entityId || !bookId ? (
        <p className="empty">Choose a legal entity and an accounting book.</p>
      ) : null}

      {data ? (
        <>
          {data.in_balance ? (
            <Notice tone="success">
              Every category&rsquo;s cost and accumulated depreciation agree with the general
              ledger.
            </Notice>
          ) : (
            <Notice tone="warning">
              {outOfBalance.length} categor{outOfBalance.length === 1 ? 'y does' : 'ies do'} not
              agree with the ledger. The difference is stated per category below as GL minus
              subledger — a positive figure means the ledger claims more than the register can
              account for.
            </Notice>
          )}

          <DataTable<ReconciliationRow>
            caption="Cost and accumulated depreciation against the ledger"
            rows={data.data}
            rowKey={(row) => row.category_id}
            empty="No asset categories for this entity."
            columns={[
              {
                key: 'category',
                header: 'Category',
                render: (row) => categoryLabel(row.category_id),
              },
              {
                key: 'cost_sub',
                header: 'Cost (register)',
                numeric: true,
                render: (row) => <Money value={row.cost.subledger} minorUnit={minorUnit} />,
              },
              {
                key: 'cost_gl',
                header: 'Cost (GL)',
                numeric: true,
                render: (row) => <Money value={row.cost.gl} minorUnit={minorUnit} />,
              },
              {
                key: 'cost_diff',
                header: 'Cost difference',
                numeric: true,
                render: (row) => (
                  <>
                    <Money value={row.cost.difference} minorUnit={minorUnit} />{' '}
                    <span className="field-hint">{agreementWord(row.cost.difference)}</span>
                  </>
                ),
              },
              {
                key: 'dep_sub',
                header: 'Accum. depreciation (register)',
                numeric: true,
                render: (row) => (
                  <Money value={row.accumulated_depreciation.subledger} minorUnit={minorUnit} />
                ),
              },
              {
                key: 'dep_gl',
                header: 'Accum. depreciation (GL)',
                numeric: true,
                render: (row) => (
                  <Money value={row.accumulated_depreciation.gl} minorUnit={minorUnit} />
                ),
              },
              {
                key: 'dep_diff',
                header: 'Depreciation difference',
                numeric: true,
                render: (row) => (
                  <>
                    <Money value={row.accumulated_depreciation.difference} minorUnit={minorUnit} />{' '}
                    <span className="field-hint">
                      {agreementWord(row.accumulated_depreciation.difference)}
                    </span>
                  </>
                ),
              },
              {
                key: 'imp_diff',
                header: 'Impairment difference',
                numeric: true,
                render: (row) =>
                  row.accumulated_impairment.difference === null ? (
                    <span className="field-hint">no impairment account mapped</span>
                  ) : (
                    <Money value={row.accumulated_impairment.difference} minorUnit={minorUnit} />
                  ),
              },
            ]}
          />

          <DataTable<ReconciliationRow>
            caption="What moved in the period"
            rows={data.data}
            rowKey={(row) => `${row.category_id}-movements`}
            empty="No movement."
            columns={[
              {
                key: 'category',
                header: 'Category',
                render: (row) => categoryLabel(row.category_id),
              },
              {
                key: 'additions',
                header: 'Additions',
                numeric: true,
                render: (row) => <Money value={row.movements.additions} minorUnit={minorUnit} />,
              },
              {
                key: 'depreciation',
                header: 'Depreciation',
                numeric: true,
                render: (row) => <Money value={row.movements.depreciation} minorUnit={minorUnit} />,
              },
              {
                key: 'impairments',
                header: 'Impairments',
                numeric: true,
                render: (row) => <Money value={row.movements.impairments} minorUnit={minorUnit} />,
              },
              {
                key: 'reversals',
                header: 'Impairment reversals',
                numeric: true,
                render: (row) => (
                  <Money value={row.movements.impairment_reversals} minorUnit={minorUnit} />
                ),
              },
              {
                key: 'revaluations',
                header: 'Revaluations',
                numeric: true,
                render: (row) => <Money value={row.movements.revaluations} minorUnit={minorUnit} />,
              },
              {
                key: 'disposals',
                header: 'Disposals',
                numeric: true,
                render: (row) => row.disposals.disposal_count,
              },
              {
                key: 'cost_removed',
                header: 'Cost removed',
                numeric: true,
                render: (row) => <Money value={row.disposals.cost_removed} minorUnit={minorUnit} />,
              },
              {
                key: 'gain_loss',
                header: 'Gain / (loss)',
                numeric: true,
                render: (row) => <Money value={row.disposals.gain_loss} minorUnit={minorUnit} />,
              },
            ]}
          />
          <p className="field-hint">
            Movement columns cover {data.from ? day(data.from) : 'the beginning'} to{' '}
            {data.to ? day(data.to) : 'today'}. The two balance columns above are always current.
          </p>
        </>
      ) : null}

      {register.data ? (
        <>
          <div className="card">
            <h2>Register totals by category</h2>
            <SummaryList
              items={[
                { term: 'Asset books listed', value: register.data.data.length },
                {
                  term: 'Categories',
                  value: register.data.totals_by_category.length,
                  hint: 'Subtotals are summed exactly by the server, not re-added here.',
                },
              ]}
            />
            <DataTable<CategoryTotal>
              caption="Category subtotals"
              rows={register.data.totals_by_category}
              rowKey={(row) => row.category_id}
              empty="Nothing in the register."
              columns={[
                { key: 'code', header: 'Category', render: (row) => row.category_code },
                {
                  key: 'cost',
                  header: 'Cost',
                  numeric: true,
                  render: (row) => <Money value={row.cost} minorUnit={minorUnit} />,
                },
                {
                  key: 'accumulated',
                  header: 'Accumulated depreciation',
                  numeric: true,
                  render: (row) => (
                    <Money value={row.accumulated_depreciation} minorUnit={minorUnit} />
                  ),
                },
                {
                  key: 'impairment',
                  header: 'Accumulated impairment',
                  numeric: true,
                  render: (row) => (
                    <Money value={row.accumulated_impairment} minorUnit={minorUnit} />
                  ),
                },
                {
                  key: 'carrying',
                  header: 'Carrying amount',
                  numeric: true,
                  render: (row) => <Money value={row.carrying_amount} minorUnit={minorUnit} />,
                },
              ]}
            />
          </div>

          <DataTable<RegisterRow>
            caption="Asset register"
            rows={register.data.data}
            rowKey={(row) => row.asset_book_id}
            empty="No assets."
            columns={[
              { key: 'number', header: 'Number', render: (row) => row.asset_number },
              { key: 'name', header: 'Name', render: (row) => row.name },
              { key: 'category', header: 'Category', render: (row) => row.category_code },
              {
                key: 'method',
                header: 'Method',
                render: (row) => row.method.replace(/_/g, ' ').toLowerCase(),
              },
              {
                key: 'cost',
                header: 'Cost',
                numeric: true,
                render: (row) => <Money value={row.cost} minorUnit={units(row.currency)} />,
              },
              {
                key: 'accumulated',
                header: 'Accumulated depreciation',
                numeric: true,
                render: (row) => (
                  <Money value={row.accumulated_depreciation} minorUnit={units(row.currency)} />
                ),
              },
              {
                key: 'carrying',
                header: 'Carrying amount',
                numeric: true,
                render: (row) => (
                  <Money value={row.carrying_amount} minorUnit={units(row.currency)} />
                ),
              },
              {
                key: 'status',
                header: 'Status',
                render: (row) => row.status.replace(/_/g, ' ').toLowerCase(),
              },
            ]}
          />
        </>
      ) : null}
    </>
  );
}
