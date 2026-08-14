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
import { enumOptions, quantity } from '../../../components/phase5';

interface Item {
  id: string;
  organization_id: string;
  sku: string;
  name: string;
  barcode: string | null;
  kind: string;
  base_uom: string;
  valuation: string;
  lot_tracking: boolean;
  serial_tracking: boolean;
  expiry_tracking: boolean;
  reorder_level: string | null;
  negative_stock_policy: string;
  status: string;
  /** From `item_accounting_settings` for the chosen entity — null when unmapped. */
  inventory_account_id: string | null;
  cogs_account_id: string | null;
  revenue_account_id: string | null;
  purchase_account_id: string | null;
  variance_account_id: string | null;
  valuation_override: string | null;
  entity_negative_stock_policy: string | null;
}

interface AccountOption {
  id: string;
  code: string;
  name: string;
}

const KINDS = ['INVENTORY', 'SERVICE', 'NON_STOCK', 'ASSET_PURCHASE', 'BUNDLE'];
const VALUATIONS = ['FIFO', 'WEIGHTED_AVERAGE', 'STANDARD', 'SPECIFIC'];
const NEGATIVE_POLICIES = ['BLOCK', 'ALLOW_PROVISIONAL'];
const YES_NO = [
  { value: 'false', label: 'no' },
  { value: 'true', label: 'yes' },
];

const emptyForm = {
  sku: '',
  name: '',
  kind: 'INVENTORY',
  base_uom: 'EA',
  valuation: 'FIFO',
  barcode: '',
  sales_description: '',
  purchase_description: '',
  lot_tracking: 'false',
  serial_tracking: 'false',
  expiry_tracking: 'false',
  reorder_level: '',
  negative_stock_policy: 'BLOCK',
  inventory_account_id: '',
  cogs_account_id: '',
  revenue_account_id: '',
  purchase_account_id: '',
  variance_account_id: '',
  status: 'ACTIVE',
};

/**
 * The item master — doc 08.
 *
 * Two things this screen is careful about, both because the accounting depends
 * on them rather than on the item's name:
 *
 *   - The account mappings are PER LEGAL ENTITY (F-033's grain). One SKU sold by
 *     two entities posts COGS to two different accounts, so the mapping columns
 *     are only meaningful once an entity is chosen, and the screen says so
 *     instead of showing blanks that look like missing data.
 *   - The valuation method is set once and never edited (F-906). Changing FIFO
 *     to weighted average after layers have been consumed would reinterpret
 *     costs already posted to the ledger, so the edit form omits it and explains
 *     the omission — a control a user cannot see is one they will keep trying.
 */
