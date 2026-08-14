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
  precise,
  quantity,
  today,
  useMinorUnits,
} from '../../../components/phase5';

interface DocumentRow {
  id: string;
  legal_entity_id: string;
  accounting_book_id: string;
  document_type: string;
  document_number: string | null;
  document_date: string;
  posting_date: string;
  status: string;
  warehouse_id: string | null;
  source_type: string | null;
  source_id: string | null;
  accounting_entry_id: string | null;
  movement_count: string;
  created_at: string;
}

interface Movement {
  id: string;
  line_no: number;
  item_id: string;
  sku: string;
  from_location_id: string | null;
  to_location_id: string | null;
  movement_date: string;
  quantity: string;
  uom: string;
  unit_cost: string | null;
  total_cost: string | null;
  currency: string | null;
  cost_method: string | null;
}

interface Journal {
  id: string;
  entry_number: string;
  posting_date: string;
  description: string | null;
  status: string;
  source_type: string | null;
  source_id: string | null;
  reversal_of_id: string | null;
}

interface DocumentDetail extends DocumentRow {
  branch_id: string | null;
  purchase_order_id: string | null;
  sales_order_id: string | null;
  vendor_bill_id: string | null;
  invoice_id: string | null;
  movements: Movement[];
  journal: Journal | null;
}

interface Consumption {
  cost_layer_id: string;
  quantity: string;
  unit_cost: string;
  total_cost: string;
  received_date: string;
  source_movement_id: string | null;
  is_provisional: boolean;
  layer_unit_cost: string;
}

interface CostBreakdown {
  movement: { id: string; quantity: string; unit_cost: string | null; total_cost: string | null };
  consumptions: Consumption[];
  total_cost: string;
  /** null when the movement has no cost yet — a draft, or a transfer. */
  reproduces_movement_total: boolean | null;
}

interface Line {
  key: string;
  item_id: string;
  from_location_id: string;
  to_location_id: string;
  quantity: string;
  unit_cost: string;
}

const DOCUMENT_TYPES = [
  'RECEIPT',
  'ISSUE',
  'TRANSFER',
  'ADJUSTMENT',
  'COUNT',
  'CUSTOMER_RETURN',
  'VENDOR_RETURN',
  'WRITE_OFF',
  'LANDED_COST',
];

/** What the create form can build, and the route each one posts to. */
const CREATABLE: Record<string, { path: string; label: string; permission: string }> = {
  RECEIPT: { path: '/inventory/receipts', label: 'Receipt', permission: 'inventory.receive' },
  ISSUE: { path: '/inventory/issues', label: 'Issue', permission: 'inventory.issue' },
  TRANSFER: { path: '/inventory/transfers', label: 'Transfer', permission: 'inventory.transfer' },
  ADJUSTMENT: {
    path: '/inventory/adjustments',
    label: 'Adjustment',
    permission: 'inventory.adjust',
  },
  CUSTOMER_RETURN: {
    path: '/inventory/returns',
    label: 'Customer return',
    permission: 'inventory.receive',
  },
  VENDOR_RETURN: {
    path: '/inventory/returns',
    label: 'Vendor return',
    permission: 'inventory.receive',
  },
};

const newLine = (): Line => ({
  key: globalThis.crypto?.randomUUID?.() ?? `line-${Math.random().toString(36).slice(2)}`,
  item_id: '',
  from_location_id: '',
  to_location_id: '',
  quantity: '',
  unit_cost: '',
});

const needsFrom = (type: string) =>
  type === 'ISSUE' || type === 'TRANSFER' || type === 'VENDOR_RETURN';
// An adjustment names ONE location — the sign of the quantity says which way the
// stock goes — so it uses the destination column, relabelled. Two location
// selects for a single-location document would be a question with a wrong answer.
const needsTo = (type: string) =>
  type === 'RECEIPT' || type === 'TRANSFER' || type === 'ADJUSTMENT' || type === 'CUSTOMER_RETURN';
const toLocationHeader = (type: string) => (type === 'ADJUSTMENT' ? 'Location' : 'To location');
const takesUnitCost = (type: string) =>
  type === 'RECEIPT' ||
  type === 'ADJUSTMENT' ||
  type === 'CUSTOMER_RETURN' ||
  type === 'VENDOR_RETURN';

