import { Pool, PoolClient } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  assertPermission,
  assertEntityPermission,
  IMPLEMENTED_VALUATION_METHODS,
  VALUATION_METHODS,
  type ValuationMethod,
  type TenantPrincipal,
} from '@acct/domain';
import { writeInTenant, readInTenant, recordAudit, publish } from '@acct/database';

/**
 * Item master — doc 08 "Item master".
 *
 * Items are organization-scoped (0012), but every account they post through is
 * entity-scoped: F-033 split the mappings into `item_accounting_settings`
 * precisely because an item shared across two entities cannot have one COGS
 * account. This service keeps that split visible — the item is one write, its
 * per-entity accounting is another, each permission-checked at its own grain.
 */

const ITEM_KINDS = new Set(['SERVICE', 'NON_STOCK', 'INVENTORY', 'ASSET_PURCHASE', 'BUNDLE']);
const NEGATIVE_STOCK_POLICIES = new Set(['BLOCK', 'ALLOW_PROVISIONAL']);

export interface ItemAccountingInput {
  legalEntityId: string;
  inventoryAccountId?: string | null | undefined;
  cogsAccountId?: string | null | undefined;
  revenueAccountId?: string | null | undefined;
  purchaseAccountId?: string | null | undefined;
  varianceAccountId?: string | null | undefined;
  salesTaxCodeId?: string | null | undefined;
  purchaseTaxCodeId?: string | null | undefined;
  valuationOverride?: string | null | undefined;
  negativeStockPolicy?: string | null | undefined;
}

export class ItemsService {
  constructor(private readonly pool: Pool) {}

  async createItem(
    principal: TenantPrincipal,
    input: {
      organizationId: string;
      sku: string;
      name: string;
      kind: string;
      baseUom: string;
      barcode?: string | null | undefined;
      salesDescription?: string | null | undefined;
      purchaseDescription?: string | null | undefined;
      itemCategoryId?: string | null | undefined;
      valuation?: string | undefined;
      lotTracking?: boolean | undefined;
      serialTracking?: boolean | undefined;
      expiryTracking?: boolean | undefined;
      reorderLevel?: string | null | undefined;
      negativeStockPolicy?: string | undefined;
      accounting?: readonly ItemAccountingInput[] | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      // Items are organization-scoped, so there is no entity to scope the check
      // to — the same reasoning as contacts (F-026). The per-entity accounting
      // rows below are checked at their own entity.
      assertPermission(principal, 'item.create');

      if (!ITEM_KINDS.has(input.kind)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${input.kind}" is not an item type. doc 08 names: ${[...ITEM_KINDS].join(', ')}.`,
        );
      }

      const valuation = (input.valuation ?? 'WEIGHTED_AVERAGE') as ValuationMethod;
      if (!VALUATION_METHODS.includes(valuation)) {
        throw new AppError('VALIDATION_FAILED', `"${valuation}" is not a valuation method.`);
      }
      if (!IMPLEMENTED_VALUATION_METHODS.includes(valuation)) {
        // The engine refuses these at issue time (see @acct/domain costing);
        // refusing at creation moves the failure to the person who can change
        // the choice, not the warehouse clerk posting the first issue.
        throw new AppError(
          'NOT_IMPLEMENTED',
          `Valuation method ${valuation} is not implemented yet. ` +
            `Available: ${IMPLEMENTED_VALUATION_METHODS.join(', ')}.`,
        );
      }

      const negativeStockPolicy = input.negativeStockPolicy ?? 'BLOCK';
      if (!NEGATIVE_STOCK_POLICIES.has(negativeStockPolicy)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `negative_stock_policy is BLOCK or ALLOW_PROVISIONAL (doc 08: default block).`,
        );
      }