export default function ItemsPage() {
  const held = useHeldPermissions();
  const can = (permission: string) => !held || held.has(permission);
  const keys = useIdempotencyKeys();

  const organizations = useResource(() =>
    api<{ data: { id: string; name: string }[] }>('/organizations'),
  );
  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );

  const [organizationId, setOrganizationId] = useState('');
  const [entityId, setEntityId] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');

  const accounts = useResource(
    () =>
      entityId
        ? api<{ data: AccountOption[] }>('/accounts', {
            query: { legal_entity_id: entityId, posting_only: 'true' },
          })
        : Promise.resolve({ data: [] as AccountOption[] }),
    [entityId],
  );
  const accountLabel = (id: string | null): string => {
    if (!id) return 'not mapped';
    const account = (accounts.data?.data ?? []).find((a) => a.id === id);
    return account ? `${account.code} — ${account.name}` : id.slice(0, 8);
  };
  const accountOptions = (accounts.data?.data ?? []).map((a) => ({
    value: a.id,
    label: `${a.code} — ${a.name}`,
  }));

  const items = useResource(
    () =>
      api<{ data: Item[] }>('/items', {
        query: {
          organization_id: organizationId,
          legal_entity_id: entityId,
          kind,
          status,
        },
      }),
    [organizationId, entityId, kind, status],
  );

  const [form, setForm] = useState(emptyForm);
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value });
  const [editing, setEditing] = useState<Item | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Only sent when an entity is chosen and at least one account is picked. */
  const accountingPayload = () => {
    if (!entityId) return undefined;
    const mapping = {
      legal_entity_id: entityId,
      inventory_account_id: form.inventory_account_id || null,
      cogs_account_id: form.cogs_account_id || null,
      revenue_account_id: form.revenue_account_id || null,
      purchase_account_id: form.purchase_account_id || null,
      variance_account_id: form.variance_account_id || null,
    };
    const anyAccount = [
      mapping.inventory_account_id,
      mapping.cogs_account_id,
      mapping.revenue_account_id,
      mapping.purchase_account_id,
      mapping.variance_account_id,
    ].some(Boolean);
    return anyAccount ? [mapping] : undefined;
  };

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      organization_id: organizationId,
      sku: form.sku,
      name: form.name,
      kind: form.kind,
      base_uom: form.base_uom,
      valuation: form.valuation,
      barcode: form.barcode || null,
      sales_description: form.sales_description || null,
      purchase_description: form.purchase_description || null,
      lot_tracking: form.lot_tracking === 'true',
      serial_tracking: form.serial_tracking === 'true',
      expiry_tracking: form.expiry_tracking === 'true',
      reorder_level: form.reorder_level || null,
      negative_stock_policy: form.negative_stock_policy,
      accounting: accountingPayload(),
    };
    try {
      await api('/items', { method: 'POST', body, idempotencyKey: keys.keyFor('item', body) });
      keys.settle('item');
      setNotice(`${form.sku} created. Its valuation method is fixed from now on.`);
      setForm(emptyForm);
      items.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (item: Item) => {
    setEditing(item);
    setNotice(null);
    setForm({
      ...emptyForm,
      sku: item.sku,
      name: item.name,
      kind: item.kind,
      base_uom: item.base_uom,
      valuation: item.valuation,
      barcode: item.barcode ?? '',
      reorder_level: item.reorder_level ?? '',
      negative_stock_policy: item.entity_negative_stock_policy ?? item.negative_stock_policy,
      inventory_account_id: item.inventory_account_id ?? '',
      cogs_account_id: item.cogs_account_id ?? '',
      revenue_account_id: item.revenue_account_id ?? '',
      purchase_account_id: item.purchase_account_id ?? '',
      variance_account_id: item.variance_account_id ?? '',
      status: item.status,
    });
  };

  const update = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    // No `valuation` key: the contract refuses it (F-906) and the omission is
    // the point — see the note beside the form.
    const body = {
      name: form.name,
      barcode: form.barcode || null,
      sales_description: form.sales_description || null,
      purchase_description: form.purchase_description || null,
      reorder_level: form.reorder_level || null,
      negative_stock_policy: form.negative_stock_policy,
      status: form.status,
      accounting: accountingPayload(),
    };
    try {
      await api(`/items/${editing.id}`, { method: 'PATCH', body });
      setNotice(`${editing.sku} updated.`);
      setEditing(null);
      setForm(emptyForm);
      items.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const trackingWords = (item: Item): string => {
    const on = [
      item.lot_tracking ? 'lot' : null,
      item.serial_tracking ? 'serial' : null,
      item.expiry_tracking ? 'expiry' : null,
    ].filter(Boolean);
    return on.length ? on.join(', ') : 'none';
  };

  return (
    <>
      <PageHeader
        title="Items"
        description="The item master. Account mappings are per legal entity, and the valuation method is fixed once stock has been costed under it."
      />
      <ErrorBanner error={error ?? items.error} />
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <div className="card">
        <Field
          label="Organization"
          name="organization"
          value={organizationId}
          onChange={setOrganizationId}
          options={(organizations.data?.data ?? []).map((o) => ({ value: o.id, label: o.name }))}
          hint="Items belong to an organization; their accounting belongs to a legal entity."
        />
        <Field
          label="Legal entity"
          name="entity"
          value={entityId}
          onChange={setEntityId}
          options={(entities.data?.data ?? []).map((e) => ({
            value: e.id,
            label: `${e.code} — ${e.legal_name}`,
          }))}
          hint="Chooses which entity's account mappings are shown and edited."
        />
        <Field
          label="Kind"
          name="kind"
          value={kind}
          onChange={setKind}
          options={enumOptions(KINDS)}
        />
        <Field
          label="Status"
          name="status"
          value={status}
          onChange={setStatus}
          options={enumOptions(['ACTIVE', 'INACTIVE', 'ARCHIVED'])}
        />
      </div>

      {!entityId ? (
        <Notice tone="info">
          No legal entity chosen, so the inventory and COGS columns are blank for every row — that
          is this screen having nothing to say, not the items being unmapped.
        </Notice>
      ) : null}

      <DataTable<Item>
        caption="Items"
        rows={items.data?.data ?? []}
        rowKey={(row) => row.id}
        empty="No items match these filters."
        columns={[
          { key: 'sku', header: 'SKU', render: (row) => row.sku },
          { key: 'name', header: 'Name', render: (row) => row.name },
          {
            key: 'kind',
            header: 'Kind',
            render: (row) => row.kind.replace(/_/g, ' ').toLowerCase(),
          },
          { key: 'uom', header: 'UoM', render: (row) => row.base_uom },
          {
            key: 'valuation',
            header: 'Valuation',
            render: (row) =>
              row.valuation_override && row.valuation_override !== row.valuation
                ? `${row.valuation_override.toLowerCase()} (entity override of ${row.valuation.toLowerCase()})`
                : row.valuation.toLowerCase(),
          },
          { key: 'tracking', header: 'Tracking', render: (row) => trackingWords(row) },
          {
            key: 'reorder',
            header: 'Reorder level',
            numeric: true,
            render: (row) => quantity(row.reorder_level),
          },
          {
            key: 'negative',
            header: 'Negative stock',
            render: (row) =>
              (row.entity_negative_stock_policy ?? row.negative_stock_policy)
                .replace(/_/g, ' ')
                .toLowerCase(),
          },
          {
            key: 'inventory_account',
            header: 'Inventory account',
            render: (row) => (entityId ? accountLabel(row.inventory_account_id) : '—'),
          },
          {
            key: 'cogs_account',
            header: 'COGS account',
            render: (row) => (entityId ? accountLabel(row.cogs_account_id) : '—'),
          },
          { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
          {
            key: 'edit',
            header: 'Edit',
            render: (row) =>
              can('item.manage') ? (
                <Button onClick={() => startEdit(row)}>Edit</Button>
              ) : (
                <span className="field-hint">needs item.manage</span>
              ),
          },
        ]}
      />

      {editing ? (
        <form onSubmit={update} className="card">
          <h2>
            Edit {editing.sku} — {editing.name}
          </h2>
          <Notice tone="info">
            The valuation method stays {editing.valuation.replace(/_/g, ' ').toLowerCase()}.
            Changing it here would reinterpret cost layers this item has already consumed, so the
            contract does not accept it (F-906); a different method means a different item.
          </Notice>
          <Field label="Name" name="edit_name" value={form.name} onChange={set('name')} required />
          <Field
            label="Barcode"
            name="edit_barcode"
            value={form.barcode}
            onChange={set('barcode')}
          />
          <Field
            label="Sales description"
            name="edit_sales_description"
            value={form.sales_description}
            onChange={set('sales_description')}
          />
          <Field
            label="Purchase description"
            name="edit_purchase_description"
            value={form.purchase_description}
            onChange={set('purchase_description')}
          />
          <Field
            label="Reorder level"
            name="edit_reorder_level"
            value={form.reorder_level}
            onChange={set('reorder_level')}
            placeholder="0"
          />
          <Field
            label="Negative stock policy"
            name="edit_negative_stock_policy"
            value={form.negative_stock_policy}
            onChange={set('negative_stock_policy')}
            options={enumOptions(NEGATIVE_POLICIES)}
            hint="Allow provisional lets an issue go negative at an estimated cost that must later settle (doc 08)."
          />
          <Field
            label="Status"
            name="edit_status"
            value={form.status}
            onChange={set('status')}
            options={enumOptions(['ACTIVE', 'INACTIVE', 'ARCHIVED'])}
          />
          {entityId ? (
            <>
              <h3>Accounting for the chosen entity</h3>
              <Field
                label="Inventory account"
                name="edit_inventory_account"
                value={form.inventory_account_id}
                onChange={set('inventory_account_id')}
                options={accountOptions}
                hint="The control account the valuation report is reconciled against."
              />
              <Field
                label="COGS account"
                name="edit_cogs_account"
                value={form.cogs_account_id}
                onChange={set('cogs_account_id')}
                options={accountOptions}
              />
              <Field
                label="Revenue account"
                name="edit_revenue_account"
                value={form.revenue_account_id}
                onChange={set('revenue_account_id')}
                options={accountOptions}
              />
              <Field
                label="Purchase account"
                name="edit_purchase_account"
                value={form.purchase_account_id}
                onChange={set('purchase_account_id')}
                options={accountOptions}
              />
              <Field
                label="Variance account"
                name="edit_variance_account"
                value={form.variance_account_id}
                onChange={set('variance_account_id')}
                options={accountOptions}
              />
            </>
          ) : (
            <p className="field-hint">
              Choose a legal entity above to edit account mappings — they exist per entity.
            </p>
          )}
          <div className="button-row">
            <Button type="submit" variant="primary" busy={busy}>
              Save
            </Button>
            <Button
              onClick={() => {
                setEditing(null);
                setForm(emptyForm);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {can('item.create') && !editing ? (
        <form onSubmit={create} className="card">
          <h2>New item</h2>
          {!organizationId ? (
            <Notice tone="warning">
              Choose an organization above; an item is created inside one.
            </Notice>
          ) : null}
          <Field label="SKU" name="sku" value={form.sku} onChange={set('sku')} required />
          <Field label="Name" name="name" value={form.name} onChange={set('name')} required />
          <Field
            label="Kind"
            name="new_kind"
            value={form.kind}
            onChange={set('kind')}
            required
            options={enumOptions(KINDS)}
            hint="Only an inventory item carries stock and cost layers."
          />
          <Field
            label="Base unit of measure"
            name="base_uom"
            value={form.base_uom}
            onChange={set('base_uom')}
            required
          />
          <Field
            label="Valuation method"
            name="valuation"
            value={form.valuation}
            onChange={set('valuation')}
            required
            options={enumOptions(VALUATIONS)}
            hint="Fixed from creation: it decides how every future issue is costed, and cannot be changed once layers exist. LIFO is absent deliberately — IFRS prohibits it (ADR-0001)."
          />
          <Field label="Barcode" name="barcode" value={form.barcode} onChange={set('barcode')} />
          <Field
            label="Lot tracking"
            name="lot_tracking"
            value={form.lot_tracking}
            onChange={set('lot_tracking')}
            options={YES_NO}
          />
          <Field
            label="Serial tracking"
            name="serial_tracking"
            value={form.serial_tracking}
            onChange={set('serial_tracking')}
            options={YES_NO}
          />
          <Field
            label="Expiry tracking"
            name="expiry_tracking"
            value={form.expiry_tracking}
            onChange={set('expiry_tracking')}
            options={YES_NO}
          />
          <Field
            label="Reorder level"
            name="reorder_level"
            value={form.reorder_level}
            onChange={set('reorder_level')}
            placeholder="0"
          />
          <Field
            label="Negative stock policy"
            name="negative_stock_policy"
            value={form.negative_stock_policy}
            onChange={set('negative_stock_policy')}
            options={enumOptions(NEGATIVE_POLICIES)}
          />
          {entityId ? (
            <>
              <h3>Accounting for the chosen entity</h3>
              <Field
                label="Inventory account"
                name="inventory_account"
                value={form.inventory_account_id}
                onChange={set('inventory_account_id')}
                options={accountOptions}
              />
              <Field
                label="COGS account"
                name="cogs_account"
                value={form.cogs_account_id}
                onChange={set('cogs_account_id')}
                options={accountOptions}
              />
              <Field
                label="Revenue account"
                name="revenue_account"
                value={form.revenue_account_id}
                onChange={set('revenue_account_id')}
                options={accountOptions}
              />
              <Field
                label="Purchase account"
                name="purchase_account"
                value={form.purchase_account_id}
                onChange={set('purchase_account_id')}
                options={accountOptions}
              />
              <Field
                label="Variance account"
                name="variance_account"
                value={form.variance_account_id}
                onChange={set('variance_account_id')}
                options={accountOptions}
              />
            </>
          ) : (
            <p className="field-hint">
              Choose a legal entity above to map accounts now. An item can be created without them
              and mapped later, but it cannot be received into stock until it has an inventory
              account.
            </p>
          )}
          <Button type="submit" variant="primary" busy={busy} disabled={!organizationId}>
            Create item
          </Button>
        </form>
      ) : null}
    </>
  );
}