/**
 * Stock documents — doc 08, and the drill Gate D needs.
 *
 * Creation and posting are separate acts (F-902): a receipt is a physical fact
 * recorded when it happens, and the date it hits the ledger is a policy
 * decision. So a document is created DRAFT and posting is its own button, its
 * own permission and its own idempotency key.
 *
 * The reason this screen exists in the shape it does is the second half. A
 * posted document shows the journal it produced, and every movement can show the
 * cost layers it consumed — which layer, how much came out of it, at what unit
 * cost, and whether those rows still add up to the cost the movement posted
 * (`reproduces_movement_total`). That is Phase 5's third exit criterion made
 * visible: COGS is reproducible from stored layers rather than asserted. It is
 * also what turns "the valuation is 40.00 out" into "this issue consumed this
 * layer", which is the only form in which a difference can actually be fixed.
 *
 * A posted movement is never edited. The correction is a reversal (F-908), which
 * posts a mirror document and leaves both on the record.
 */
export default function InventoryDocumentsPage() {
  const held = useHeldPermissions();
  const can = (permission: string) => !held || held.has(permission);
  const keys = useIdempotencyKeys();
  const units = useMinorUnits();

  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [status, setStatus] = useState('');

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

  const items = useResource(
    () =>
      api<{ data: { id: string; sku: string; name: string; base_uom: string }[] }>('/items', {
        query: { legal_entity_id: entityId, kind: 'INVENTORY', status: 'ACTIVE' },
      }),
    [entityId],
  );

  /**
   * Every location of the entity, keyed by id.
   *
   * A transfer's two ends can be in different warehouses, so a document's
   * locations cannot be resolved from its own warehouse alone — and a movement
   * row showing a raw uuid where a bin code belongs is a drill-down that stops
   * one step short of useful.
   */
  const locations = useResource(async () => {
    const list = warehouses.data?.data ?? [];
    const perWarehouse = await Promise.all(
      list.map(async (warehouse) => {
        const result = await api<{
          data: { id: string; code: string; name: string; kind: string }[];
        }>(`/warehouses/${warehouse.id}/locations`);
        return result.data.map((location) => ({ ...location, warehouse_code: warehouse.code }));
      }),
    );
    return perWarehouse.flat();
  }, [warehouses.data?.data?.length, entityId]);

  const locationLabel = (id: string | null): string => {
    if (!id) return '—';
    const location = (locations.data ?? []).find((l) => l.id === id);
    return location ? `${location.warehouse_code}/${location.code}` : id.slice(0, 8);
  };

  const documents = useResource(
    () =>
      api<{ data: DocumentRow[] }>('/inventory/documents', {
        query: {
          legal_entity_id: entityId,
          document_type: documentType,
          status,
          warehouse_id: warehouseId,
        },
      }),
    [entityId, documentType, status, warehouseId],
  );

  const [openId, setOpenId] = useState<string | null>(null);
  const document = useResource(
    () => (openId ? api<DocumentDetail>(`/inventory/documents/${openId}`) : Promise.resolve(null)),
    [openId],
  );

  const [breakdownFor, setBreakdownFor] = useState<string | null>(null);
  const breakdown = useResource(
    () =>
      breakdownFor
        ? api<CostBreakdown>(`/inventory/movements/${breakdownFor}/cost-breakdown`)
        : Promise.resolve(null),
    [breakdownFor],
  );

  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- the create form ------------------------------------------------------
  const [createType, setCreateType] = useState('RECEIPT');
  const [header, setHeader] = useState({
    accounting_book_id: '',
    document_date: today(),
    posting_date: today(),
    document_number: '',
    to_warehouse_id: '',
    reason: '',
  });
  const [lines, setLines] = useState<Line[]>([newLine()]);
  const bookId = header.accounting_book_id || (books.data?.data[0]?.id ?? '');

  /** Locations in one warehouse, or all of them when no warehouse is chosen. */
  const locationsIn = (id: string) => {
    const code = (warehouses.data?.data ?? []).find((w) => w.id === id)?.code;
    return (locations.data ?? []).filter((l) => !code || l.warehouse_code === code);
  };
  const sourceLocations = locationsIn(warehouseId);
  const destinationLocations = locationsIn(header.to_warehouse_id || warehouseId);

  const locationOptions = (
    rows: { id: string; code: string; name: string; warehouse_code: string }[],
  ) => rows.map((l) => ({ value: l.id, label: `${l.warehouse_code}/${l.code} — ${l.name}` }));

  const updateLine = (index: number, patch: Partial<Line>) =>
    setLines(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    const target = CREATABLE[createType];
    if (!target) return;
    setBusy(true);
    setError(null);
    setNotice(null);

    const base = {
      accounting_book_id: bookId,
      document_date: header.document_date,
      posting_date: header.posting_date,
      document_number: header.document_number || null,
    };
    // Quantities and unit costs travel exactly as typed. A number input would
    // hand back a float and lose the last digit of an eight-decimal cost.
    const body =
      createType === 'RECEIPT'
        ? {
            ...base,
            warehouse_id: warehouseId,
            lines: lines.map((l) => ({
              item_id: l.item_id,
              to_location_id: l.to_location_id,
              quantity: l.quantity,
              ...(l.unit_cost ? { unit_cost: l.unit_cost } : {}),
            })),
          }
        : createType === 'ISSUE'
          ? {
              ...base,
              warehouse_id: warehouseId || null,
              lines: lines.map((l) => ({
                item_id: l.item_id,
                from_location_id: l.from_location_id,
                quantity: l.quantity,
              })),
            }
          : createType === 'TRANSFER'
            ? {
                ...base,
                lines: lines.map((l) => ({
                  item_id: l.item_id,
                  from_location_id: l.from_location_id,
                  to_location_id: l.to_location_id,
                  quantity: l.quantity,
                })),
              }
            : createType === 'ADJUSTMENT'
              ? {
                  ...base,
                  warehouse_id: warehouseId || null,
                  reason: header.reason || undefined,
                  lines: lines.map((l) => ({
                    item_id: l.item_id,
                    location_id: l.to_location_id,
                    quantity: l.quantity,
                    ...(l.unit_cost ? { unit_cost: l.unit_cost } : {}),
                  })),
                }
              : {
                  ...base,
                  kind: createType,
                  lines: lines.map((l) => ({
                    item_id: l.item_id,
                    ...(l.to_location_id ? { to_location_id: l.to_location_id } : {}),
                    ...(l.from_location_id ? { from_location_id: l.from_location_id } : {}),
                    quantity: l.quantity,
                    ...(l.unit_cost ? { unit_cost: l.unit_cost } : {}),
                  })),
                };

    try {
      const created = await api<{ id: string; document_type: string }>(target.path, {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor(`inventory-${createType}`, body),
      });
      keys.settle(`inventory-${createType}`);
      setLines([newLine()]);
      setOpenId(created.id);
      setNotice(
        'Created as a draft. Nothing has moved and nothing has posted until you post it — ' +
          'the accounting date is the posting date on the document, not today.',
      );
      documents.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const post = async (id: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/inventory/documents/${id}/post`, {
        method: 'POST',
        idempotencyKey: keys.keyFor(`post-${id}`, { id }),
      });
      keys.settle(`post-${id}`);
      setNotice(
        'Posted. Stock has moved and the journal, if this type posts one, is linked below.',
      );
      documents.reload();
      document.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const [reversal, setReversal] = useState({ posting_date: '', reason: '' });
  const reverse = async (id: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      ...(reversal.posting_date ? { posting_date: reversal.posting_date } : {}),
      ...(reversal.reason ? { reason: reversal.reason } : {}),
    };
    try {
      const created = await api<{ id: string }>(`/inventory/documents/${id}/reverse`, {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor(`reverse-${id}`, body),
      });
      keys.settle(`reverse-${id}`);
      setReversal({ posting_date: '', reason: '' });
      setNotice(
        'Reversed. The original stays posted — a correction is a mirror document, never an edit ' +
          '(doc 08). The reversal is now open below.',
      );
      setOpenId(created.id);
      documents.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const detail = document.data;
  const currency = detail?.movements.find((m) => m.currency)?.currency ?? null;

  return (
    <>
      <PageHeader
        title="Stock documents"
        description="Receipts, issues, transfers, adjustments and returns. Created as drafts; posting is a separate act, and a posted document is corrected by reversal."
      />
      <ErrorBanner error={error ?? documents.error ?? document.error ?? breakdown.error} />
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
          label="Warehouse"
          name="warehouse"
          value={warehouseId}
          onChange={setWarehouseId}
          options={(warehouses.data?.data ?? []).map((w) => ({
            value: w.id,
            label: `${w.code} — ${w.name}`,
          }))}
        />
        <Field
          label="Type"
          name="document_type"
          value={documentType}
          onChange={setDocumentType}
          options={enumOptions(DOCUMENT_TYPES)}
        />
        <Field
          label="Status"
          name="status"
          value={status}
          onChange={setStatus}
          options={enumOptions(['DRAFT', 'POSTED', 'CLOSED', 'CANCELLED'])}
        />
      </div>

      <DataTable<DocumentRow>
        caption="Stock documents"
        rows={documents.data?.data ?? []}
        rowKey={(row) => row.id}
        empty="No documents match these filters."
        columns={[
          { key: 'posting_date', header: 'Posting date', render: (row) => day(row.posting_date) },
          {
            key: 'type',
            header: 'Type',
            render: (row) => row.document_type.replace(/_/g, ' ').toLowerCase(),
          },
          { key: 'number', header: 'Number', render: (row) => row.document_number ?? '—' },
          {
            key: 'source',
            header: 'Source',
            render: (row) =>
              row.source_type ? row.source_type.replace(/_/g, ' ') : 'entered here',
          },
          { key: 'movements', header: 'Lines', numeric: true, render: (row) => row.movement_count },
          {
            key: 'journal',
            header: 'Journal',
            render: (row) => (row.accounting_entry_id ? 'posted' : 'none'),
          },
          { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
          {
            key: 'open',
            header: 'Detail',
            render: (row) => (
              <Button
                onClick={() => {
                  setOpenId(row.id);
                  setBreakdownFor(null);
                }}
              >
                Open
                <span className="visually-hidden"> document {row.document_number ?? row.id}</span>
              </Button>
            ),
          },
        ]}
      />

      {detail ? (
        <div className="card">
          <h2>
            {detail.document_type.replace(/_/g, ' ').toLowerCase()}{' '}
            {detail.document_number ?? detail.id.slice(0, 8)} <Status value={detail.status} />
          </h2>
          <SummaryList
            items={[
              { term: 'Document date', value: day(detail.document_date) },
              {
                term: 'Posting date',
                value: day(detail.posting_date),
                hint: 'The date the ledger sees, which is not always the day it happened.',
              },
              { term: 'Movements', value: detail.movements.length },
              {
                term: 'Journal',
                value: detail.journal ? detail.journal.entry_number : 'none',
                hint: detail.journal
                  ? detail.journal.status.toLowerCase()
                  : detail.status === 'POSTED'
                    ? 'This type posts no journal: a same-entity transfer moves stock between two locations behind one control account (doc 08).'
                    : 'Nothing posts until the document does.',
              },
              {
                term: 'Source',
                value: detail.source_type ?? 'entered here',
                hint:
                  detail.source_type === 'goods_receipt'
                    ? 'The accrual was posted by the goods receipt in Phase 3; this document adds the stock consequence and links to that entry rather than posting a second one.'
                    : undefined,
              },
            ]}
          />

          <DataTable<Movement>
            caption="Movements"
            rows={detail.movements}
            rowKey={(row) => row.id}
            empty="This document has no movements — posting it would record that nothing happened."
            columns={[
              { key: 'line', header: '#', numeric: true, render: (row) => row.line_no },
              { key: 'sku', header: 'Item', render: (row) => row.sku },
              { key: 'from', header: 'From', render: (row) => locationLabel(row.from_location_id) },
              { key: 'to', header: 'To', render: (row) => locationLabel(row.to_location_id) },
              {
                key: 'quantity',
                header: 'Quantity',
                numeric: true,
                render: (row) => `${quantity(row.quantity)} ${row.uom}`,
              },
              {
                key: 'unit_cost',
                header: 'Unit cost',
                numeric: true,
                render: (row) => precise(row.unit_cost),
              },
              {
                key: 'total_cost',
                header: 'Total cost',
                numeric: true,
                render: (row) => <Money value={row.total_cost} minorUnit={units(row.currency)} />,
              },
              {
                key: 'method',
                header: 'Costed by',
                render: (row) => row.cost_method?.replace(/_/g, ' ').toLowerCase() ?? 'not yet',
              },
              {
                key: 'layers',
                header: 'Cost layers',
                render: (row) =>
                  row.cost_method ? (
                    <Button onClick={() => setBreakdownFor(row.id)}>
                      Show
                      <span className="visually-hidden"> cost layers for line {row.line_no}</span>
                    </Button>
                  ) : (
                    <span className="field-hint">costed at posting</span>
                  ),
              },
            ]}
          />

          {breakdown.data ? (
            <div className="card">
              <h3>Cost layers consumed</h3>
              <p className="page-description">
                Each row is a stored consumption: the layer it came from, what it was received at,
                and what came out of it. The sum below is recomputed from these rows rather than
                copied from the movement, so the two either agree or the disagreement is visible.
              </p>
              <DataTable<Consumption>
                caption="Layers consumed by this movement"
                rows={breakdown.data.consumptions}
                rowKey={(row) => `${row.cost_layer_id}-${row.quantity}`}
                empty="No layer consumptions: this movement created cost rather than consuming it (a receipt), or moved stock without revaluing it (a transfer)."
                columns={[
                  {
                    key: 'received',
                    header: 'Layer received',
                    render: (row) => day(row.received_date),
                  },
                  {
                    key: 'layer',
                    header: 'Layer',
                    render: (row) =>
                      `${row.cost_layer_id.slice(0, 8)}${row.is_provisional ? ' (provisional)' : ''}`,
                  },
                  {
                    key: 'quantity',
                    header: 'Taken',
                    numeric: true,
                    render: (row) => quantity(row.quantity),
                  },
                  {
                    key: 'layer_unit_cost',
                    header: 'Layer unit cost',
                    numeric: true,
                    render: (row) => precise(row.layer_unit_cost),
                  },
                  {
                    key: 'unit_cost',
                    header: 'Consumed at',
                    numeric: true,
                    render: (row) => precise(row.unit_cost),
                  },
                  {
                    key: 'total',
                    header: 'Cost',
                    numeric: true,
                    render: (row) => <Money value={row.total_cost} minorUnit={units(currency)} />,
                  },
                ]}
              />
              <SummaryList
                items={[
                  {
                    term: 'Sum of consumptions',
                    value: <Money value={breakdown.data.total_cost} minorUnit={units(currency)} />,
                    hint: 'Recomputed from the rows above.',
                  },
                  {
                    term: 'Movement posted',
                    value: (
                      <Money
                        value={breakdown.data.movement.total_cost}
                        minorUnit={units(currency)}
                      />
                    ),
                  },
                  {
                    term: 'Reproducible',
                    value:
                      breakdown.data.reproduces_movement_total === null
                        ? 'no cost posted yet'
                        : breakdown.data.reproduces_movement_total
                          ? 'yes — the layers add up to what was posted'
                          : 'no — the stored layers no longer explain the posted cost',
                    hint: 'Phase 5 exit criterion 3.',
                  },
                ]}
              />
              {breakdown.data.reproduces_movement_total === false ? (
                <Notice tone="warning">
                  The consumptions do not sum to the cost this movement posted. That is a finding,
                  not a rounding preference — quote the movement id when reporting it.
                </Notice>
              ) : null}
              <Button onClick={() => setBreakdownFor(null)}>Close cost layers</Button>
            </div>
          ) : null}

          {detail.journal ? (
            <div className="card">
              <h3>Journal produced</h3>
              <SummaryList
                items={[
                  { term: 'Entry', value: detail.journal.entry_number },
                  { term: 'Posted', value: day(detail.journal.posting_date) },
                  { term: 'Status', value: <Status value={detail.journal.status} /> },
                  {
                    term: 'Description',
                    value: detail.journal.description ?? '—',
                    hint: detail.journal.reversal_of_id
                      ? 'This entry reverses an earlier one.'
                      : undefined,
                  },
                ]}
              />
              <p className="field-hint">
                Open it on the journals screen to see its lines — this screen deliberately does not
                re-render the ledger, so there is only one place a journal is authoritative.
              </p>
            </div>
          ) : null}

          <div className="button-row">
            {detail.status === 'DRAFT' || detail.status === 'APPROVED' ? (
              can('inventory.post') ? (
                <Button variant="primary" busy={busy} onClick={() => post(detail.id)}>
                  Post document
                </Button>
              ) : (
                <span className="field-hint">needs inventory.post</span>
              )
            ) : null}
            <Button
              onClick={() => {
                setOpenId(null);
                setBreakdownFor(null);
              }}
            >
              Close
            </Button>
          </div>

          {detail.status === 'POSTED' && can('inventory.reverse') ? (
            <div className="card">
              <h3>Correct by reversal</h3>
              <p className="field-hint">
                A posted movement is immutable, so a correction is a mirror document rather than an
                edit (doc 08). Reversing twice returns the first reversal instead of posting a
                second.
              </p>
              <Field
                label="Posting date"
                name="reversal_date"
                type="date"
                value={reversal.posting_date}
                onChange={(v) => setReversal({ ...reversal, posting_date: v })}
                hint="Leave empty to reverse into the original period, or into today if that period has closed."
              />
              <Field
                label="Reason"
                name="reversal_reason"
                value={reversal.reason}
                onChange={(v) => setReversal({ ...reversal, reason: v })}
              />
              <Button variant="danger" busy={busy} onClick={() => reverse(detail.id)}>
                Reverse document
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Gated on holding ANY create permission, not on the selected type's:
          hiding the whole form because the default type is out of reach would
          hide the type selector too, and with it the types the user can use. */}
      {Object.values(CREATABLE).some((meta) => can(meta.permission)) ? (
        <form onSubmit={create} className="card">
          <h2>New stock document</h2>
          <Field
            label="Type"
            name="create_type"
            value={createType}
            onChange={(value) => {
              setCreateType(value);
              setLines([newLine()]);
            }}
            required
            options={Object.entries(CREATABLE).map(([value, meta]) => ({
              value,
              label: meta.label,
            }))}
            hint="A count is not created here — it is scoped, counted and approved on the stock counts screen."
          />
          <Field
            label="Accounting book"
            name="book"
            value={bookId}
            onChange={(v) => setHeader({ ...header, accounting_book_id: v })}
            required
            options={(books.data?.data ?? []).map((b) => ({
              value: b.id,
              label: `${b.code} (${b.base_currency})`,
            }))}
          />
          <Field
            label="Document date"
            name="document_date"
            type="date"
            value={header.document_date}
            onChange={(v) => setHeader({ ...header, document_date: v })}
            required
            hint="When it physically happened."
          />
          <Field
            label="Posting date"
            name="posting_date"
            type="date"
            value={header.posting_date}
            onChange={(v) => setHeader({ ...header, posting_date: v })}
            required
            hint="When the ledger recognises it. Must fall in an open period."
          />
          <Field
            label="Document number"
            name="document_number"
            value={header.document_number}
            onChange={(v) => setHeader({ ...header, document_number: v })}
            hint="Optional; a sequence assigns one if you leave it empty."
          />
          {createType === 'ADJUSTMENT' ? (
            <Field
              label="Reason"
              name="adjustment_reason"
              value={header.reason}
              onChange={(v) => setHeader({ ...header, reason: v })}
              hint="Why stock is being written up or down. Stored on the document."
            />
          ) : null}
          {createType === 'TRANSFER' ? (
            <Field
              label="Destination warehouse"
              name="to_warehouse"
              value={header.to_warehouse_id}
              onChange={(v) => setHeader({ ...header, to_warehouse_id: v })}
              options={(warehouses.data?.data ?? []).map((w) => ({
                value: w.id,
                label: `${w.code} — ${w.name}`,
              }))}
              hint="Only narrows the destination list; a transfer may stay inside one warehouse."
            />
          ) : null}

          <div className="grid-wrapper">
            <table className="journal-grid document-grid">
              <caption>Lines</caption>
              <thead>
                <tr>
                  <th scope="col" className="grid-line-no">
                    #
                  </th>
                  <th scope="col">Item</th>
                  {needsFrom(createType) ? <th scope="col">From location</th> : null}
                  {needsTo(createType) ? <th scope="col">{toLocationHeader(createType)}</th> : null}
                  <th scope="col" className="numeric">
                    Quantity
                  </th>
                  {takesUnitCost(createType) ? (
                    <th scope="col" className="numeric">
                      Unit cost
                    </th>
                  ) : null}
                  <th scope="col">
                    <span className="visually-hidden">Row actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => (
                  <tr key={line.key}>
                    <td className="grid-line-no">{index + 1}</td>
                    <td>
                      <label className="visually-hidden" htmlFor={`item-${line.key}`}>
                        Item for line {index + 1}
                      </label>
                      <select
                        id={`item-${line.key}`}
                        value={line.item_id}
                        onChange={(e) => updateLine(index, { item_id: e.target.value })}
                      >
                        <option value="">Select an item…</option>
                        {(items.data?.data ?? []).map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.sku} — {item.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    {needsFrom(createType) ? (
                      <td>
                        <label className="visually-hidden" htmlFor={`from-${line.key}`}>
                          Source location for line {index + 1}
                        </label>
                        <select
                          id={`from-${line.key}`}
                          value={line.from_location_id}
                          onChange={(e) => updateLine(index, { from_location_id: e.target.value })}
                        >
                          <option value="">Select a location…</option>
                          {locationOptions(sourceLocations).map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    ) : null}
                    {needsTo(createType) ? (
                      <td>
                        <label className="visually-hidden" htmlFor={`to-${line.key}`}>
                          {toLocationHeader(createType)} for line {index + 1}
                        </label>
                        <select
                          id={`to-${line.key}`}
                          value={line.to_location_id}
                          onChange={(e) => updateLine(index, { to_location_id: e.target.value })}
                        >
                          <option value="">Select a location…</option>
                          {locationOptions(destinationLocations).map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    ) : null}
                    <td className="numeric">
                      <label className="visually-hidden" htmlFor={`quantity-${line.key}`}>
                        Quantity for line {index + 1}
                      </label>
                      <input
                        id={`quantity-${line.key}`}
                        className="numeric"
                        inputMode="decimal"
                        value={line.quantity}
                        onChange={(e) => updateLine(index, { quantity: e.target.value })}
                      />
                    </td>
                    {takesUnitCost(createType) ? (
                      <td className="numeric">
                        <label className="visually-hidden" htmlFor={`unit-cost-${line.key}`}>
                          Unit cost for line {index + 1}
                        </label>
                        <input
                          id={`unit-cost-${line.key}`}
                          className="numeric"
                          inputMode="decimal"
                          value={line.unit_cost}
                          onChange={(e) => updateLine(index, { unit_cost: e.target.value })}
                        />
                      </td>
                    ) : null}
                    <td>
                      <button
                        type="button"
                        className="button button-secondary"
                        onClick={() =>
                          setLines(
                            lines.length <= 1 ? [newLine()] : lines.filter((_, i) => i !== index),
                          )
                        }
                      >
                        Remove
                        <span className="visually-hidden"> line {index + 1}</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="button-row">
            <Button onClick={() => setLines([...lines, newLine()])}>Add line</Button>
          </div>

          {createType === 'ADJUSTMENT' ? (
            <p className="field-hint">
              An adjustment quantity is signed: positive writes stock up into the location, negative
              writes it down. A write-down is valued by consuming layers; a write-up at the current
              average unless you give a unit cost.
            </p>
          ) : null}
          {createType === 'ISSUE' ? (
            <p className="field-hint">
              An issue carries no unit cost on purpose. It is valued by consuming cost layers at
              posting time, and a caller-priced issue is one the valuation engine cannot reproduce.
            </p>
          ) : null}

          {can(CREATABLE[createType]?.permission ?? 'inventory.receive') ? (
            <Button
              type="submit"
              variant="primary"
              busy={busy}
              disabled={!bookId || (createType === 'RECEIPT' && !warehouseId)}
            >
              Create draft
            </Button>
          ) : (
            <p className="field-hint">
              needs {CREATABLE[createType]?.permission} — choose a type you hold the permission for.
            </p>
          )}
        </form>
      ) : null}
    </>
  );
}