      const id = uuidv7();
      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO items
           (id, tenant_id, organization_id, item_category_id, sku, barcode, name,
            sales_description, purchase_description, kind, base_uom, valuation,
            lot_tracking, serial_tracking, expiry_tracking, reorder_level,
            negative_stock_policy)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING id, organization_id, item_category_id, sku, barcode, name,
                   sales_description, purchase_description, kind::text AS kind, base_uom,
                   valuation::text AS valuation, lot_tracking, serial_tracking, expiry_tracking,
                   reorder_level::text AS reorder_level, negative_stock_policy,
                   status::text AS status, created_at`,
        [
          id,
          principal.tenantId,
          input.organizationId,
          input.itemCategoryId ?? null,
          input.sku,
          input.barcode ?? null,
          input.name,
          input.salesDescription ?? null,
          input.purchaseDescription ?? null,
          input.kind,
          input.baseUom,
          valuation,
          input.lotTracking ?? false,
          input.serialTracking ?? false,
          input.expiryTracking ?? false,
          input.reorderLevel ?? null,
          negativeStockPolicy,
        ],
      );

      const accounting = [];
      for (const settings of input.accounting ?? []) {
        accounting.push(await this.upsertAccounting(client, principal, id, settings));
      }

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        organizationId: input.organizationId,
        action: 'item.created',
        resourceType: 'item',
        resourceId: id,
        after: { ...(rows[0] as Record<string, unknown>), accounting },
      });

      await publish(client, context, {
        eventType: 'item.created',
        aggregateType: 'item',
        aggregateId: id,
        tenantId: principal.tenantId,
        // item.created is book-scoped in contracts/events.yaml, but an item is
        // organization-scoped and has no single entity or book. The first
        // accounting row's entity is the closest honest scope when one exists.
        legalEntityId: input.accounting?.[0]?.legalEntityId ?? null,
        payload: { sku: input.sku, kind: input.kind, valuation },
      });

      return { ...rows[0], accounting };
    });
  }

  /**
   * F-906. The valuation method is deliberately NOT accepted here — the
   * contract says so, and the reason is in the layers: changing it
   * retrospectively would reinterpret cost layers already consumed at the old
   * method, and the stored consumptions would no longer explain the COGS they
   * produced.
   */
  async updateItem(
    principal: TenantPrincipal,
    id: string,
    input: {
      name?: string | undefined;
      barcode?: string | null | undefined;
      salesDescription?: string | null | undefined;
      purchaseDescription?: string | null | undefined;
      itemCategoryId?: string | null | undefined;
      reorderLevel?: string | null | undefined;
      negativeStockPolicy?: string | undefined;
      status?: string | undefined;
      accounting?: readonly ItemAccountingInput[] | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertPermission(principal, 'item.manage');

      const { rows: existing } = await client.query<Record<string, unknown>>(
        `SELECT id, organization_id, sku, name, barcode, sales_description, purchase_description,
                item_category_id, reorder_level::text AS reorder_level, negative_stock_policy,
                status::text AS status
           FROM items WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const item = existing[0];
      if (!item) throw notFound('item', id);

      if (
        input.negativeStockPolicy !== undefined &&
        !NEGATIVE_STOCK_POLICIES.has(input.negativeStockPolicy)
      ) {
        throw new AppError(
          'VALIDATION_FAILED',
          `negative_stock_policy is BLOCK or ALLOW_PROVISIONAL (doc 08: default block).`,
        );
      }
      if (
        input.status !== undefined &&
        !['ACTIVE', 'INACTIVE', 'ARCHIVED'].includes(input.status)
      ) {
        throw new AppError('VALIDATION_FAILED', `"${input.status}" is not an item status.`);
      }

      const { rows } = await client.query<Record<string, unknown>>(
        `UPDATE items
            SET name = coalesce($2, name),
                barcode = coalesce($3, barcode),
                sales_description = coalesce($4, sales_description),
                purchase_description = coalesce($5, purchase_description),
                item_category_id = coalesce($6, item_category_id),
                reorder_level = coalesce($7, reorder_level),
                negative_stock_policy = coalesce($8, negative_stock_policy),
                status = coalesce($9::record_status, status)
          WHERE id = $1
        RETURNING id, organization_id, item_category_id, sku, barcode, name, sales_description,
                  purchase_description, kind::text AS kind, base_uom, valuation::text AS valuation,
                  lot_tracking, serial_tracking, expiry_tracking,
                  reorder_level::text AS reorder_level, negative_stock_policy,
                  status::text AS status`,
        [
          id,
          input.name ?? null,
          input.barcode ?? null,
          input.salesDescription ?? null,
          input.purchaseDescription ?? null,
          input.itemCategoryId ?? null,
          input.reorderLevel ?? null,
          input.negativeStockPolicy ?? null,
          input.status ?? null,
        ],
      );

