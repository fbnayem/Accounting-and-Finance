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
import { enumOptions } from '../../../components/phase5';

interface Warehouse {
  id: string;
  legal_entity_id: string;
  branch_id: string | null;
  code: string;
  name: string;
  status: string;
}

interface WarehouseLocation {
  id: string;
  warehouse_id: string;
  parent_id: string | null;
  code: string;
  name: string;
  kind: string;
  status: string;
}

const LOCATION_KINDS = [
  'STORAGE',
  'RECEIVING',
  'PICKING',
  'QUARANTINE',
  'DAMAGED',
  'RETURNS',
  'IN_TRANSIT',
];

/**
 * Warehouses and the locations inside them — doc 08.
 *
 * The locations half is not administrative detail. `movement_direction_has_location`
 * (migration 0012) requires a destination on every inbound movement and a source
 * on every outbound one, so a warehouse with no locations can receive nothing:
 * every stock document on the next screen would be refused, with a message about
 * a location the user has no way to create. That was F-901, and it is why the
 * location form sits here rather than in an admin corner.
 */
export default function WarehousesPage() {
  const held = useHeldPermissions();
  const can = (permission: string) => !held || held.has(permission);
  const keys = useIdempotencyKeys();

  const entities = useResource(() =>
    api<{ data: { id: string; code: string; legal_name: string }[] }>('/legal-entities'),
  );
  const [entityId, setEntityId] = useState('');

  const branches = useResource(
    () =>
      entityId
        ? api<{ data: { id: string; code: string; name: string }[] }>('/branches', {
            query: { legal_entity_id: entityId },
          })
        : Promise.resolve({ data: [] as { id: string; code: string; name: string }[] }),
    [entityId],
  );

  const warehouses = useResource(
    () =>
      api<{ data: Warehouse[] }>('/warehouses', {
        query: entityId ? { legal_entity_id: entityId } : {},
      }),
    [entityId],
  );

  const [selected, setSelected] = useState<Warehouse | null>(null);
  const locations = useResource(
    () =>
      selected
        ? api<{ data: WarehouseLocation[] }>(`/warehouses/${selected.id}/locations`)
        : Promise.resolve({ data: [] as WarehouseLocation[] }),
    [selected?.id],
  );

  const [warehouseForm, setWarehouseForm] = useState({ code: '', name: '', branch_id: '' });
  const [locationForm, setLocationForm] = useState({
    code: '',
    name: '',
    kind: 'STORAGE',
    parent_id: '',
  });
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const createWarehouse = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      legal_entity_id: entityId,
      code: warehouseForm.code,
      name: warehouseForm.name,
      branch_id: warehouseForm.branch_id || null,
    };
    try {
      const created = await api<Warehouse>('/warehouses', {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor('warehouse', body),
      });
      keys.settle('warehouse');
      setWarehouseForm({ code: '', name: '', branch_id: '' });
      setSelected(created);
      setNotice(
        `${created.code} created. It cannot receive stock until it has at least one location.`,
      );
      warehouses.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const createLocation = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const body = {
      code: locationForm.code,
      name: locationForm.name,
      kind: locationForm.kind,
      parent_id: locationForm.parent_id || null,
    };
    try {
      await api(`/warehouses/${selected.id}/locations`, {
        method: 'POST',
        body,
        idempotencyKey: keys.keyFor(`location-${selected.id}`, body),
      });
      keys.settle(`location-${selected.id}`);
      setLocationForm({ code: '', name: '', kind: 'STORAGE', parent_id: '' });
      setNotice(`${body.code} added to ${selected.code}.`);
      locations.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Warehouses"
        description="Warehouses and their locations. A movement always names a location, so a warehouse without one cannot be used."
      />
      <ErrorBanner error={error ?? warehouses.error ?? locations.error} />
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
          hint="Leave empty to see every warehouse you have access to."
        />
      </div>

      <DataTable<Warehouse>
        caption="Warehouses"
        rows={warehouses.data?.data ?? []}
        rowKey={(row) => row.id}
        empty="No warehouses yet."
        columns={[
          { key: 'code', header: 'Code', render: (row) => row.code },
          { key: 'name', header: 'Name', render: (row) => row.name },
          { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
          {
            key: 'locations',
            header: 'Locations',
            render: (row) => (
              <Button onClick={() => setSelected(row)}>
                Open
                <span className="visually-hidden"> locations for {row.code}</span>
              </Button>
            ),
          },
        ]}
      />

      {selected ? (
        <div className="card">
          <h2>
            Locations in {selected.code} — {selected.name}
          </h2>
          {(locations.data?.data.length ?? 0) === 0 ? (
            <Notice tone="warning">
              This warehouse has no locations, so no receipt, issue or transfer can name one. Add at
              least a storage location before recording stock here.
            </Notice>
          ) : null}
          <DataTable<WarehouseLocation>
            caption={`Locations in ${selected.code}`}
            rows={locations.data?.data ?? []}
            rowKey={(row) => row.id}
            empty="No locations in this warehouse."
            columns={[
              { key: 'code', header: 'Code', render: (row) => row.code },
              { key: 'name', header: 'Name', render: (row) => row.name },
              {
                key: 'kind',
                header: 'Kind',
                render: (row) => row.kind.replace(/_/g, ' ').toLowerCase(),
              },
              {
                key: 'parent',
                header: 'Inside',
                render: (row) =>
                  row.parent_id
                    ? ((locations.data?.data ?? []).find((l) => l.id === row.parent_id)?.code ??
                      '—')
                    : '—',
              },
              { key: 'status', header: 'Status', render: (row) => <Status value={row.status} /> },
            ]}
          />

          {can('warehouse.create') ? (
            <form onSubmit={createLocation}>
              <h3>New location</h3>
              <Field
                label="Code"
                name="location_code"
                value={locationForm.code}
                onChange={(v) => setLocationForm({ ...locationForm, code: v })}
                required
              />
              <Field
                label="Name"
                name="location_name"
                value={locationForm.name}
                onChange={(v) => setLocationForm({ ...locationForm, name: v })}
                required
              />
              <Field
                label="Kind"
                name="location_kind"
                value={locationForm.kind}
                onChange={(v) => setLocationForm({ ...locationForm, kind: v })}
                required
                options={enumOptions(LOCATION_KINDS)}
                hint="Quarantine, damaged and returns are stock the business holds but should not pick from."
              />
              <Field
                label="Inside location"
                name="location_parent"
                value={locationForm.parent_id}
                onChange={(v) => setLocationForm({ ...locationForm, parent_id: v })}
                options={(locations.data?.data ?? []).map((l) => ({
                  value: l.id,
                  label: `${l.code} — ${l.name}`,
                }))}
                hint="Optional. Bins nest inside aisles; leave empty for a top-level location."
              />
              <Button type="submit" variant="primary" busy={busy}>
                Add location
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}

      {can('warehouse.create') ? (
        <form onSubmit={createWarehouse} className="card">
          <h2>New warehouse</h2>
          {!entityId ? (
            <Notice tone="warning">
              Choose a legal entity above. A warehouse belongs to one entity, and its stock is that
              entity&rsquo;s asset.
            </Notice>
          ) : null}
          <Field
            label="Code"
            name="warehouse_code"
            value={warehouseForm.code}
            onChange={(v) => setWarehouseForm({ ...warehouseForm, code: v })}
            required
          />
          <Field
            label="Name"
            name="warehouse_name"
            value={warehouseForm.name}
            onChange={(v) => setWarehouseForm({ ...warehouseForm, name: v })}
            required
          />
          <Field
            label="Branch"
            name="warehouse_branch"
            value={warehouseForm.branch_id}
            onChange={(v) => setWarehouseForm({ ...warehouseForm, branch_id: v })}
            options={(branches.data?.data ?? []).map((b) => ({
              value: b.id,
              label: `${b.code} — ${b.name}`,
            }))}
            hint="Optional. Sets the branch dimension on the journals this warehouse's movements post."
          />
          <Button type="submit" variant="primary" busy={busy} disabled={!entityId}>
            Create warehouse
          </Button>
        </form>
      ) : null}
    </>
  );
}
