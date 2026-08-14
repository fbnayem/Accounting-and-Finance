import { Pool, PoolClient } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  assertEntityPermission,
  type TenantPrincipal,
} from '@acct/domain';
import { writeInTenant, readInTenant, recordAudit } from '@acct/database';

/**
 * Warehouses and locations — doc 08 "Warehouses and locations".
 *
 * Locations exist because movements need them: `movement_direction_has_location`
 * (0012) requires a destination on every inbound movement and a source on every
 * outbound one, which is why F-901 added the location routes at all — with no
 * locations, no stock could move and three of Phase 5's exit criteria had no
 * subject.
 */

const LOCATION_KINDS = new Set([
  'RECEIVING',
  'STORAGE',
  'PICKING',
  'QUARANTINE',
  'DAMAGED',
  'RETURNS',
  'IN_TRANSIT',
]);

export class WarehousesService {
  constructor(private readonly pool: Pool) {}

  async createWarehouse(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      code: string;
      name: string;
      branchId?: string | null | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'warehouse.create', input.legalEntityId);

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO warehouses (id, tenant_id, legal_entity_id, branch_id, code, name)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id, legal_entity_id, branch_id, code, name, status::text AS status`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          input.branchId ?? null,
          input.code,
          input.name,
        ],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        action: 'warehouse.created',
        resourceType: 'warehouse',
        resourceId: id,
        after: rows[0] as Record<string, unknown>,
      });

      return rows[0];
    });
  }

  async listWarehouses(principal: TenantPrincipal, query: { legalEntityId?: string | undefined }) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT id, legal_entity_id, branch_id, code, name, status::text AS status
           FROM warehouses
          WHERE ($1::uuid IS NULL OR legal_entity_id = $1)
          ORDER BY code`,
        [query.legalEntityId ?? null],
      );
      return { data: rows };
    });
  }

  /** F-901. The location's entity is the warehouse's — never taken from input. */
  async createLocation(
    principal: TenantPrincipal,
    warehouseId: string,
    input: {
      code: string;
      name: string;
      kind?: string | undefined;
      parentId?: string | null | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const warehouse = await loadWarehouse(client, warehouseId);
      assertEntityPermission(principal, 'warehouse.create', warehouse.legal_entity_id);

      const kind = input.kind ?? 'STORAGE';
      if (!LOCATION_KINDS.has(kind)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${kind}" is not a location kind. doc 08 names: ${[...LOCATION_KINDS].join(', ')}.`,
        );
      }

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO warehouse_locations
           (id, tenant_id, warehouse_id, legal_entity_id, parent_id, code, name, kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING id, warehouse_id, legal_entity_id, parent_id, code, name,
                   kind::text AS kind, status::text AS status`,
        [
          id,
          principal.tenantId,
          warehouseId,
          warehouse.legal_entity_id,
          input.parentId ?? null,
          input.code,
          input.name,
          kind,
        ],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: warehouse.legal_entity_id,
        action: 'warehouse.location_created',
        resourceType: 'warehouse_location',
        resourceId: id,
        after: rows[0] as Record<string, unknown>,
      });

      return rows[0];
    });
  }

  async listLocations(principal: TenantPrincipal, warehouseId: string) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT id, warehouse_id, legal_entity_id, parent_id, code, name,
                kind::text AS kind, status::text AS status
           FROM warehouse_locations
          WHERE warehouse_id = $1
          ORDER BY code`,
        [warehouseId],
      );
      return { data: rows };
    });
  }
}

export interface WarehouseRow {
  id: string;
  legal_entity_id: string;
  code: string;
  name: string;
  status: string;
}

export async function loadWarehouse(client: PoolClient, id: string): Promise<WarehouseRow> {
  const { rows } = await client.query<WarehouseRow>(
    `SELECT id, legal_entity_id, code, name, status::text AS status FROM warehouses WHERE id = $1`,
    [id],
  );
  const warehouse = rows[0];
  if (!warehouse) throw notFound('warehouse', id);
  return warehouse;
}