      const accounting = [];
      for (const settings of input.accounting ?? []) {
        accounting.push(await this.upsertAccounting(client, principal, id, settings));
      }

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'item.updated',
        resourceType: 'item',
        resourceId: id,
        before: item,
        after: { ...(rows[0] as Record<string, unknown>), accounting },
      });

      return { ...rows[0], accounting };
    });
  }

  /** F-814 applies here as everywhere: the envelope is `{ data }`. */
  async listItems(
    principal: TenantPrincipal,
    query: {
      organizationId?: string | undefined;
      legalEntityId?: string | undefined;
      kind?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT i.id, i.organization_id, i.item_category_id, i.sku, i.barcode, i.name,
                i.kind::text AS kind, i.base_uom, i.valuation::text AS valuation,
                i.lot_tracking, i.serial_tracking, i.expiry_tracking,
                i.reorder_level::text AS reorder_level, i.negative_stock_policy,
                i.status::text AS status, i.created_at,
                s.inventory_account_id, s.cogs_account_id, s.revenue_account_id,
                s.purchase_account_id, s.variance_account_id,
                s.valuation_override::text AS valuation_override,
                s.negative_stock_policy AS entity_negative_stock_policy
           FROM items i
           LEFT JOIN item_accounting_settings s
             ON s.item_id = i.id AND s.legal_entity_id = $2
          WHERE ($1::uuid IS NULL OR i.organization_id = $1)
            AND ($3::item_type IS NULL OR i.kind = $3::item_type)
            AND ($4::record_status IS NULL OR i.status = $4::record_status)
          ORDER BY i.sku`,
        [
          query.organizationId ?? null,
          query.legalEntityId ?? null,
          query.kind ?? null,
          query.status ?? null,
        ],
      );
      return { data: rows };
    });
  }

  /**
   * One entity's accounting mappings, permission-checked at that entity — the
   * grain F-033 established. `valuation_override` is accepted only at first
   * write for the same reason `updateItem` refuses `valuation`.
   */
  private async upsertAccounting(
    client: PoolClient,
    principal: TenantPrincipal,
    itemId: string,
    input: ItemAccountingInput,
  ) {
    assertEntityPermission(principal, 'item.manage', input.legalEntityId);

    if (
      input.negativeStockPolicy != null &&
      !NEGATIVE_STOCK_POLICIES.has(input.negativeStockPolicy)
    ) {
      throw new AppError(
        'VALIDATION_FAILED',
        `negative_stock_policy is BLOCK or ALLOW_PROVISIONAL (doc 08: default block).`,
      );
    }

    const { rows: current } = await client.query<{ valuation_override: string | null }>(
      `SELECT valuation_override::text AS valuation_override
         FROM item_accounting_settings WHERE item_id = $1 AND legal_entity_id = $2 FOR UPDATE`,
      [itemId, input.legalEntityId],
    );
    if (
      current[0] &&
      input.valuationOverride !== undefined &&
      (input.valuationOverride ?? null) !== current[0].valuation_override
    ) {
      throw new AppError(
        'VALIDATION_FAILED',
        'The valuation override cannot change once set: cost layers already consumed under it ' +
          'would be reinterpreted, and the stored breakdowns would stop explaining their COGS.',
      );
    }

    const { rows } = await client.query(
      `INSERT INTO item_accounting_settings
         (item_id, legal_entity_id, tenant_id, inventory_account_id, cogs_account_id,
          revenue_account_id, purchase_account_id, variance_account_id, sales_tax_code_id,
          purchase_tax_code_id, valuation_override, negative_stock_policy)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (item_id, legal_entity_id) DO UPDATE SET
         inventory_account_id = coalesce(EXCLUDED.inventory_account_id, item_accounting_settings.inventory_account_id),
         cogs_account_id      = coalesce(EXCLUDED.cogs_account_id, item_accounting_settings.cogs_account_id),
         revenue_account_id   = coalesce(EXCLUDED.revenue_account_id, item_accounting_settings.revenue_account_id),
         purchase_account_id  = coalesce(EXCLUDED.purchase_account_id, item_accounting_settings.purchase_account_id),
         variance_account_id  = coalesce(EXCLUDED.variance_account_id, item_accounting_settings.variance_account_id),
         sales_tax_code_id    = coalesce(EXCLUDED.sales_tax_code_id, item_accounting_settings.sales_tax_code_id),
         purchase_tax_code_id = coalesce(EXCLUDED.purchase_tax_code_id, item_accounting_settings.purchase_tax_code_id),
         negative_stock_policy = EXCLUDED.negative_stock_policy
       RETURNING item_id, legal_entity_id, inventory_account_id, cogs_account_id,
                 revenue_account_id, purchase_account_id, variance_account_id,
                 sales_tax_code_id, purchase_tax_code_id,
                 valuation_override::text AS valuation_override, negative_stock_policy`,
      [
        itemId,
        input.legalEntityId,
        principal.tenantId,
        input.inventoryAccountId ?? null,
        input.cogsAccountId ?? null,
        input.revenueAccountId ?? null,
        input.purchaseAccountId ?? null,
        input.varianceAccountId ?? null,
        input.salesTaxCodeId ?? null,
        input.purchaseTaxCodeId ?? null,
        input.valuationOverride ?? null,
        input.negativeStockPolicy ?? null,
      ],
    );
    return rows[0];
  }
}
