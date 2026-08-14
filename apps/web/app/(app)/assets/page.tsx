'use client';

import { useState } from 'react';
import { api } from '../../../lib/api';
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
import {
  Money,
  SummaryList,
  day,
  enumOptions,
  today,
  useMinorUnits,
} from '../../../components/phase5';

interface AssetCategory {
  id: string;
  legal_entity_id: string;
  code: string;
  name: string;
  asset_account_id: string;
  accumulated_depreciation_account_id: string;
  depreciation_expense_account_id: string;
  impairment_loss_account_id: string | null;
  accumulated_impairment_account_id: string | null;
  revaluation_surplus_account_id: string | null;
  gain_account_id: string | null;
  loss_account_id: string | null;
  cip_account_id: string | null;
  default_method: string | null;
  default_useful_life_months: number | null;
  default_proration: string | null;
  capitalization_threshold: string | null;
  status: string;
}

interface Asset {
  id: string;
  legal_entity_id: string;
  asset_category_id: string;
  category_code?: string;
  asset_number: string;
  name: string;
  serial_number: string | null;
  asset_tag: string | null;
  acquisition_source: string | null;
  acquisition_date: string | null;
  in_service_date: string | null;
  currency: string;
  acquisition_cost: string;
  status: string;
}

interface AssetBook {
  id: string;
  accounting_book_id: string;
  method: string;
  proration: string;
  useful_life_months: number | null;
  residual_value: string;
  depreciation_start_date: string | null;
  cost_basis: string;
  accumulated_depreciation: string;
  accumulated_impairment: string;
  revaluation_surplus: string;
  revaluation_total: string;
  carrying_amount: string;
  status: string;
}

interface AssetTransaction {
  id: string;
  asset_book_id: string;
  kind: string;
  posting_date: string;
  amount: string;
  currency: string;
  reason: string | null;
  journal_entry_id: string | null;
  reverses_transaction_id: string | null;
}

interface Disposal {
  id: string;
  asset_book_id: string;
  kind: string;
  disposal_date: string;
  proceeds_amount: string | null;
  carrying_amount: string;
  accumulated_depreciation_removed: string;
  gain_loss_amount: string;
  journal_entry_id: string | null;
}

interface AssetDetail extends Asset {
  books: AssetBook[];
  transactions: AssetTransaction[];
  disposals: Disposal[];
}

const METHODS = ['STRAIGHT_LINE', 'DECLINING_BALANCE', 'UNITS_OF_PRODUCTION', 'CUSTOM'];
const PRORATION = ['MONTHLY', 'FULL_MONTH', 'HALF_MONTH', 'EXACT_DAYS', 'NONE'];
const DISPOSAL_KINDS = ['SALE', 'SCRAP', 'LOSS', 'WRITE_OFF', 'DONATION'];
const SOURCES = ['PURCHASE', 'MANUAL', 'MIGRATION', 'CIP', 'DONATION'];
const ACTIONS = [
  'capitalize',
  'transfer',
  'impair',
  'reverse-impairment',
  'revalue',
  'dispose',
] as const;
type Action = (typeof ACTIONS)[number];

const ACTION_PERMISSION: Record<Action, string> = {
  capitalize: 'asset.capitalize',
  transfer: 'asset.transfer',
  impair: 'asset.impair',
  'reverse-impairment': 'asset.impair',
  revalue: 'asset.revalue',
  dispose: 'asset.dispose',
};

/**
 * The asset register — doc 09.
 *
 * A fixed asset is not one number. Each book keeps its own method, life and
 * accumulated depreciation over one shared physical asset, so the carrying
 * amount shown here is per book and derived the same way the reconciliation
 * derives it: cost basis plus posted revaluations, less accumulated depreciation
 * and impairment. Nothing on this screen recomputes it.
 *
 * The lifecycle actions each post. Impairment and revaluation demand a reason
 * and an evidence reference because doc 09 calls them controlled transactions —
 * they move the carrying amount of an asset on someone's judgement, and the
 * judgement is part of the record. Disposal derives its own gain or loss from
 * the carrying amount at the disposal date; the form asks for proceeds, never
 * for the gain.
 */
