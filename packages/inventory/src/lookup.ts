import { PoolClient } from 'pg';
import { AppError, notFound, type ValuationMethod } from '@acct/domain';
import { resolveNegativeStockPolicy, type NegativeStockPolicy } from './stock';

/**
 * Row loaders the document and posting services share. Each returns exactly the
 * columns its callers act on, so a permission or costing decision is never made
 * from a column nobody selected.
 */

export interface ItemContext {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly kind: string;
  readonly baseUom: string;
  /** The effective method: `item_accounting_settings.valuation_override` wins (F-033). */
  readonly valuation: ValuationMethod;
  readonly negativeStockPolicy: NegativeStockPolicy;
  readonly inventoryAccountId: string | null;
  readonly cogsAccountId: string | null;
  readonly varianceAccountId: string | null;
}

export async function loadItemContexts(
  client: PoolClient,
  itemIds: readonly string[],
  legalEntityId: string,
): Promise<Map<string, ItemContext>> {
  if (itemIds.length === 0) return new Map();
  const { rows } = await client.query<{
    id: string;
    sku: string;
    name: string;
    kind: string;
    base_uom: string;
    valuation: string;
    valuation_override: string | null;
    negative_stock_policy: string;
    entity_negative_stock_policy: string | null;
    inventory_account_id: string | null;
    cogs_account_id: string | null;
    variance_account_id: string | null;
  }>(
    `SELECT i.id, i.sku, i.name, i.kind::text AS kind, i.base_uom,
            i.valuation::text AS valuation, i.negative_stock_policy,
            s.valuation_override::text AS valuation_override,
            s.negative_stock_policy AS entity_negative_stock_policy,
            s.inventory_account_id, s.cogs_account_id, s.variance_account_id
       FROM items i
       LEFT JOIN item_accounting_settings s
         ON s.item_id = i.id AND s.legal_entity_id = $2
      WHERE i.id = ANY($1::uuid[])`,
    [[...new Set(itemIds)], legalEntityId],
  );

  const map = new Map<string, ItemContext>();
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      sku: row.sku,
      name: row.name,
      kind: row.kind,
      baseUom: row.base_uom,
      valuation: (row.valuation_override ?? row.valuation) as ValuationMethod,
      negativeStockPolicy: resolveNegativeStockPolicy(
        row.negative_stock_policy as NegativeStockPolicy,
        row.entity_negative_stock_policy as NegativeStockPolicy | null,
      ),
      inventoryAccountId: row.inventory_account_id,
      cogsAccountId: row.cogs_account_id,
      varianceAccountId: row.variance_account_id,
    });
  }

  for (const id of itemIds) {
    if (!map.has(id)) throw notFound('item', id);
  }
  return map;
}

export function requireItemAccount(
  item: ItemContext,
  account: 'inventoryAccountId' | 'cogsAccountId' | 'varianceAccountId',
): string {
  const value = item[account];
  if (value) return value;
  const column = {
    inventoryAccountId: 'inventory_account_id',
    cogsAccountId: 'cogs_account_id',
    varianceAccountId: 'variance_account_id',
  }[account];
  throw new AppError(
    'VALIDATION_FAILED',
    `Item ${item.sku} has no ${column} for this legal entity, so its movement has nowhere to ` +
      `post. Set it on the item's accounting settings (doc 08 item master).`,
    { details: { item_id: item.id, missing: column } },
  );
}

export interface LocationContext {
  readonly id: string;
  readonly warehouseId: string;
  readonly legalEntityId: string;
  readonly code: string;
}

export async function loadLocations(
  client: PoolClient,
  locationIds: readonly string[],
): Promise<Map<string, LocationContext>> {
  if (locationIds.length === 0) return new Map();
  const { rows } = await client.query<{
    id: string;
    warehouse_id: string;
    legal_entity_id: string;
    code: string;
  }>(
    `SELECT id, warehouse_id, legal_entity_id, code
       FROM warehouse_locations WHERE id = ANY($1::uuid[])`,
    [[...new Set(locationIds)]],
  );
  const map = new Map<string, LocationContext>();
  for (const row of rows) {
    map.set(row.id, {
      id: row.id,
      warehouseId: row.warehouse_id,
      legalEntityId: row.legal_entity_id,
      code: row.code,
    });
  }
  for (const id of locationIds) {
    if (!map.has(id)) throw notFound('warehouse_location', id);
  }
  return map;
}

/**
 * One accounting-policy column effective on a date; null = not configured.
 * The same resolver `ApService.policyAccount` uses — duplicated at the same
 * two-line size rather than imported, because @acct/subledger exports it as a
 * method on a service this package has no other reason to construct.
 */
export async function policyAccount(
  client: PoolClient,
  legalEntityId: string,
  column: 'grni_account_id',
  on: string,
): Promise<string | null> {
  const { rows } = await client.query<{ account_id: string | null }>(
    `SELECT ${column} AS account_id FROM accounting_policies
      WHERE legal_entity_id = $1 AND valid_from <= $2::date
      ORDER BY valid_from DESC LIMIT 1`,
    [legalEntityId, on],
  );
  return rows[0]?.account_id ?? null;
}
