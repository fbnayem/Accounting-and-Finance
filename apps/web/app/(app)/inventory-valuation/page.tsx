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
  useResource,
} from '../../../components/ui';
import { useHeldPermissions, useIdempotencyKeys } from '../../../components/document-lines';
import {
  Money,
  SummaryList,
  agreementWord,
  day,
  enumOptions,
  isZeroDecimal,
  precise,
  quantity,
  today,
  useMinorUnits,
} from '../../../components/phase5';

interface ValuationRow {
  item_id: string;
  sku: string;
  name: string;
  warehouse_id: string;
  warehouse_code: string;
  valuation_method: string;
  quantity: string;
  layer_value: string;
  landed_cost_on_hand: string;
  total_value: string;
  has_provisional: boolean;
}

interface Layer {
  id: string;
  item_id: string;
  sku: string;
  warehouse_id: string;
  received_date: string;
  original_quantity: string;
  remaining_quantity: string;
  unit_cost: string;
  currency: string;
  status: string;
  is_provisional: boolean;
  remaining_value: string;
}

interface ProvisionalLayer {
  id: string;
  sku: string;
  received_date: string;
  original_quantity: string;
  remaining_quantity: string;
  unit_cost: string;
  status: string;
  settled_at: string | null;
}

interface ValuationReport {
  data: ValuationRow[];
  total_value: string;
  layers: Layer[];
  provisional_layers: ProvisionalLayer[];
}

interface ReconcilingItem {
  kind: string;
  amount: string;
  count: number;
  explanation: string;
}

interface Reconciliation {
  legal_entity_id: string;
  control_accounts: { account_id: string; code: string }[];
  valuation_total: string;
  valuation_layers: string;
  valuation_landed_cost_on_hand: string;
  gl_balance: string;
  difference: string;
  reconciling_items: ReconcilingItem[];
  explained: string;
  unexplained: string;
}

interface OnHandRow {
  item_id: string;
  sku: string;
  name: string;
  base_uom: string;
  warehouse_id: string;
  warehouse_code: string;
  quantity: string;
}

interface Target {
  cost_layer_id: string;
  weight: string;
  volume: string;
  manual_amount: string;
}

const CHARGE_TYPES = ['FREIGHT', 'INSURANCE', 'DUTY', 'HANDLING', 'OTHER'];
const ALLOCATION_BASES = ['VALUE', 'QUANTITY', 'WEIGHT', 'VOLUME', 'MANUAL'];

/**
 * Inventory valuation, against the general ledger — Phase 5 exit criterion 1.
 *
 * The criterion is that the valuation report reconciles to the inventory control
 * account, and a screen showing only one of the two numbers cannot tell anyone
 * whether it does. So this screen shows three: what the subledger says stock is
 * worth, what the control accounts in the ledger say, and the difference —
 * decomposed into named reconciling items, with whatever they do not cover
 * reported as unexplained rather than absorbed. An unexplained zero is the pass
 * condition; an unexplained anything-else is the finding, and it is stated in
 * those words rather than left for someone to notice.
 *
 * Below that is the evidence: the layers still holding stock, and the
 * provisional ones whose cost is an estimate on both sides until settled.
 */
