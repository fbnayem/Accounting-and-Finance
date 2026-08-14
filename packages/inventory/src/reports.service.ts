import { Pool, PoolClient } from 'pg';
import { D, Decimal, MONEY_SCALE, sumExact, type TenantPrincipal } from '@acct/domain';
import { readInTenant } from '@acct/database';

/**
 * Inventory reads and reports — doc 08 "Reports", and Gate D's requirement that
 * a difference between the subledger and its control account be "an explicit,
 * explainable reconciliation item".
 *
 * On-hand quantity is computed from posted movements, never from the
 * `inventory_on_hand` projection: 0012 marks that table "rebuildable
 * projection, never a source of truth", and a report that reads a projection
 * inherits every staleness bug the rebuilder ever has. Valuation is computed
 * from cost layers plus the landed cost capitalised onto them — the same rows
 * COGS is reproduced from, which is what lets valuation and COGS never
 * disagree about what a layer was worth.
 *
 * The two implemented methods genuinely value differently, and every valuation
 * here branches on the effective method (`item_accounting_settings.
 * valuation_override`, else `items.valuation`):
 *
 *   - FIFO: Σ round(remaining_quantity × unit_cost) — a FIFO layer's unit cost
 *     IS what was paid for the units still in it.
 *   - WEIGHTED_AVERAGE: Σ round(original_quantity × unit_cost) − Σ consumption
 *     total_cost, over every layer the item has ever had, consumed ones
 *     included — received minus issued. Doc 08 carries VALUE as the source of
 *     truth for this method: issues credit Inventory at the average while
 *     layers record receipts, so remaining × receipt cost stops being the
 *     value at the first issue. See `weightedAveragePoolValue` in stock.ts,
 *     which is this same expression on the posting side.
 */

export class InventoryReportsService {
  constructor(private readonly pool: Pool) {}