export default function AssetsPage() {
  const held = useHeldPermissions();
  const can = (permission: string) => !held || held.has(permission);
  const keys = useIdempotencyKeys();
  const units = useMinorUnits();

  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

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

  const accounts = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; name: string }[] }>('/accounts', {
            query: { legal_entity_id: entityId, posting_only: 'true' },
          })
        : Promise.resolve({ data: [] as { id: string; code: string; name: string }[] }),
    [entityId],
  );
  const accountOptions = (accounts.data?.data ?? []).map((a) => ({
    value: a.id,
    label: `${a.code} — ${a.name}`,
  }));

  const categories = useResource(
    () =>
      api<{ data: AssetCategory[] }>('/asset-categories', {
        query: entityId ? { legal_entity_id: entityId } : {},
      }),
    [entityId],
  );

  const assets = useResource(
    () =>
      api<{ data: Asset[] }>('/assets', {
        query: { legal_entity_id: entityId, status: statusFilter },
      }),
    [entityId, statusFilter],
  );

  const [openId, setOpenId] = useState<string | null>(null);
  const asset = useResource(
    () => (openId ? api<AssetDetail>(`/assets/${openId}`) : Promise.resolve(null)),
    [openId],
  );

  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- forms ----------------------------------------------------------------
  const [category, setCategory] = useState({
    code: '',
    name: '',
    asset_account_id: '',
    accumulated_depreciation_account_id: '',
    depreciation_expense_account_id: '',
    impairment_loss_account_id: '',
    accumulated_impairment_account_id: '',
    revaluation_surplus_account_id: '',
    gain_account_id: '',
    loss_account_id: '',
    cip_account_id: '',
    default_method: 'STRAIGHT_LINE',
    default_useful_life_months: '60',
    default_proration: 'MONTHLY',
    capitalization_threshold: '',
  });

  const [assetForm, setAssetForm] = useState({
    asset_category_id: '',
    asset_number: '',
    name: '',
    currency: '',
    acquisition_cost: '',
    acquisition_source: 'PURCHASE',
    acquisition_date: today(),
    in_service_date: '',
    serial_number: '',
    asset_tag: '',
  });

  const [bookForm, setBookForm] = useState({
    accounting_book_id: '',
    method: '',
    proration: '',
    useful_life_months: '',
    residual_value: '',
    depreciation_start_date: '',
    cost_basis: '',
  });

  const [action, setAction] = useState<Action>('capitalize');
  const [actionForm, setActionForm] = useState({
    accounting_book_id: '',
    amount: '',
    posting_date: today(),
    reason: '',
    credit_account_id: '',
    in_service_date: '',
    effective_date: today(),
    free_text_location: '',
    custodian_name: '',
    kind: 'SALE',
    disposal_date: today(),
    proceeds_amount: '',
    proceeds_account_id: '',
    impairment_transaction_id: '',
  });
  const setAct = (key: keyof typeof actionForm) => (value: string) =>
    setActionForm({ ...actionForm, [key]: value });

  const createCategory = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      legal_entity_id: entityId,
      code: category.code,
      name: category.name,
      asset_account_id: category.asset_account_id,
      accumulated_depreciation_account_id: category.accumulated_depreciation_account_id,
      depreciation_expense_account_id: category.depreciation_expense_account_id,
      impairment_loss_account_id: category.impairment_loss_account_id || null,
      accumulated_impairment_account_id: category.accumulated_impairment_account_id || null,
      revaluation_surplus_account_id: category.revaluation_surplus_account_id || null,
      gain_account_id: category.gain_account_id || null,
      loss_account_id: category.loss_account_id || null,
      cip_account_id: category.cip_account_id || null,
      default_method: category.default_method,
      default_useful_life_months: category.default_useful_life_months
        ? Number(category.default_useful_life_months)
        : null,
      default_proration: category.default_proration,
      capitalization_threshold: category.capitalization_threshold || null,
    };
    try {
      await api('/asset-categories', {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor('asset-category', body),
      });
      keys.settle('asset-category');
      setNotice(`${category.code} created.`);
      setCategory({ ...category, code: '', name: '' });
      categories.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const createAsset = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      legal_entity_id: entityId,
      asset_category_id: assetForm.asset_category_id,
      asset_number: assetForm.asset_number,
      name: assetForm.name,
      currency: assetForm.currency || (books.data?.data[0]?.base_currency ?? ''),
      acquisition_cost: assetForm.acquisition_cost,
      acquisition_source: assetForm.acquisition_source,
      acquisition_date: assetForm.acquisition_date || null,
      in_service_date: assetForm.in_service_date || null,
      serial_number: assetForm.serial_number || null,
      asset_tag: assetForm.asset_tag || null,
    };
    try {
      const created = await api<Asset>('/assets', {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor('asset', body),
      });
      keys.settle('asset');
      setOpenId(created.id);
      setNotice(
        `${created.asset_number} created as a draft. It needs a book before it can depreciate, and ` +
          'capitalizing it is what puts its cost in the ledger.',
      );
      setAssetForm({ ...assetForm, asset_number: '', name: '', acquisition_cost: '' });
      assets.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const createBook = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!openId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      accounting_book_id: bookForm.accounting_book_id || (books.data?.data[0]?.id ?? ''),
      ...(bookForm.method ? { method: bookForm.method } : {}),
      ...(bookForm.proration ? { proration: bookForm.proration } : {}),
      ...(bookForm.useful_life_months
        ? { useful_life_months: Number(bookForm.useful_life_months) }
        : {}),
      ...(bookForm.residual_value ? { residual_value: bookForm.residual_value } : {}),
      ...(bookForm.depreciation_start_date
        ? { depreciation_start_date: bookForm.depreciation_start_date }
        : {}),
      ...(bookForm.cost_basis ? { cost_basis: bookForm.cost_basis } : {}),
    };
    try {
      await api(`/assets/${openId}/books`, {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor(`asset-book-${openId}`, body),
      });
      keys.settle(`asset-book-${openId}`);
      setNotice('Book added. Its schedule is written when the asset is capitalized.');
      asset.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const runAction = async () => {
    if (!openId) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const bookId = actionForm.accounting_book_id || (books.data?.data[0]?.id ?? '');
    const body =
      action === 'capitalize'
        ? {
            posting_date: actionForm.posting_date,
            credit_account_id: actionForm.credit_account_id || null,
            in_service_date: actionForm.in_service_date || null,
          }
        : action === 'transfer'
          ? {
              effective_date: actionForm.effective_date,
              free_text_location: actionForm.free_text_location || null,
              custodian_name: actionForm.custodian_name || null,
              reason: actionForm.reason || null,
            }
          : action === 'dispose'
            ? {
                kind: actionForm.kind,
                disposal_date: actionForm.disposal_date,
                ...(actionForm.proceeds_amount
                  ? { proceeds_amount: actionForm.proceeds_amount }
                  : {}),
                proceeds_account_id: actionForm.proceeds_account_id || null,
                reason: actionForm.reason || null,
              }
            : {
                accounting_book_id: bookId,
                amount: actionForm.amount,
                posting_date: actionForm.posting_date,
                reason: actionForm.reason,
                ...(action === 'reverse-impairment' && actionForm.impairment_transaction_id
                  ? { impairment_transaction_id: actionForm.impairment_transaction_id }
                  : {}),
              };
    try {
      await api(`/assets/${openId}/${action}`, {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor(`${action}-${openId}`, body),
      });
      keys.settle(`${action}-${openId}`);
      setNotice(
        action === 'capitalize'
          ? 'Capitalized. The cost is in the ledger and the depreciation schedule exists — see the depreciation screen.'
          : action === 'dispose'
            ? 'Disposed. The gain or loss was derived from the carrying amount at that date, not entered.'
            : `${action.replace(/-/g, ' ')} posted, with its reason on the record.`,
      );
      setActionForm({ ...actionForm, amount: '', reason: '' });
      asset.reload();
      assets.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const detail = asset.data;
  const categoryOf = (id: string) => (categories.data?.data ?? []).find((c) => c.id === id);

  return (
    <>
      <PageHeader
        title="Asset register"
        description="Assets, their books and everything that has happened to them. Carrying amount is derived per book, never stored twice."
      />
      <ErrorBanner error={error ?? assets.error ?? asset.error ?? categories.error} />
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
        <Field
          label="Status"
          name="status"
          value={statusFilter}
          onChange={setStatusFilter}
          options={enumOptions([
            'DRAFT',
            'ACTIVE',
            'FULLY_DEPRECIATED',
            'IMPAIRED',
            'DISPOSED',
            'WRITTEN_OFF',
          ])}
        />
      </div>

      <DataTable<Asset>
        caption="Assets"
        rows={assets.data?.data ?? []}
        rowKey={(row) => row.id}
        empty="No assets match these filters."
        columns={[
          { key: 'number', header: 'Number', render: (row) => row.asset_number },
          { key: 'name', header: 'Name', render: (row) => row.name },
          {
            key: 'category',
            header: 'Category',
            render: (row) => row.category_code ?? categoryOf(row.asset_category_id)?.code ?? '—',
          },
          { key: 'in_service', header: 'In service', render: (row) => day(row.in_service_date) },
          {
            key: 'cost',
            header: 'Acquisition cost',
            numeric: true,
            render: (row) => <Money value={row.acquisition_cost} minorUnit={units(row.currency)} />,
          },
          { key: 'currency', header: 'Currency', render: (row) => row.currency },
          { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
          {
            key: 'open',
            header: 'Detail',
            render: (row) => (
              <Button onClick={() => setOpenId(row.id)}>
                Open
                <span className="visually-hidden"> asset {row.asset_number}</span>
              </Button>
            ),
          },
        ]}
      />

      {detail ? (
        <div className="card">
          <h2>
            {detail.asset_number} — {detail.name} <Status value={detail.status} />
          </h2>
          <SummaryList
            items={[
              {
                term: 'Acquisition cost',
                value: <Money value={detail.acquisition_cost} minorUnit={units(detail.currency)} />,
              },
              { term: 'Acquired', value: day(detail.acquisition_date) },
              {
                term: 'In service',
                value: day(detail.in_service_date),
                hint: 'Depreciation starts from here, not from the acquisition date.',
              },
              { term: 'Source', value: detail.acquisition_source ?? '—' },
              { term: 'Serial', value: detail.serial_number ?? '—' },
            ]}
          />

          <DataTable<AssetBook>
            caption="Books"
            rows={detail.books}
            rowKey={(row) => row.id}
            empty="No book yet. Without one there is no schedule and no depreciation."
            columns={[
              {
                key: 'book',
                header: 'Accounting book',
                render: (row) =>
                  (books.data?.data ?? []).find((b) => b.id === row.accounting_book_id)?.code ??
                  row.accounting_book_id.slice(0, 8),
              },
              {
                key: 'method',
                header: 'Method',
                render: (row) => row.method.replace(/_/g, ' ').toLowerCase(),
              },
              {
                key: 'life',
                header: 'Life (months)',
                numeric: true,
                render: (row) => row.useful_life_months ?? '—',
              },
              {
                key: 'cost_basis',
                header: 'Cost basis',
                numeric: true,
                render: (row) => (
                  <Money value={row.cost_basis} minorUnit={units(detail.currency)} />
                ),
              },
              {
                key: 'revaluation',
                header: 'Revaluations',
                numeric: true,
                render: (row) => (
                  <Money value={row.revaluation_total} minorUnit={units(detail.currency)} />
                ),
              },
              {
                key: 'accumulated',
                header: 'Accumulated depreciation',
                numeric: true,
                render: (row) => (
                  <Money value={row.accumulated_depreciation} minorUnit={units(detail.currency)} />
                ),
              },
              {
                key: 'impairment',
                header: 'Accumulated impairment',
                numeric: true,
                render: (row) => (
                  <Money value={row.accumulated_impairment} minorUnit={units(detail.currency)} />
                ),
              },
              {
                key: 'carrying',
                header: 'Carrying amount',
                numeric: true,
                render: (row) => (
                  <Money value={row.carrying_amount} minorUnit={units(detail.currency)} />
                ),
              },
              { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
            ]}
          />
          <p className="field-hint">
            Carrying amount is cost basis plus posted revaluations, less accumulated depreciation
            and impairment — the same derivation the asset-to-GL reconciliation uses.
          </p>

          <DataTable<AssetTransaction>
            caption="Transactions"
            rows={detail.transactions}
            rowKey={(row) => row.id}
            empty="Nothing has been posted against this asset yet."
            columns={[
              { key: 'date', header: 'Posted', render: (row) => day(row.posting_date) },
              {
                key: 'kind',
                header: 'Kind',
                render: (row) =>
                  `${row.kind.replace(/_/g, ' ').toLowerCase()}${row.reverses_transaction_id ? ' (reversal)' : ''}`,
              },
              {
                key: 'amount',
                header: 'Amount',
                numeric: true,
                render: (row) => <Money value={row.amount} minorUnit={units(row.currency)} />,
              },
              { key: 'reason', header: 'Reason', render: (row) => row.reason ?? '—' },
              {
                key: 'journal',
                header: 'Journal',
                render: (row) => (row.journal_entry_id ? 'posted' : 'none'),
              },
            ]}
          />

          {detail.disposals.length > 0 ? (
            <DataTable<Disposal>
              caption="Disposals"
              rows={detail.disposals}
              rowKey={(row) => row.id}
              columns={[
                { key: 'date', header: 'Date', render: (row) => day(row.disposal_date) },
                { key: 'kind', header: 'Kind', render: (row) => row.kind.toLowerCase() },
                {
                  key: 'proceeds',
                  header: 'Proceeds',
                  numeric: true,
                  render: (row) => (
                    <Money value={row.proceeds_amount} minorUnit={units(detail.currency)} />
                  ),
                },
                {
                  key: 'carrying',
                  header: 'Carrying amount removed',
                  numeric: true,
                  render: (row) => (
                    <Money value={row.carrying_amount} minorUnit={units(detail.currency)} />
                  ),
                },
                {
                  key: 'gain_loss',
                  header: 'Gain / (loss)',
                  numeric: true,
                  render: (row) => (
                    <Money value={row.gain_loss_amount} minorUnit={units(detail.currency)} />
                  ),
                },
              ]}
            />
          ) : null}

          <h3>Lifecycle</h3>
          <Field
            label="Action"
            name="action"
            value={action}
            onChange={(value) => setAction(value as Action)}
            required
            options={ACTIONS.map((value) => ({
              value,
              label: value.replace(/-/g, ' '),
            }))}
          />
          {!can(ACTION_PERMISSION[action]) ? (
            <p className="field-hint">needs {ACTION_PERMISSION[action]}</p>
          ) : (
            <>
              {action === 'capitalize' ? (
                <>
                  <p className="field-hint">
                    Debits the category&rsquo;s asset account and writes the depreciation schedule.
                    Leave the credit account empty for an asset built through CIP — the category
                    knows where that came from.
                  </p>
                  <Field
                    label="Posting date"
                    name="cap_posting_date"
                    type="date"
                    value={actionForm.posting_date}
                    onChange={setAct('posting_date')}
                    required
                  />
                  <Field
                    label="Credit account"
                    name="cap_credit_account"
                    value={actionForm.credit_account_id}
                    onChange={setAct('credit_account_id')}
                    options={accountOptions}
                    hint="Payables, bank or a clearing account — whatever paid for it."
                  />
                  <Field
                    label="In-service date"
                    name="cap_in_service"
                    type="date"
                    value={actionForm.in_service_date}
                    onChange={setAct('in_service_date')}
                    hint="Optional. Depreciation runs from this date."
                  />
                </>
              ) : null}

              {action === 'transfer' ? (
                <>
                  <Field
                    label="Effective date"
                    name="transfer_date"
                    type="date"
                    value={actionForm.effective_date}
                    onChange={setAct('effective_date')}
                    required
                  />
                  <Field
                    label="Location"
                    name="transfer_location"
                    value={actionForm.free_text_location}
                    onChange={setAct('free_text_location')}
                  />
                  <Field
                    label="Custodian"
                    name="transfer_custodian"
                    value={actionForm.custodian_name}
                    onChange={setAct('custodian_name')}
                  />
                  <Field
                    label="Reason"
                    name="transfer_reason"
                    value={actionForm.reason}
                    onChange={setAct('reason')}
                  />
                </>
              ) : null}

              {action === 'impair' || action === 'reverse-impairment' || action === 'revalue' ? (
                <>
                  <p className="field-hint">
                    {action === 'revalue'
                      ? 'A signed change in carrying amount: negative writes the asset down. The split between revaluation surplus and profit or loss follows IAS 16 and is decided by the server.'
                      : action === 'impair'
                        ? 'Writes the asset down into a contra account rather than overwriting historical cost (doc 09).'
                        : 'IAS 36 permits reversal for non-goodwill assets, capped at the carrying amount that would have applied without the original impairment.'}
                  </p>
                  <Field
                    label="Accounting book"
                    name="action_book"
                    value={actionForm.accounting_book_id || (books.data?.data[0]?.id ?? '')}
                    onChange={setAct('accounting_book_id')}
                    required
                    options={(books.data?.data ?? []).map((b) => ({
                      value: b.id,
                      label: `${b.code} (${b.base_currency})`,
                    }))}
                  />
                  <Field
                    label="Amount"
                    name="action_amount"
                    value={actionForm.amount}
                    onChange={setAct('amount')}
                    required
                    placeholder="0.00"
                  />
                  <Field
                    label="Posting date"
                    name="action_posting_date"
                    type="date"
                    value={actionForm.posting_date}
                    onChange={setAct('posting_date')}
                    required
                  />
                  <Field
                    label="Reason"
                    name="action_reason"
                    value={actionForm.reason}
                    onChange={setAct('reason')}
                    required
                    hint="Required and stored: this is someone's judgement about an asset's worth."
                  />
                  {action === 'reverse-impairment' ? (
                    <Field
                      label="Impairment being reversed"
                      name="action_impairment"
                      value={actionForm.impairment_transaction_id}
                      onChange={setAct('impairment_transaction_id')}
                      options={detail.transactions
                        .filter((t) => t.kind === 'IMPAIRMENT')
                        .map((t) => ({
                          value: t.id,
                          label: `${day(t.posting_date)} — ${t.amount}`,
                        }))}
                      hint="Optional, but it links the reversal to what it undoes."
                    />
                  ) : null}
                </>
              ) : null}

              {action === 'dispose' ? (
                <>
                  <p className="field-hint">
                    The gain or loss is derived from the carrying amount at the disposal date. Enter
                    what was received, never what was gained.
                  </p>
                  <Field
                    label="Kind"
                    name="disposal_kind"
                    value={actionForm.kind}
                    onChange={setAct('kind')}
                    required
                    options={enumOptions(DISPOSAL_KINDS)}
                  />
                  <Field
                    label="Disposal date"
                    name="disposal_date"
                    type="date"
                    value={actionForm.disposal_date}
                    onChange={setAct('disposal_date')}
                    required
                  />
                  <Field
                    label="Proceeds"
                    name="disposal_proceeds"
                    value={actionForm.proceeds_amount}
                    onChange={setAct('proceeds_amount')}
                    placeholder="0.00"
                  />
                  <Field
                    label="Proceeds account"
                    name="disposal_proceeds_account"
                    value={actionForm.proceeds_account_id}
                    onChange={setAct('proceeds_account_id')}
                    options={accountOptions}
                  />
                  <Field
                    label="Reason"
                    name="disposal_reason"
                    value={actionForm.reason}
                    onChange={setAct('reason')}
                  />
                </>
              ) : null}

              <Button variant="primary" busy={busy} onClick={runAction}>
                {action.replace(/-/g, ' ')}
              </Button>
            </>
          )}

          {can('asset.create') ? (
            <form onSubmit={createBook}>
              <h3>Add a book</h3>
              <p className="field-hint">
                A second book keeps its own method and life over the same physical asset — statutory
                and tax lives differ, and each posts its own journals.
              </p>
              <Field
                label="Accounting book"
                name="new_book"
                value={bookForm.accounting_book_id || (books.data?.data[0]?.id ?? '')}
                onChange={(v) => setBookForm({ ...bookForm, accounting_book_id: v })}
                required
                options={(books.data?.data ?? []).map((b) => ({
                  value: b.id,
                  label: `${b.code} (${b.base_currency})`,
                }))}
              />
              <Field
                label="Method"
                name="book_method"
                value={bookForm.method}
                onChange={(v) => setBookForm({ ...bookForm, method: v })}
                options={enumOptions(METHODS)}
                hint="Empty takes the category's default."
              />
              <Field
                label="Proration"
                name="book_proration"
                value={bookForm.proration}
                onChange={(v) => setBookForm({ ...bookForm, proration: v })}
                options={enumOptions(PRORATION)}
              />
              <Field
                label="Useful life (months)"
                name="book_life"
                value={bookForm.useful_life_months}
                onChange={(v) => setBookForm({ ...bookForm, useful_life_months: v })}
              />
              <Field
                label="Residual value"
                name="book_residual"
                value={bookForm.residual_value}
                onChange={(v) => setBookForm({ ...bookForm, residual_value: v })}
                placeholder="0.00"
                hint="Depreciation stops here, not at zero."
              />
              <Field
                label="Depreciation start"
                name="book_start"
                type="date"
                value={bookForm.depreciation_start_date}
                onChange={(v) => setBookForm({ ...bookForm, depreciation_start_date: v })}
              />
              <Button type="submit" busy={busy}>
                Add book
              </Button>
            </form>
          ) : null}

          <div className="button-row">
            <Button onClick={() => setOpenId(null)}>Close</Button>
          </div>
        </div>
      ) : null}

      <DataTable<AssetCategory>
        caption="Asset categories"
        rows={categories.data?.data ?? []}
        rowKey={(row) => row.id}
        empty="No categories. An asset cannot exist without one — the category carries the accounts it posts to."
        columns={[
          { key: 'code', header: 'Code', render: (row) => row.code },
          { key: 'name', header: 'Name', render: (row) => row.name },
          {
            key: 'method',
            header: 'Default method',
            render: (row) => row.default_method?.replace(/_/g, ' ').toLowerCase() ?? '—',
          },
          {
            key: 'life',
            header: 'Default life',
            numeric: true,
            render: (row) => row.default_useful_life_months ?? '—',
          },
          {
            key: 'threshold',
            header: 'Capitalization threshold',
            numeric: true,
            render: (row) => <Money value={row.capitalization_threshold} />,
          },
          {
            key: 'impairment',
            header: 'Impairment accounts',
            render: (row) =>
              row.impairment_loss_account_id && row.accumulated_impairment_account_id
                ? 'mapped'
                : 'not mapped — impairment will be refused',
          },
        ]}
      />

      {entityId && can('asset.create') ? (
        <form onSubmit={createAsset} className="card">
          <h2>New asset</h2>
          <Field
            label="Category"
            name="asset_category"
            value={assetForm.asset_category_id}
            onChange={(v) => setAssetForm({ ...assetForm, asset_category_id: v })}
            required
            options={(categories.data?.data ?? []).map((c) => ({
              value: c.id,
              label: `${c.code} — ${c.name}`,
            }))}
            hint="Decides which accounts every posting for this asset uses."
          />
          <Field
            label="Asset number"
            name="asset_number"
            value={assetForm.asset_number}
            onChange={(v) => setAssetForm({ ...assetForm, asset_number: v })}
            required
          />
          <Field
            label="Name"
            name="asset_name"
            value={assetForm.name}
            onChange={(v) => setAssetForm({ ...assetForm, name: v })}
            required
          />
          <Field
            label="Currency"
            name="asset_currency"
            value={assetForm.currency || (books.data?.data[0]?.base_currency ?? '')}
            onChange={(v) => setAssetForm({ ...assetForm, currency: v })}
            required
            hint="Three letters, e.g. USD."
          />
          <Field
            label="Acquisition cost"
            name="acquisition_cost"
            value={assetForm.acquisition_cost}
            onChange={(v) => setAssetForm({ ...assetForm, acquisition_cost: v })}
            required
            placeholder="0.00"
            hint="Below the category's capitalization threshold this is refused — it is an expense, not an asset."
          />
          <Field
            label="Source"
            name="acquisition_source"
            value={assetForm.acquisition_source}
            onChange={(v) => setAssetForm({ ...assetForm, acquisition_source: v })}
            options={enumOptions(SOURCES)}
          />
          <Field
            label="Acquisition date"
            name="acquisition_date"
            type="date"
            value={assetForm.acquisition_date}
            onChange={(v) => setAssetForm({ ...assetForm, acquisition_date: v })}
          />
          <Field
            label="In-service date"
            name="in_service_date"
            type="date"
            value={assetForm.in_service_date}
            onChange={(v) => setAssetForm({ ...assetForm, in_service_date: v })}
          />
          <Field
            label="Serial number"
            name="serial_number"
            value={assetForm.serial_number}
            onChange={(v) => setAssetForm({ ...assetForm, serial_number: v })}
          />
          <Field
            label="Asset tag"
            name="asset_tag"
            value={assetForm.asset_tag}
            onChange={(v) => setAssetForm({ ...assetForm, asset_tag: v })}
          />
          <Button type="submit" variant="primary" busy={busy}>
            Create asset
          </Button>
        </form>
      ) : null}

      {entityId && can('asset_category.manage') ? (
        <form onSubmit={createCategory} className="card">
          <h2>New asset category</h2>
          <p className="page-description">
            The category is where the accounting lives: cost, accumulated depreciation and
            depreciation expense are required because without them a posting has nowhere to go.
          </p>
          <Field
            label="Code"
            name="category_code"
            value={category.code}
            onChange={(v) => setCategory({ ...category, code: v })}
            required
          />
          <Field
            label="Name"
            name="category_name"
            value={category.name}
            onChange={(v) => setCategory({ ...category, name: v })}
            required
          />
          <Field
            label="Asset cost account"
            name="asset_account"
            value={category.asset_account_id}
            onChange={(v) => setCategory({ ...category, asset_account_id: v })}
            required
            options={accountOptions}
          />
          <Field
            label="Accumulated depreciation account"
            name="accdep_account"
            value={category.accumulated_depreciation_account_id}
            onChange={(v) => setCategory({ ...category, accumulated_depreciation_account_id: v })}
            required
            options={accountOptions}
          />
          <Field
            label="Depreciation expense account"
            name="depexp_account"
            value={category.depreciation_expense_account_id}
            onChange={(v) => setCategory({ ...category, depreciation_expense_account_id: v })}
            required
            options={accountOptions}
          />
          <Field
            label="Impairment loss account"
            name="impairment_loss_account"
            value={category.impairment_loss_account_id}
            onChange={(v) => setCategory({ ...category, impairment_loss_account_id: v })}
            options={accountOptions}
            hint="Without this pair, impairment is refused rather than posted somewhere plausible."
          />
          <Field
            label="Accumulated impairment account"
            name="accumulated_impairment_account"
            value={category.accumulated_impairment_account_id}
            onChange={(v) => setCategory({ ...category, accumulated_impairment_account_id: v })}
            options={accountOptions}
          />
          <Field
            label="Revaluation surplus account"
            name="revaluation_surplus_account"
            value={category.revaluation_surplus_account_id}
            onChange={(v) => setCategory({ ...category, revaluation_surplus_account_id: v })}
            options={accountOptions}
          />
          <Field
            label="Gain on disposal account"
            name="gain_account"
            value={category.gain_account_id}
            onChange={(v) => setCategory({ ...category, gain_account_id: v })}
            options={accountOptions}
          />
          <Field
            label="Loss on disposal account"
            name="loss_account"
            value={category.loss_account_id}
            onChange={(v) => setCategory({ ...category, loss_account_id: v })}
            options={accountOptions}
          />
          <Field
            label="Construction in progress account"
            name="cip_account"
            value={category.cip_account_id}
            onChange={(v) => setCategory({ ...category, cip_account_id: v })}
            options={accountOptions}
          />
          <Field
            label="Default method"
            name="default_method"
            value={category.default_method}
            onChange={(v) => setCategory({ ...category, default_method: v })}
            options={enumOptions(METHODS)}
          />
          <Field
            label="Default useful life (months)"
            name="default_life"
            value={category.default_useful_life_months}
            onChange={(v) => setCategory({ ...category, default_useful_life_months: v })}
          />
          <Field
            label="Default proration"
            name="default_proration"
            value={category.default_proration}
            onChange={(v) => setCategory({ ...category, default_proration: v })}
            options={enumOptions(PRORATION)}
          />
          <Field
            label="Capitalization threshold"
            name="capitalization_threshold"
            value={category.capitalization_threshold}
            onChange={(v) => setCategory({ ...category, capitalization_threshold: v })}
            placeholder="0.00"
            hint="Below this, a purchase is an expense rather than an asset."
          />
          <Button type="submit" variant="primary" busy={busy}>
            Create category
          </Button>
        </form>
      ) : null}
    </>
  );
}