export default function InventoryValuationPage() {
  const held = useHeldPermissions();
  const can = (permission: string) => !held || held.has(permission);
  const keys = useIdempotencyKeys();
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
  const book = (books.data?.data ?? []).find((b) => b.id === bookId) ?? books.data?.data[0];
  const minorUnit = units(book?.base_currency);

  const warehouses = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; name: string }[] }>('/warehouses', {
            query: { legal_entity_id: entityId },
          })
        : Promise.resolve({ data: [] as { id: string; code: string; name: string }[] }),
    [entityId],
  );
  const [warehouseId, setWarehouseId] = useState('');

  const report = useResource(
    () =>
      entityId && can('report.view')
        ? api<ValuationReport>('/reports/inventory-valuation', {
            query: { legal_entity_id: entityId, warehouse_id: warehouseId },
          })
        : Promise.resolve(null),
    [entityId, warehouseId, held !== null],
  );

  const reconciliation = useResource(
    () =>
      entityId && can('report.view')
        ? api<Reconciliation>('/reports/inventory-reconciliation', {
            query: { legal_entity_id: entityId, accounting_book_id: bookId },
          })
        : Promise.resolve(null),
    [entityId, bookId, held !== null],
  );

  const onHand = useResource(
    () =>
      entityId
        ? api<{ data: OnHandRow[] }>('/inventory/on-hand', {
            query: { legal_entity_id: entityId, warehouse_id: warehouseId },
          })
        : Promise.resolve({ data: [] as OnHandRow[] }),
    [entityId, warehouseId],
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

  const [landed, setLanded] = useState({
    charge_type: 'FREIGHT',
    allocation_basis: 'VALUE',
    amount: '',
    clearing_account_id: '',
    posting_date: today(),
    document_number: '',
  });
  const [targets, setTargets] = useState<Target[]>([]);
  const [addLayerId, setAddLayerId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const addTarget = () => {
    if (!addLayerId || targets.some((t) => t.cost_layer_id === addLayerId)) return;
    setTargets([
      ...targets,
      { cost_layer_id: addLayerId, weight: '', volume: '', manual_amount: '' },
    ]);
    setAddLayerId('');
  };

  const createLandedCost = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      accounting_book_id: bookId || (books.data?.data[0]?.id ?? ''),
      posting_date: landed.posting_date,
      charge_type: landed.charge_type,
      allocation_basis: landed.allocation_basis,
      amount: landed.amount,
      clearing_account_id: landed.clearing_account_id,
      document_number: landed.document_number || null,
      targets: targets.map((t) => ({
        cost_layer_id: t.cost_layer_id,
        ...(t.weight ? { weight: t.weight } : {}),
        ...(t.volume ? { volume: t.volume } : {}),
        ...(t.manual_amount ? { manual_amount: t.manual_amount } : {}),
      })),
    };
    try {
      await api('/inventory/landed-costs', {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor('landed-cost', body),
      });
      keys.settle('landed-cost');
      setTargets([]);
      setLanded({ ...landed, amount: '', document_number: '' });
      setNotice(
        'Landed cost capitalised onto the chosen layers. Stock still on hand carries it in the ' +
          'valuation; the part on layers already issued shows up as a reconciling item until it settles.',
      );
      report.reload();
      reconciliation.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const recon = reconciliation.data;
  const layers = report.data?.layers ?? [];

  return (
    <>
      <PageHeader
        title="Inventory valuation"
        description="What the stock is worth, what the control account says, and the difference between them named item by item."
      />
      <ErrorBanner error={error ?? reconciliation.error ?? report.error ?? onHand.error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

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
          hint="Required: the reconciliation holds one entity's subledger against that entity's control accounts."
        />
        <Field
          label="Accounting book"
          name="book"
          value={bookId}
          onChange={setBookId}
          options={(books.data?.data ?? []).map((b) => ({
            value: b.id,
            label: `${b.code} (${b.base_currency})`,
          }))}
          hint="Leave empty to take every book together."
        />
        <Field
          label="Warehouse"
          name="warehouse"
          value={warehouseId}
          onChange={setWarehouseId}
          options={(warehouses.data?.data ?? []).map((w) => ({
            value: w.id,
            label: `${w.code} — ${w.name}`,
          }))}
          hint="Narrows the valuation rows and layers. The reconciliation stays whole-entity — a per-warehouse slice has no control account to sit against."
        />
      </div>

      {!entityId ? <p className="empty">Choose a legal entity to value its stock.</p> : null}

      {recon ? (
        <div className="card">
          <h2>Subledger against the ledger</h2>
          <SummaryList
            items={[
              {
                term: 'Stock value (subledger)',
                value: <Money value={recon.valuation_total} minorUnit={minorUnit} />,
                hint: 'Cost layers still holding stock, plus landed cost capitalised onto them.',
              },
              {
                term: 'Control accounts (GL)',
                value: <Money value={recon.gl_balance} minorUnit={minorUnit} />,
                hint:
                  recon.control_accounts.length > 0
                    ? recon.control_accounts.map((a) => a.code).join(', ')
                    : 'No item maps an inventory account for this entity, so there is no control account to compare against.',
              },
              {
                term: 'Difference',
                value: <Money value={recon.difference} minorUnit={minorUnit} />,
                hint: `GL minus subledger — ${agreementWord(recon.difference)}.`,
              },
              {
                term: 'Explained',
                value: <Money value={recon.explained} minorUnit={minorUnit} />,
                hint: 'The named items below.',
              },
              {
                term: 'Unexplained',
                value: <Money value={recon.unexplained} minorUnit={minorUnit} />,
                hint: 'Exit criterion 1 is met when this is zero.',
              },
            ]}
          />

          {isZeroDecimal(recon.unexplained) ? (
            <Notice tone="success">
              Every part of the difference is accounted for. The valuation report reconciles to the
              inventory control account.
            </Notice>
          ) : (
            <Notice tone="warning">
              <Money value={recon.unexplained} minorUnit={minorUnit} /> of the difference is not
              explained by any of the items below. That is a finding to investigate, not a rounding
              preference — start from the movements on the stock documents screen and their cost
              layers.
            </Notice>
          )}

          <DataTable<ReconcilingItem>
            caption="Reconciling items"
            rows={recon.reconciling_items}
            rowKey={(row) => row.kind}
            empty="Nothing sits between the two figures."
            columns={[
              {
                key: 'kind',
                header: 'Item',
                render: (row) => row.kind.replace(/_/g, ' ').toLowerCase(),
              },
              {
                key: 'amount',
                header: 'Amount',
                numeric: true,
                render: (row) => <Money value={row.amount} minorUnit={minorUnit} />,
              },
              { key: 'count', header: 'Rows', numeric: true, render: (row) => row.count },
              { key: 'why', header: 'Why it is there', render: (row) => row.explanation },
            ]}
          />
          <p className="field-hint">
            Provisional layers pending settlement are listed as informational: they carry an
            estimated cost on both sides, so they are not part of the arithmetic above.
          </p>
        </div>
      ) : null}

      {report.data ? (
        <>
          <div className="card">
            <h2>Valuation by item</h2>
            <SummaryList
              items={[
                {
                  term: 'Total value',
                  value: <Money value={report.data.total_value} minorUnit={minorUnit} />,
                  hint: 'Summed exactly from the rows below, not re-added here.',
                },
                { term: 'Rows', value: report.data.data.length },
              ]}
            />
            <DataTable<ValuationRow>
              caption="Stock value by item and warehouse"
              rows={report.data.data}
              rowKey={(row) => `${row.item_id}-${row.warehouse_id}`}
              empty="No stock on hand for these filters."
              columns={[
                { key: 'sku', header: 'SKU', render: (row) => row.sku },
                { key: 'name', header: 'Item', render: (row) => row.name },
                { key: 'warehouse', header: 'Warehouse', render: (row) => row.warehouse_code },
                {
                  key: 'method',
                  header: 'Method',
                  render: (row) => row.valuation_method.replace(/_/g, ' ').toLowerCase(),
                },
                {
                  key: 'quantity',
                  header: 'On hand',
                  numeric: true,
                  render: (row) => quantity(row.quantity),
                },
                {
                  key: 'layers',
                  header: 'Layer value',
                  numeric: true,
                  render: (row) => <Money value={row.layer_value} minorUnit={minorUnit} />,
                },
                {
                  key: 'landed',
                  header: 'Landed cost',
                  numeric: true,
                  render: (row) => <Money value={row.landed_cost_on_hand} minorUnit={minorUnit} />,
                },
                {
                  key: 'total',
                  header: 'Total value',
                  numeric: true,
                  render: (row) => <Money value={row.total_value} minorUnit={minorUnit} />,
                },
                {
                  key: 'provisional',
                  header: 'Provisional',
                  render: (row) => (row.has_provisional ? 'yes — estimated cost' : 'no'),
                },
              ]}
            />
          </div>

          <DataTable<Layer>
            caption="Cost layers still holding stock"
            rows={layers}
            rowKey={(row) => row.id}
            empty="No open layers."
            columns={[
              { key: 'sku', header: 'SKU', render: (row) => row.sku },
              { key: 'received', header: 'Received', render: (row) => day(row.received_date) },
              {
                key: 'original',
                header: 'Received qty',
                numeric: true,
                render: (row) => quantity(row.original_quantity),
              },
              {
                key: 'remaining',
                header: 'Remaining',
                numeric: true,
                render: (row) => quantity(row.remaining_quantity),
              },
              {
                key: 'unit_cost',
                header: 'Unit cost',
                numeric: true,
                render: (row) => precise(row.unit_cost),
              },
              {
                key: 'value',
                header: 'Value',
                numeric: true,
                render: (row) => (
                  <Money value={row.remaining_value} minorUnit={units(row.currency)} />
                ),
              },
              {
                key: 'status',
                header: 'Status',
                render: (row) =>
                  `${row.status.toLowerCase()}${row.is_provisional ? ' (provisional)' : ''}`,
              },
            ]}
          />

          {report.data.provisional_layers.length > 0 ? (
            <div className="card">
              <h2>Provisional layers awaiting settlement</h2>
              <p className="page-description">
                Doc 08 requires provisional costing to be deterministic and visible. These layers
                were created by issues that went negative; their cost is an estimate on both the
                subledger and the ledger until it settles.
              </p>
              <DataTable<ProvisionalLayer>
                caption="Provisional layers"
                rows={report.data.provisional_layers}
                rowKey={(row) => row.id}
                columns={[
                  { key: 'sku', header: 'SKU', render: (row) => row.sku },
                  { key: 'received', header: 'Received', render: (row) => day(row.received_date) },
                  {
                    key: 'remaining',
                    header: 'Remaining',
                    numeric: true,
                    render: (row) => quantity(row.remaining_quantity),
                  },
                  {
                    key: 'unit_cost',
                    header: 'Estimated unit cost',
                    numeric: true,
                    render: (row) => precise(row.unit_cost),
                  },
                  { key: 'status', header: 'Status', render: (row) => row.status.toLowerCase() },
                ]}
              />
            </div>
          ) : null}
        </>
      ) : null}

      {entityId ? (
        <DataTable<OnHandRow>
          caption="On hand, by quantity"
          rows={onHand.data?.data ?? []}
          rowKey={(row) => `${row.item_id}-${row.warehouse_id}`}
          empty="Nothing on hand."
          columns={[
            { key: 'sku', header: 'SKU', render: (row) => row.sku },
            { key: 'name', header: 'Item', render: (row) => row.name },
            { key: 'warehouse', header: 'Warehouse', render: (row) => row.warehouse_code },
            {
              key: 'quantity',
              header: 'Quantity',
              numeric: true,
              render: (row) => `${quantity(row.quantity)} ${row.base_uom}`,
            },
          ]}
        />
      ) : null}

      {entityId && can('inventory.adjust') ? (
        <form onSubmit={createLandedCost} className="card">
          <h2>Capitalise a landed cost</h2>
          <p className="page-description">
            Freight, duty and handling belong in the cost of the stock they brought in. The charge
            is allocated onto specific cost layers, which is why it is entered here, beside them.
          </p>
          <Field
            label="Charge type"
            name="charge_type"
            value={landed.charge_type}
            onChange={(v) => setLanded({ ...landed, charge_type: v })}
            required
            options={enumOptions(CHARGE_TYPES)}
          />
          <Field
            label="Allocation basis"
            name="allocation_basis"
            value={landed.allocation_basis}
            onChange={(v) => setLanded({ ...landed, allocation_basis: v })}
            required
            options={enumOptions(ALLOCATION_BASES)}
            hint="Value and quantity are derived from the layers. Weight, volume and manual need a figure per target below."
          />
          <Field
            label="Amount"
            name="landed_amount"
            value={landed.amount}
            onChange={(v) => setLanded({ ...landed, amount: v })}
            required
            placeholder="0.00"
            hint="The whole charge. It is split across the targets, with the rounding remainder placed deterministically by the server."
          />
          <Field
            label="Clearing account"
            name="clearing_account"
            value={landed.clearing_account_id}
            onChange={(v) => setLanded({ ...landed, clearing_account_id: v })}
            required
            options={(accounts.data?.data ?? []).map((a) => ({
              value: a.id,
              label: `${a.code} — ${a.name}`,
            }))}
            hint="Credited by this capitalisation, and cleared by the vendor bill for the charge."
          />
          <Field
            label="Posting date"
            name="landed_posting_date"
            type="date"
            value={landed.posting_date}
            onChange={(v) => setLanded({ ...landed, posting_date: v })}
            required
          />
          <Field
            label="Document number"
            name="landed_number"
            value={landed.document_number}
            onChange={(v) => setLanded({ ...landed, document_number: v })}
          />

          <h3>Layers to capitalise onto</h3>
          <Field
            label="Layer"
            name="add_layer"
            value={addLayerId}
            onChange={setAddLayerId}
            options={layers.map((l) => ({
              value: l.id,
              label: `${l.sku} — received ${day(l.received_date)} — ${quantity(l.remaining_quantity)} left`,
            }))}
            hint="Only layers still holding stock are listed; a fully consumed layer cannot absorb more cost."
          />
          <div className="button-row">
            <Button onClick={addTarget} disabled={!addLayerId}>
              Add target
            </Button>
          </div>

          <DataTable<Target>
            caption="Allocation targets"
            rows={targets}
            rowKey={(row) => row.cost_layer_id}
            empty="No targets yet — a landed cost with nothing to land on is refused."
            columns={[
              {
                key: 'layer',
                header: 'Layer',
                render: (row) => {
                  const layer = layers.find((l) => l.id === row.cost_layer_id);
                  return layer ? `${layer.sku} — ${day(layer.received_date)}` : row.cost_layer_id;
                },
              },
              {
                key: 'weight',
                header: 'Weight',
                numeric: true,
                render: (row) => (
                  <>
                    <label className="visually-hidden" htmlFor={`weight-${row.cost_layer_id}`}>
                      Weight for layer {row.cost_layer_id.slice(0, 8)}
                    </label>
                    <input
                      id={`weight-${row.cost_layer_id}`}
                      className="numeric"
                      inputMode="decimal"
                      value={row.weight}
                      onChange={(e) =>
                        setTargets(
                          targets.map((t) =>
                            t.cost_layer_id === row.cost_layer_id
                              ? { ...t, weight: e.target.value }
                              : t,
                          ),
                        )
                      }
                    />
                  </>
                ),
              },
              {
                key: 'volume',
                header: 'Volume',
                numeric: true,
                render: (row) => (
                  <>
                    <label className="visually-hidden" htmlFor={`volume-${row.cost_layer_id}`}>
                      Volume for layer {row.cost_layer_id.slice(0, 8)}
                    </label>
                    <input
                      id={`volume-${row.cost_layer_id}`}
                      className="numeric"
                      inputMode="decimal"
                      value={row.volume}
                      onChange={(e) =>
                        setTargets(
                          targets.map((t) =>
                            t.cost_layer_id === row.cost_layer_id
                              ? { ...t, volume: e.target.value }
                              : t,
                          ),
                        )
                      }
                    />
                  </>
                ),
              },
              {
                key: 'manual',
                header: 'Manual amount',
                numeric: true,
                render: (row) => (
                  <>
                    <label className="visually-hidden" htmlFor={`manual-${row.cost_layer_id}`}>
                      Manual amount for layer {row.cost_layer_id.slice(0, 8)}
                    </label>
                    <input
                      id={`manual-${row.cost_layer_id}`}
                      className="numeric"
                      inputMode="decimal"
                      value={row.manual_amount}
                      onChange={(e) =>
                        setTargets(
                          targets.map((t) =>
                            t.cost_layer_id === row.cost_layer_id
                              ? { ...t, manual_amount: e.target.value }
                              : t,
                          ),
                        )
                      }
                    />
                  </>
                ),
              },
              {
                key: 'remove',
                header: 'Remove',
                render: (row) => (
                  <Button
                    onClick={() =>
                      setTargets(targets.filter((t) => t.cost_layer_id !== row.cost_layer_id))
                    }
                  >
                    Remove
                    <span className="visually-hidden"> layer {row.cost_layer_id.slice(0, 8)}</span>
                  </Button>
                ),
              },
            ]}
          />

          <Button type="submit" variant="primary" busy={busy} disabled={targets.length === 0}>
            Capitalise
          </Button>
        </form>
      ) : null}
    </>
  );
}