  async onHand(
    principal: TenantPrincipal,
    query: {
      legalEntityId?: string | undefined;
      warehouseId?: string | undefined;
      itemId?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT m.item_id, i.sku, i.name, i.base_uom, wl.warehouse_id, w.code AS warehouse_code,
                sum(m.quantity)::text AS quantity
           FROM inventory_movements m
           JOIN inventory_documents d ON d.id = m.inventory_document_id
           JOIN items i ON i.id = m.item_id
           JOIN warehouse_locations wl
             ON wl.id = CASE WHEN m.quantity > 0 THEN m.to_location_id ELSE m.from_location_id END
           JOIN warehouses w ON w.id = wl.warehouse_id
          WHERE d.status IN ('POSTED','CLOSED')
            AND ($1::uuid IS NULL OR m.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR wl.warehouse_id = $2)
            AND ($3::uuid IS NULL OR m.item_id = $3)
          GROUP BY m.item_id, i.sku, i.name, i.base_uom, wl.warehouse_id, w.code
         HAVING sum(m.quantity) <> 0
          ORDER BY i.sku, w.code`,
        [query.legalEntityId ?? null, query.warehouseId ?? null, query.itemId ?? null],
      );
      return { data: rows };
    });
  }

  async valuation(
    principal: TenantPrincipal,
    query: {
      legalEntityId?: string | undefined;
      warehouseId?: string | undefined;
      itemId?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const rows = await valuationRows(client, query);
      const total = sumExact(rows.map((r) => D(r.total_value)));
      return { data: rows, total_value: total.toString() };
    });
  }

  /**
   * The report-shaped valuation: the same numbers as `valuation` — one
   * calculation, not a richer rival that could disagree — plus the layer
   * detail and the provisional exceptions doc 08 requires to be visible.
   */
  async valuationReport(
    principal: TenantPrincipal,
    query: { legalEntityId?: string | undefined; warehouseId?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const rows = await valuationRows(client, query);
      const total = sumExact(rows.map((r) => D(r.total_value)));

      const { rows: layers } = await client.query(
        `SELECT l.id, l.item_id, i.sku, l.warehouse_id, l.received_date::text AS received_date,
                l.original_quantity::text AS original_quantity,
                l.remaining_quantity::text AS remaining_quantity,
                l.unit_cost::text AS unit_cost, l.currency, l.status::text AS status,
                l.is_provisional,
                round(l.remaining_quantity * l.unit_cost, cur.minor_unit)::text AS remaining_value
           FROM inventory_cost_layers l
           JOIN currencies cur ON cur.code = l.currency
           JOIN items i ON i.id = l.item_id
          WHERE l.remaining_quantity > 0
            AND ($1::uuid IS NULL OR l.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR l.warehouse_id = $2)
          ORDER BY i.sku, l.received_date, l.id`,
        [query.legalEntityId ?? null, query.warehouseId ?? null],
      );

      // doc 08's negative-stock rule: "provisional costing and later cost
      // settlement must be deterministic and visible". This is the visible
      // half — every provisional layer, consumed or not, until settled.
      const { rows: provisional } = await client.query(
        `SELECT l.id, l.item_id, i.sku, l.warehouse_id, l.received_date::text AS received_date,
                l.original_quantity::text AS original_quantity,
                l.remaining_quantity::text AS remaining_quantity,
                l.unit_cost::text AS unit_cost, l.status::text AS status, l.settled_at
           FROM inventory_cost_layers l
           JOIN items i ON i.id = l.item_id
          WHERE l.is_provisional AND l.settled_at IS NULL
            AND ($1::uuid IS NULL OR l.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR l.warehouse_id = $2)
          ORDER BY i.sku, l.received_date`,
        [query.legalEntityId ?? null, query.warehouseId ?? null],
      );

      return {
        data: rows,
        total_value: total.toString(),
        layers,
        provisional_layers: provisional,
      };
    });
  }

  /**
   * F-911 — Inventory-to-GL Reconciliation.
   *
   * Three numbers and the decomposition between them, because Gate D requires a
   * difference to be "an explicit, explainable reconciliation item" and exit
   * criterion 1 requires the valuation report to reconcile to the control
   * account. The gap is walked in named pieces; whatever the pieces do not
   * cover is returned as `unexplained` rather than absorbed — an unexplained
   * zero is the pass condition, an unexplained anything-else is the finding.
   */
  async reconciliation(
    principal: TenantPrincipal,
    query: { legalEntityId: string; accountingBookId?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      // 1. Subledger side: layers plus landed cost still attached to stock.
      // The SAME per-method expression as valuationRows — one calculation, not
      // a rival: FIFO layers at remaining × receipt cost, weighted-average
      // layers at received minus issued (see the module comment). A consumed
      // WA layer contributes its net — receipt value minus what issues charged
      // out of it — which is why there is no remaining_quantity filter here.
      const { rows: valuationParts } = await client.query<{
        layer_value: string;
        landed_on_hand: string;
      }>(
        `SELECT coalesce(sum(
                  CASE WHEN coalesce(s.valuation_override, i.valuation) = 'WEIGHTED_AVERAGE'
                    THEN round(l.original_quantity * l.unit_cost, cur.minor_unit)
                         - coalesce((SELECT sum(c.total_cost)
                                       FROM inventory_cost_consumptions c
                                      WHERE c.cost_layer_id = l.id), 0)
                    ELSE round(l.remaining_quantity * l.unit_cost, cur.minor_unit)
                  END), 0)::text AS layer_value,
                coalesce((
                  SELECT sum(a.allocated_amount - a.cogs_adjustment)
                    FROM landed_cost_allocations a
                    JOIN inventory_cost_layers al ON al.id = a.cost_layer_id
                   WHERE a.legal_entity_id = $1 AND al.remaining_quantity > 0
                     AND ($2::uuid IS NULL OR al.accounting_book_id = $2)
                ), 0)::text AS landed_on_hand
           FROM inventory_cost_layers l
           JOIN currencies cur ON cur.code = l.currency
           JOIN items i ON i.id = l.item_id
           LEFT JOIN item_accounting_settings s
             ON s.item_id = l.item_id AND s.legal_entity_id = l.legal_entity_id
          WHERE l.legal_entity_id = $1
            AND ($2::uuid IS NULL OR l.accounting_book_id = $2)`,
        [query.legalEntityId, query.accountingBookId ?? null],
      );
      const layerValue = D(valuationParts[0]?.layer_value ?? '0');
      const landedOnHand = D(valuationParts[0]?.landed_on_hand ?? '0');
      const valuationTotal = layerValue.add(landedOnHand);

      // 2. GL side: the balance of every account any item of this entity maps
      // inventory to. The control account set is derived from the mappings, not
      // configured twice — a second list would be the thing that drifts.
      const { rows: controlAccounts } = await client.query<{ account_id: string; code: string }>(
        `SELECT DISTINCT s.inventory_account_id AS account_id, a.code
           FROM item_accounting_settings s
           JOIN accounts a ON a.id = s.inventory_account_id
          WHERE s.legal_entity_id = $1 AND s.inventory_account_id IS NOT NULL`,
        [query.legalEntityId],
      );
      const accountIds = controlAccounts.map((a) => a.account_id);

      let glBalance = Decimal.zero(MONEY_SCALE);
      if (accountIds.length > 0) {
        const { rows: balances } = await client.query<{ balance: string }>(
          `SELECT coalesce(sum(jl.base_debit - jl.base_credit), 0)::text AS balance
             FROM journal_lines jl
             JOIN journal_entries je ON je.id = jl.journal_entry_id
            WHERE jl.account_id = ANY($1::uuid[])
              AND je.status = 'POSTED'
              AND je.legal_entity_id = $2
              AND ($3::uuid IS NULL OR je.accounting_book_id = $3)`,
          [accountIds, query.legalEntityId, query.accountingBookId ?? null],
        );
        glBalance = D(balances[0]?.balance ?? '0');
      }

      const difference = glBalance.sub(valuationTotal);

      // 3. The decomposition.
      const items: { kind: string; amount: string; count: number; explanation: string }[] = [];

      // 3a. Goods receipts accrued in the GL whose stock consequence has not
      // been posted yet: the control was debited by Phase 3, no layer exists.
      if (accountIds.length > 0) {
        const { rows } = await client.query<{ amount: string; count: string }>(
          `SELECT coalesce(sum(jl.base_debit - jl.base_credit), 0)::text AS amount,
                  count(DISTINCT je.source_id)::text AS count
             FROM journal_lines jl
             JOIN journal_entries je ON je.id = jl.journal_entry_id
            WHERE jl.account_id = ANY($1::uuid[])
              AND je.status = 'POSTED' AND je.legal_entity_id = $2
              AND je.source_type = 'goods_receipt'
              AND NOT EXISTS (
                SELECT 1 FROM inventory_documents d
                 WHERE d.source_type = 'goods_receipt' AND d.source_id = je.source_id
                   AND d.status IN ('POSTED','CLOSED'))`,
          [accountIds, query.legalEntityId],
        );
        pushItem(
          items,
          'GRNI_ACCRUED_STOCK_PENDING',
          rows[0],
          'Goods receipts posted to the control account whose stock movement has not been ' +
            'posted yet — the accrual exists, the layers do not.',
        );
      }

      // 3b. Journals on the control accounts from outside the inventory flow:
      // manual entries and anything else that moved the control without moving
      // stock. Explicitly listed because this is the classic source of a
      // never-explained difference.
      if (accountIds.length > 0) {
        const { rows } = await client.query<{ amount: string; count: string }>(
          `SELECT coalesce(sum(jl.base_debit - jl.base_credit), 0)::text AS amount,
                  count(DISTINCT je.id)::text AS count
             FROM journal_lines jl
             JOIN journal_entries je ON je.id = jl.journal_entry_id
            WHERE jl.account_id = ANY($1::uuid[])
              AND je.status = 'POSTED' AND je.legal_entity_id = $2
              AND (je.source_type IS NULL
                   OR je.source_type NOT IN ('inventory_document','goods_receipt','landed_cost'))`,
          [accountIds, query.legalEntityId],
        );
        pushItem(
          items,
          'NON_INVENTORY_JOURNALS',
          rows[0],
          'Journal lines on the inventory control accounts whose source is not an inventory ' +
            'document, goods receipt or landed cost — typically manual journals.',
        );
      }

      // 3c. Rounding residue on fully consumed FIFO layers: a layer received at
      // 3 × 3.333333 posted 10.00 in, and three 1-unit FIFO issues took 9.99
      // out. The cent is real, explainable, and lives here until written off.
      // FIFO-effective items only: a weighted-average layer's received-minus-
      // consumed difference is already INSIDE the valuation (step 1 nets every
      // layer, consumed or not), so naming it again here would double-count it
      // against a gap that no longer exists.
      const { rows: residue } = await client.query<{ amount: string; count: string }>(
        `SELECT coalesce(sum(round(l.original_quantity * l.unit_cost, cur.minor_unit) - c.consumed),
                         0)::text AS amount,
                count(*)::text AS count
           FROM inventory_cost_layers l
           JOIN currencies cur ON cur.code = l.currency
           JOIN items i ON i.id = l.item_id
           LEFT JOIN item_accounting_settings s
             ON s.item_id = l.item_id AND s.legal_entity_id = l.legal_entity_id
           JOIN LATERAL (
             SELECT coalesce(sum(total_cost), 0) AS consumed
               FROM inventory_cost_consumptions WHERE cost_layer_id = l.id
           ) c ON true
          WHERE l.legal_entity_id = $1 AND l.remaining_quantity = 0 AND NOT l.is_provisional
            AND coalesce(s.valuation_override, i.valuation) <> 'WEIGHTED_AVERAGE'
            AND ($2::uuid IS NULL OR l.accounting_book_id = $2)
            AND round(l.original_quantity * l.unit_cost, cur.minor_unit) <> c.consumed`,
        [query.legalEntityId, query.accountingBookId ?? null],
      );
      pushItem(
        items,
        'ROUNDING_RESIDUE_CONSUMED_LAYERS',
        residue[0],
        'Fully consumed FIFO layers whose capitalised value differs from the sum of their ' +
          'consumptions by per-consumption rounding. The control retains these cents; the ' +
          'valuation no longer shows the layer. Weighted-average layers are excluded: their ' +
          'received-minus-consumed difference is part of the valuation itself.',
      );

      // 3d. Landed cost whose layer has since been fully consumed: the
      // capitalised part stays in the control account, but the valuation drops
      // the layer. See landed-cost.service.ts for why the layer itself is not
      // re-costed.
      const { rows: landedConsumed } = await client.query<{ amount: string; count: string }>(
        `SELECT coalesce(sum(a.allocated_amount - a.cogs_adjustment), 0)::text AS amount,
                count(*)::text AS count
           FROM landed_cost_allocations a
           JOIN inventory_cost_layers l ON l.id = a.cost_layer_id
          WHERE a.legal_entity_id = $1 AND l.remaining_quantity = 0
            AND ($2::uuid IS NULL OR l.accounting_book_id = $2)
            AND a.allocated_amount <> a.cogs_adjustment`,
        [query.legalEntityId, query.accountingBookId ?? null],
      );
      pushItem(
        items,
        'LANDED_COST_ON_CONSUMED_LAYERS',
        landedConsumed[0],
        'Landed cost capitalised onto layers that were later fully issued at their original ' +
          'unit cost. The value sits in the control account awaiting cost settlement.',
      );

      // 3e. Provisional layers pending settlement — informational: they carry
      // an estimated cost, so both sides hold a number that may still move.
      const { rows: provisional } = await client.query<{ amount: string; count: string }>(
        `SELECT coalesce(sum(round(l.original_quantity * l.unit_cost, cur.minor_unit)), 0)::text
                  AS amount,
                count(*)::text AS count
           FROM inventory_cost_layers l
           JOIN currencies cur ON cur.code = l.currency
          WHERE l.legal_entity_id = $1 AND l.is_provisional AND l.settled_at IS NULL
            AND ($2::uuid IS NULL OR l.accounting_book_id = $2)`,
        [query.legalEntityId, query.accountingBookId ?? null],
      );
      pushItem(
        items,
        'PROVISIONAL_LAYERS_PENDING_SETTLEMENT',
        provisional[0],
        'Negative-stock issues costed provisionally (doc 08); their cost is an estimate on ' +
          'both sides until settled, so this item is informational rather than additive.',
      );

      // The pieces that genuinely sit between GL and valuation are 3a–3d.
      // 3e overlaps both sides and is excluded from the arithmetic on purpose.
      const explained = sumExact(
        items
          .filter((i) => i.kind !== 'PROVISIONAL_LAYERS_PENDING_SETTLEMENT')
          .map((i) => D(i.amount)),
      );

      return {
        legal_entity_id: query.legalEntityId,
        control_accounts: controlAccounts,
        valuation_total: valuationTotal.toString(),
        valuation_layers: layerValue.toString(),
        valuation_landed_cost_on_hand: landedOnHand.toString(),
        gl_balance: glBalance.toString(),
        difference: difference.toString(),
        reconciling_items: items,
        explained: explained.toString(),
        unexplained: difference.sub(explained).toString(),
      };
    });
  }
}

function pushItem(
  items: { kind: string; amount: string; count: number; explanation: string }[],
  kind: string,
  row: { amount: string; count: string } | undefined,
  explanation: string,
): void {
  const amount = D(row?.amount ?? '0');
  const count = Number(row?.count ?? '0');
  if (amount.isZero() && count === 0) return;
  items.push({ kind, amount: amount.toString(), count, explanation });
}

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

async function valuationRows(
  client: PoolClient,
  query: {
    legalEntityId?: string | undefined;
    warehouseId?: string | undefined;
    itemId?: string | undefined;
  },
): Promise<ValuationRow[]> {
  // The layer value branches on the effective valuation method (see the module
  // comment): FIFO sums the open layers at receipt cost, rounded per layer at
  // the minor unit — the same value the receipt posted. WEIGHTED_AVERAGE is
  // received minus issued over ALL of the item's layers in this warehouse,
  // consumed ones included, because a consumed layer whose issues charged the
  // average rather than its receipt cost keeps that difference in the pool.
  // Landed cost on hand is (allocated − cogs_adjustment) for layers still
  // holding stock, matching what LANDED_COST_CAPITALIZED debited into the
  // control account — identical for both methods.
  const { rows } = await client.query<ValuationRow>(
    `SELECT q.item_id, q.sku, q.name, q.warehouse_id, q.warehouse_code, q.valuation_method,
            q.quantity::text AS quantity,
            q.layer_value::text AS layer_value,
            q.landed_cost_on_hand::text AS landed_cost_on_hand,
            (q.layer_value + q.landed_cost_on_hand)::text AS total_value,
            q.has_provisional
       FROM (
         SELECT l.item_id, i.sku, i.name, l.warehouse_id, w.code AS warehouse_code,
                coalesce(s.valuation_override, i.valuation)::text AS valuation_method,
                sum(l.remaining_quantity) AS quantity,
                CASE WHEN coalesce(s.valuation_override, i.valuation) = 'WEIGHTED_AVERAGE'
                  THEN (
                    SELECT coalesce(sum(
                             round(al.original_quantity * al.unit_cost, acur.minor_unit)
                             - coalesce((SELECT sum(c.total_cost)
                                           FROM inventory_cost_consumptions c
                                          WHERE c.cost_layer_id = al.id), 0)), 0)
                      FROM inventory_cost_layers al
                      JOIN currencies acur ON acur.code = al.currency
                     WHERE al.item_id = l.item_id AND al.warehouse_id = l.warehouse_id
                  )
                  ELSE sum(round(l.remaining_quantity * l.unit_cost, cur.minor_unit))
                END AS layer_value,
                coalesce((
                  SELECT sum(a.allocated_amount - a.cogs_adjustment)
                    FROM landed_cost_allocations a
                    JOIN inventory_cost_layers al ON al.id = a.cost_layer_id
                   WHERE al.item_id = l.item_id AND al.warehouse_id = l.warehouse_id
                     AND al.remaining_quantity > 0
                ), 0) AS landed_cost_on_hand,
                bool_or(l.is_provisional) AS has_provisional
           FROM inventory_cost_layers l
           JOIN currencies cur ON cur.code = l.currency
           JOIN items i ON i.id = l.item_id
           JOIN warehouses w ON w.id = l.warehouse_id
           LEFT JOIN item_accounting_settings s
             ON s.item_id = l.item_id AND s.legal_entity_id = l.legal_entity_id
          WHERE l.remaining_quantity > 0
            AND ($1::uuid IS NULL OR l.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR l.warehouse_id = $2)
            AND ($3::uuid IS NULL OR l.item_id = $3)
          GROUP BY l.item_id, i.sku, i.name, l.warehouse_id, w.code,
                   s.valuation_override, i.valuation
       ) q
      ORDER BY q.sku, q.warehouse_code`,
    [query.legalEntityId ?? null, query.warehouseId ?? null, query.itemId ?? null],
  );
  return rows;
}
