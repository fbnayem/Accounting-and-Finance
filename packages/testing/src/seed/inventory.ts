import { Pool, PoolClient } from 'pg';
import {
  D,
  Decimal,
  consumeFifo,
  weightedAverageCost,
  type CostLayer,
  type WeightedAverageState,
} from '@acct/domain';
import { DeterministicRandom } from '../random';
import { SeedProfile } from '../profiles';
import { Foundation, SeededEntity } from './foundation';

/**
 * Bulk-seeds the Phase 5 inventory population — items, warehouses, posted
 * movement documents, cost layers and consumptions — the subject of the
 * `inventory-valuation-10k-items` workload ADR-0009 declared and Phases 0–4
 * could not measure.
 *
 * `profiles.ts` has declared 200 items for `small` and 5,000 for `reference`
 * since Phase 0, with the comment that they would be seeded "once the phase that
 * owns those tables exists". It does now, and the valuation workload was still
 * `iterations: 0`. That is F-730's shape (and F-811's, and F-812's), which is
 * why the seed and the workload land together.
 *
 * The property that matters more than any row count: **the costing rows obey
 * the real engine.** Every FIFO issue's consumption rows come out of
 * `consumeFifo` from `@acct/domain`, layer remainders are what that walk left
 * behind, and every weighted-average running value comes out of
 * `weightedAverageCost` — because the whole point of `inventory_cost_layers` /
 * `inventory_cost_consumptions` is that COGS is reproducible from them (Phase 5
 * exit criterion 3), and seeded data produced by ad-hoc arithmetic would make
 * every reconciliation benchmark meaningless.
 *
 * One deliberate asymmetry, stated rather than hidden: **only FIFO items are
 * issued.** A weighted-average issue's COGS is rounded ONCE per issue
 * (`weightedAverageIssue`, by design), and `inventory_cost_consumptions` stores
 * per-layer rows whose NOT NULL `unit_cost`/`total_cost` re-round per row — so
 * a WA issue has no exact per-layer decomposition, and any consumption rows
 * seeded for one would disagree with the engine by construction. Until the
 * Phase 5 service defines how a WA issue is stored, WA items here hold received
 * stock only, where layers, running state and on-hand value agree exactly.
 *
 * Ordering constraints this file must respect (0043):
 * - movements and costs are written while the document is DRAFT, and the
 *   document flips to POSTED afterwards — `guard_posted_document_lines` blocks
 *   a movement INSERT under a POSTED header, same as invoice posting since 0036;
 * - every TRANSFER document's movements net to zero per item (deferred
 *   constraint trigger, checked at COMMIT).
 *
 * Written straight to the tables rather than through a posting service, for the
 * reason `subledger.ts` and `banking.ts` state: this dataset is shaped for
 * *read* measurement, and the posting path's correctness is the exit-criteria
 * suite's job. No journal entries are posted — the GL side of the valuation
 * workload reads whatever the ledger stage seeded, and the workload reports the
 * variance rather than assuming it away.
 */

/** Items per generate-and-flush cycle; keeps every INSERT well under the bind-parameter cap. */
const ITEMS_PER_FLUSH = 100;

/** Rows per single INSERT statement inside a flush. */
const ROWS_PER_INSERT = 500;

/** Org-level reference data, fixed so every profile produces the same shape. */
const CATEGORIES: readonly (readonly [string, string])[] = [
  ['RAW', 'Raw materials'],
  ['COMP', 'Components'],
  ['FIN', 'Finished goods'],
  ['PACK', 'Packaging'],
  ['SPARE', 'Spare parts'],
  ['CONS', 'Consumables'],
];

const UOMS: readonly (readonly [string, string])[] = [
  ['EA', 'Each'],
  ['BOX', 'Box'],
  ['KG', 'Kilogram'],
  ['L', 'Litre'],
];

/** Bins under each warehouse's storage location. */
const BIN_COUNT = 4;

export interface InventorySeedResult {
  readonly items: number;
  readonly warehouses: number;
  readonly locations: number;
  readonly documents: number;
  readonly movements: number;
  readonly costLayers: number;
  readonly consumptions: number;
  readonly lots: number;
  readonly serials: number;
  readonly onHandRows: number;
  /**
   * Stocked (item, warehouse) positions with open cost layers behind them —
   * the valuation workload's subject, counted from the database rather than
   * assumed from what was just written (F-730/F-811).
   */
  readonly stockedWithLayers: number;
  /** FIFO issue movements with stored consumption rows — the reproduction workload's subject. */
  readonly reproducibleIssues: number;
  readonly elapsedMs: number;
}

interface SeededWarehouse {
  readonly id: string;
  readonly receivingId: string;
  readonly binIds: readonly string[];
}

/** Everything one item contributes, generated in memory and flushed in batches. */
interface Buffers {
  readonly items: unknown[][];
  readonly settings: unknown[][];
  readonly lots: unknown[][];
  readonly documents: unknown[][];
  readonly movements: unknown[][];
  readonly layers: unknown[][];
  readonly consumptions: unknown[][];
  readonly serials: unknown[][];
  readonly onHand: unknown[][];
  postedDocumentIds: string[];
}

const emptyBuffers = (): Buffers => ({
  items: [],
  settings: [],
  lots: [],
  documents: [],
  movements: [],
  layers: [],
  consumptions: [],
  serials: [],
  onHand: [],
  postedDocumentIds: [],
});

export async function seedInventory(
  pool: Pool,
  profile: SeedProfile,
  foundation: Foundation,
  rng: DeterministicRandom,
  onProgress?: (done: number, total: number) => void,
): Promise<InventorySeedResult> {
  const started = Date.now();
  const perEntity = Math.ceil(profile.items / foundation.entities.length);

  const { categoryIds } = await seedReferenceData(pool, foundation, rng);

  const counts = {
    items: 0,
    warehouses: 0,
    locations: 0,
    documents: 0,
    movements: 0,
    costLayers: 0,
    consumptions: 0,
    lots: 0,
    serials: 0,
    onHandRows: 0,
  };
  let done = 0;
  const total = perEntity * foundation.entities.length;

  for (const entity of foundation.entities) {
    const accounts = await controlAccounts(pool, entity);
    const warehouses = await seedWarehouses(pool, foundation, entity, rng);
    counts.warehouses += warehouses.length;
    counts.locations += warehouses.length * (2 + BIN_COUNT);

    let buffers = emptyBuffers();
    let buffered = 0;
    // Per-entity monotone document sequence, so document numbers are unique
    // under inventory_documents_number_uq without coordinating across items.
    const sequence = { value: 0 };

    for (let i = 0; i < perEntity; i++) {
      generateItem(
        buffers,
        foundation,
        entity,
        rng,
        warehouses,
        categoryIds,
        accounts,
        i,
        sequence,
      );
      buffered += 1;

      if (buffered >= ITEMS_PER_FLUSH || i === perEntity - 1) {
        const flushed = await flush(pool, buffers);
        counts.items += flushed.items;
        counts.documents += flushed.documents;
        counts.movements += flushed.movements;
        counts.costLayers += flushed.layers;
        counts.consumptions += flushed.consumptions;
        counts.lots += flushed.lots;
        counts.serials += flushed.serials;
        counts.onHandRows += flushed.onHand;
        done += buffered;
        buffered = 0;
        buffers = emptyBuffers();
        onProgress?.(done, total);
      }
    }
  }

  // F-731: a bulk-loaded table has no planner statistics until autovacuum
  // happens to reach it, and a benchmark against stale statistics measured
  // 22.4ms where the same rows measured 3.8ms analysed. The seeder's global
  // ANALYZE also runs at the end of `bin/seed.ts`, but this stage must not
  // depend on who called it.
  for (const table of [
    'item_categories',
    'units_of_measure',
    'items',
    'item_accounting_settings',
    'warehouses',
    'warehouse_locations',
    'stock_lots',
    'serial_units',
    'inventory_documents',
    'inventory_movements',
    'inventory_cost_layers',
    'inventory_cost_consumptions',
    'inventory_on_hand',
  ]) {
    await pool.query(`ANALYZE ${table}`);
  }

  // What the workloads will actually read, counted rather than assumed — the
  // same reason `seedBanking` reports `unmatchedIncoming`. These predicates are
  // the workload subjects verbatim, scoped to the tenant this run wrote.
  const { rows: stocked } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM inventory_on_hand h
      WHERE h.tenant_id = $1 AND h.quantity > 0
        AND EXISTS (
          SELECT 1 FROM inventory_cost_layers l
           WHERE l.legal_entity_id = h.legal_entity_id AND l.item_id = h.item_id
             AND l.warehouse_id = h.warehouse_id AND l.remaining_quantity > 0)`,
    [foundation.tenantId],
  );
  const { rows: reproducible } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM inventory_movements m
      WHERE m.tenant_id = $1 AND m.quantity < 0 AND m.cost_method = 'FIFO'
        AND EXISTS (
          SELECT 1 FROM inventory_cost_consumptions c
           WHERE c.inventory_movement_id = m.id)`,
    [foundation.tenantId],
  );

  return {
    ...counts,
    stockedWithLayers: Number(stocked[0]?.n ?? 0),
    reproducibleIssues: Number(reproducible[0]?.n ?? 0),
    elapsedMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Reference data, warehouses, accounts
// ---------------------------------------------------------------------------

async function seedReferenceData(
  pool: Pool,
  foundation: Foundation,
  rng: DeterministicRandom,
): Promise<{ categoryIds: readonly string[] }> {
  // Organization-scoped, and UNIQUE (organization_id, code) — so seeded
  // idempotently, like currencies: a `--only inventory` run onto a foundation
  // that already has them must reuse them, not collide.
  const categoryIds: string[] = [];
  for (const [code, name] of CATEGORIES) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO item_categories (id, tenant_id, organization_id, code, name, status)
       VALUES ($1,$2,$3,$4,$5,'ACTIVE')
       ON CONFLICT (organization_id, code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [rng.uuidv7(0), foundation.tenantId, foundation.organizationId, code, name],
    );
    categoryIds.push(rows[0]!.id);
  }
  for (const [code, name] of UOMS) {
    await pool.query(
      `INSERT INTO units_of_measure (id, tenant_id, organization_id, code, name, conversion_factor)
       VALUES ($1,$2,$3,$4,$5,1)
       ON CONFLICT (organization_id, code) DO UPDATE SET name = EXCLUDED.name`,
      [rng.uuidv7(1), foundation.tenantId, foundation.organizationId, code, name],
    );
  }
  return { categoryIds };
}

interface ControlAccounts {
  readonly inventoryAccountId: string;
  readonly cogsAccountId: string;
}

async function controlAccounts(pool: Pool, entity: SeededEntity): Promise<ControlAccounts> {
  // By code rather than from `entity.accounts`: `--only inventory` loads the
  // foundation back from the database, and `loadFoundation` returns an empty
  // account map because only the ledger stage needs it (same as banking).
  const { rows } = await pool.query<{ code: string; id: string }>(
    `SELECT code, id FROM accounts WHERE legal_entity_id = $1 AND code IN ('1200','5000')`,
    [entity.id],
  );
  const byCode = new Map(rows.map((r) => [r.code, r.id]));
  const inventoryAccountId = byCode.get('1200');
  const cogsAccountId = byCode.get('5000');
  if (!inventoryAccountId || !cogsAccountId) {
    throw new Error(
      `entity ${entity.code} is missing account 1200 (Inventory) or 5000 (Cost of goods sold) — ` +
        `the chart of accounts is not the one this seeder expects`,
    );
  }
  return { inventoryAccountId, cogsAccountId };
}

async function seedWarehouses(
  pool: Pool,
  foundation: Foundation,
  entity: SeededEntity,
  rng: DeterministicRandom,
): Promise<readonly SeededWarehouse[]> {
  const epoch = Date.parse(`${entity.periods[0]!.from}T00:00:00Z`);
  const warehouses: SeededWarehouse[] = [];

  for (let w = 0; w < 2; w++) {
    const warehouseId = rng.uuidv7(epoch + w);
    await pool.query(
      `INSERT INTO warehouses (id, tenant_id, legal_entity_id, branch_id, code, name, status)
       VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE')`,
      [
        warehouseId,
        foundation.tenantId,
        entity.id,
        entity.branchId,
        `WH${w + 1}`,
        `${entity.code} warehouse ${w + 1}`,
      ],
    );

    // A small tree per warehouse: receiving dock, a storage zone, and bins
    // under the zone — the parent link exercises wl_parent_scope_fk (0042).
    const receivingId = rng.uuidv7(epoch + w * 100 + 1);
    const storageId = rng.uuidv7(epoch + w * 100 + 2);
    await pool.query(
      `INSERT INTO warehouse_locations
         (id, tenant_id, warehouse_id, legal_entity_id, parent_id, code, name, kind, status)
       VALUES
         ($1,$3,$4,$5,NULL,'RECV','Receiving dock','RECEIVING','ACTIVE'),
         ($2,$3,$4,$5,NULL,'STOR','Storage zone','STORAGE','ACTIVE')`,
      [receivingId, storageId, foundation.tenantId, warehouseId, entity.id],
    );

    const binIds: string[] = [];
    for (let b = 0; b < BIN_COUNT; b++) {
      const binId = rng.uuidv7(epoch + w * 100 + 10 + b);
      binIds.push(binId);
      await pool.query(
        `INSERT INTO warehouse_locations
           (id, tenant_id, warehouse_id, legal_entity_id, parent_id, code, name, kind, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'STORAGE','ACTIVE')`,
        [
          binId,
          foundation.tenantId,
          warehouseId,
          entity.id,
          storageId,
          `BIN-${String(b + 1).padStart(2, '0')}`,
          `Bin ${b + 1}`,
        ],
      );
    }

    warehouses.push({ id: warehouseId, receivingId, binIds });
  }
  return warehouses;
}

// ---------------------------------------------------------------------------
// Per-item generation — the costing script
// ---------------------------------------------------------------------------

interface LayerState {
  readonly id: string;
  readonly receivedDate: string;
  readonly movementId: string;
  readonly originalQuantity: number;
  /** 2-dp string from `rng.amount` — an exact decimal, never a float. */
  readonly unitCost: string;
  remaining: Decimal;
}

function generateItem(
  buffers: Buffers,
  foundation: Foundation,
  entity: SeededEntity,
  rng: DeterministicRandom,
  warehouses: readonly SeededWarehouse[],
  categoryIds: readonly string[],
  accounts: ControlAccounts,
  index: number,
  sequence: { value: number },
): void {
  const periods = entity.periods;
  const epoch = Date.parse(`${periods[0]!.from}T00:00:00Z`);
  const itemId = rng.uuidv7(epoch + index * 1_000);
  const sku = `${entity.code}-SKU-${String(index + 1).padStart(6, '0')}`;

  // The mix the workloads discriminate on: three in five FIFO, the rest
  // weighted-average; roughly a tenth serial-tracked, a fifth lot-tracked.
  const valuation = index % 5 < 3 ? 'FIFO' : 'WEIGHTED_AVERAGE';
  const serialTracked = index % 10 === 7;
  const lotTracked = !serialTracked && index % 4 === 1;
  const uom = serialTracked ? 'EA' : rng.pick(UOMS)[0];
  const warehouse = warehouses[index % warehouses.length]!;
  // One home bin per item: receipts land there, issues draw from there, and
  // the transfer at the end relocates part of the stock to a sibling bin.
  const homeBin = warehouse.binIds[index % warehouse.binIds.length]!;
  const otherBin = warehouse.binIds[(index + 1) % warehouse.binIds.length]!;

  buffers.items.push([
    itemId,
    foundation.tenantId,
    foundation.organizationId,
    categoryIds[index % categoryIds.length]!,
    sku,
    `Seed item ${sku}`,
    'INVENTORY',
    uom,
    valuation,
    lotTracked,
    serialTracked,
  ]);
  buffers.settings.push([
    itemId,
    entity.id,
    foundation.tenantId,
    accounts.inventoryAccountId,
    accounts.cogsAccountId,
  ]);

  const layers: LayerState[] = [];
  const serialIds: string[] = [];
  let waState: WeightedAverageState = { quantity: D('0'), value: Decimal.zero(8) };
  let receivedQuantity = 0;
  let movementCounter = 0;

  const nextId = (date: string): string =>
    rng.uuidv7(Date.parse(`${date}T00:00:00Z`) + index * 1_000 + movementCounter++);

  // --- receipts: 2–4, in strictly ascending periods so the layer order the
  // --- FIFO index declares (received_date, id) is the order they were made in.
  const receipts = 2 + (index % 3);
  for (let r = 0; r < receipts; r++) {
    const period = periods[Math.min(r, periods.length - 1)]!;
    const date = shiftDate(period.from, rng.int(0, 27), period.to);
    const quantity = serialTracked ? rng.int(2, 5) : rng.int(40, 320);
    const unitCost = rng.amount(2, 180);
    receivedQuantity += quantity;

    const documentId = nextId(date);
    const movementId = nextId(date);
    sequence.value += 1;
    buffers.documents.push([
      documentId,
      foundation.tenantId,
      entity.id,
      entity.bookId,
      entity.branchId,
      'RECEIPT',
      `${entity.code}-RCT-${String(sequence.value).padStart(8, '0')}`,
      date,
      date,
      warehouse.id,
      'SEED',
    ]);
    buffers.postedDocumentIds.push(documentId);

    let lotId: string | null = null;
    if (lotTracked) {
      lotId = nextId(date);
      buffers.lots.push([lotId, foundation.tenantId, entity.id, itemId, `${sku}-L${r + 1}`]);
    }

    // Receipt value: quantity × unit cost is exact here (integer × 2 dp), and it
    // is the same number `weightedAverageCost` adds to the running value — so
    // the movement, the layer and the WA state agree to the cent by construction.
    const receiptCost = D(String(quantity)).mul(D(unitCost));
    buffers.movements.push([
      movementId,
      foundation.tenantId,
      entity.id,
      documentId,
      1,
      itemId,
      null,
      homeBin,
      date,
      String(quantity),
      uom,
      lotId,
      unitCost,
      receiptCost.toString(),
      entity.baseCurrency,
      valuation,
    ]);

    const layer: LayerState = {
      id: nextId(date),
      receivedDate: date,
      movementId,
      originalQuantity: quantity,
      unitCost,
      remaining: D(String(quantity)),
    };
    layers.push(layer);

    if (valuation === 'WEIGHTED_AVERAGE') {
      waState = weightedAverageCost(
        waState.quantity,
        waState.value,
        D(String(quantity)),
        D(unitCost),
        entity.baseCurrency,
      );
    }

    if (serialTracked) {
      for (let s = 0; s < quantity; s++) {
        const serialId = nextId(date);
        serialIds.push(serialId);
        buffers.serials.push([
          serialId,
          foundation.tenantId,
          entity.id,
          itemId,
          `${sku}-SN${String(serialIds.length).padStart(5, '0')}`,
          lotId,
          homeBin,
          date,
        ]);
      }
    }
  }

  // --- issues: FIFO items only (see the header for why WA items are not
  // --- issued), never draining below ~30% so every item stays a valuation
  // --- subject. Costs come from consumeFifo — the engine, not arithmetic.
  let issuedQuantity = 0;
  let issuedSerials = 0;
  if (valuation === 'FIFO') {
    const issueCount = rng.int(1, 3);
    const keep = Math.ceil(receivedQuantity * 0.3);
    for (let k = 0; k < issueCount; k++) {
      const available = receivedQuantity - issuedQuantity - keep;
      if (available <= 0) break;
      const quantity = Math.max(
        1,
        Math.min(available, Math.round(available * (0.3 + 0.4 * rng.next()))),
      );
      const period = periods[Math.min(4 + k, periods.length - 1)]!;
      const date = shiftDate(period.from, rng.int(0, 27), period.to);

      const documentId = nextId(date);
      const movementId = nextId(date);
      sequence.value += 1;
      buffers.documents.push([
        documentId,
        foundation.tenantId,
        entity.id,
        entity.bookId,
        entity.branchId,
        'ISSUE',
        `${entity.code}-ISS-${String(sequence.value).padStart(8, '0')}`,
        date,
        date,
        warehouse.id,
        'SEED',
      ]);
      buffers.postedDocumentIds.push(documentId);

      // The real engine, over the layers in the order ADR-0004 §3 fixes —
      // which is the order they were built in above.
      const layerViews: CostLayer[] = layers.map((l) => ({
        id: l.id,
        remainingQuantity: l.remaining,
        unitCost: D(l.unitCost),
      }));
      const result = consumeFifo(layerViews, D(String(quantity)), entity.baseCurrency);

      for (const consumption of result.consumptions) {
        const layer = layers.find((l) => l.id === consumption.layerId)!;
        layer.remaining = layer.remaining.sub(consumption.quantity);
        buffers.consumptions.push([
          nextId(date),
          foundation.tenantId,
          entity.id,
          consumption.layerId,
          movementId,
          consumption.quantity.toString(),
          consumption.unitCost.toString(),
          consumption.cost.toString(),
        ]);
      }

      // total_cost is the engine's sum of the stored rows; unit_cost is left
      // NULL rather than derived by a second rounding decision the engine
      // never made.
      buffers.movements.push([
        movementId,
        foundation.tenantId,
        entity.id,
        documentId,
        1,
        itemId,
        homeBin,
        null,
        date,
        String(-quantity),
        uom,
        null,
        null,
        result.totalCost.toString(),
        entity.baseCurrency,
        'FIFO',
      ]);

      issuedQuantity += quantity;
      if (serialTracked) {
        // FIFO consumes oldest first, and the serials were minted in receipt
        // order, so the next unissued serials are the ones that left.
        for (let s = 0; s < quantity && issuedSerials < serialIds.length; s++) {
          markSerialIssued(buffers, serialIds[issuedSerials]!, date);
          issuedSerials += 1;
        }
      }
    }
  }

  const onHandQuantity = receivedQuantity - issuedQuantity;

  // --- one transfer per third item: two movements netting to zero per item,
  // --- which is what the 0043 deferred trigger asserts at COMMIT. Intra-
  // --- warehouse, so on-hand at warehouse grain is untouched and no cost moves.
  if (index % 3 === 0 && onHandQuantity > 0) {
    const quantity = rng.int(1, Math.min(10, onHandQuantity));
    const period = periods[Math.min(7, periods.length - 1)]!;
    const date = shiftDate(period.from, rng.int(0, 27), period.to);
    const documentId = nextId(date);
    sequence.value += 1;
    buffers.documents.push([
      documentId,
      foundation.tenantId,
      entity.id,
      entity.bookId,
      entity.branchId,
      'TRANSFER',
      `${entity.code}-TRF-${String(sequence.value).padStart(8, '0')}`,
      date,
      date,
      warehouse.id,
      'SEED',
    ]);
    buffers.postedDocumentIds.push(documentId);

    for (const [lineNo, qty, from, to] of [
      [1, -quantity, homeBin, null],
      [2, quantity, null, otherBin],
    ] as const) {
      buffers.movements.push([
        nextId(date),
        foundation.tenantId,
        entity.id,
        documentId,
        lineNo,
        itemId,
        from,
        to,
        date,
        String(qty),
        uom,
        null,
        null,
        null,
        entity.baseCurrency,
        null,
      ]);
    }
  }

  // --- the layers in their final state, and on-hand consistent with them.
  let layerValue = Decimal.zero(8);
  for (const layer of layers) {
    layerValue = layerValue.add(layer.remaining.mul(D(layer.unitCost)));
    buffers.layers.push([
      layer.id,
      foundation.tenantId,
      entity.id,
      entity.bookId,
      itemId,
      warehouse.id,
      layer.movementId,
      layer.receivedDate,
      String(layer.originalQuantity),
      layer.remaining.toString(),
      layer.unitCost,
      entity.baseCurrency,
      layer.remaining.isPositive() ? 'OPEN' : 'CONSUMED',
    ]);
  }

  // FIFO: what the layers hold. WA: the engine's running value — equal to the
  // layer value here by construction, since WA items are never issued.
  const onHandValue = valuation === 'WEIGHTED_AVERAGE' ? waState.value : layerValue;
  buffers.onHand.push([
    foundation.tenantId,
    entity.id,
    itemId,
    warehouse.id,
    String(onHandQuantity),
    onHandValue.toString(),
    entity.baseCurrency,
  ]);
}

/** Rewrites a buffered serial row as ISSUED. The buffer is per-flush, so the row is always present. */
function markSerialIssued(buffers: Buffers, serialId: string, date: string): void {
  const row = buffers.serials.find((s) => s[0] === serialId);
  if (row) {
    row[8] = 'ISSUED';
    row[9] = date;
  }
}

// ---------------------------------------------------------------------------
// Flushing
// ---------------------------------------------------------------------------

async function flush(
  pool: Pool,
  buffers: Buffers,
): Promise<{
  items: number;
  documents: number;
  movements: number;
  layers: number;
  consumptions: number;
  lots: number;
  serials: number;
  onHand: number;
}> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await insertChunked(
      client,
      `INSERT INTO items
         (id, tenant_id, organization_id, item_category_id, sku, name, kind, base_uom,
          valuation, lot_tracking, serial_tracking, status)`,
      (p) =>
        `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)}::item_type,${p(8)},` +
        `${p(9)}::valuation_method,${p(10)},${p(11)},'ACTIVE')`,
      buffers.items,
    );
    await insertChunked(
      client,
      `INSERT INTO item_accounting_settings
         (item_id, legal_entity_id, tenant_id, inventory_account_id, cogs_account_id)`,
      (p) => `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)})`,
      buffers.settings,
    );
    await insertChunked(
      client,
      `INSERT INTO stock_lots (id, tenant_id, legal_entity_id, item_id, lot_number, status)`,
      (p) => `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},'ACTIVE')`,
      buffers.lots,
    );
    // DRAFT first; POSTED below, after the movements — 0043's
    // guard_posted_document_lines refuses a movement INSERT under a POSTED
    // header, exactly as invoice posting has since 0036.
    await insertChunked(
      client,
      `INSERT INTO inventory_documents
         (id, tenant_id, legal_entity_id, accounting_book_id, branch_id, document_type,
          document_number, document_date, posting_date, status, warehouse_id, source_type)`,
      (p) =>
        `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)}::inventory_doc_type,${p(7)},` +
        `${p(8)},${p(9)},'DRAFT',${p(10)},${p(11)})`,
      buffers.documents,
    );
    await insertChunked(
      client,
      `INSERT INTO inventory_movements
         (id, tenant_id, legal_entity_id, inventory_document_id, line_no, item_id,
          from_location_id, to_location_id, movement_date, quantity, uom, stock_lot_id,
          unit_cost, total_cost, currency, cost_method)`,
      (p) =>
        `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},` +
        `${p(11)},${p(12)},${p(13)},${p(14)},${p(15)},${p(16)}::valuation_method)`,
      buffers.movements,
    );
    await insertChunked(
      client,
      `INSERT INTO inventory_cost_layers
         (id, tenant_id, legal_entity_id, accounting_book_id, item_id, warehouse_id,
          source_movement_id, received_date, original_quantity, remaining_quantity,
          unit_cost, currency, status)`,
      (p) =>
        `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)},${p(9)},${p(10)},` +
        `${p(11)},${p(12)},${p(13)}::cost_layer_status)`,
      buffers.layers,
    );
    await insertChunked(
      client,
      `INSERT INTO inventory_cost_consumptions
         (id, tenant_id, legal_entity_id, cost_layer_id, inventory_movement_id,
          quantity, unit_cost, total_cost)`,
      (p) => `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)})`,
      buffers.consumptions,
    );
    await insertChunked(
      client,
      `INSERT INTO serial_units
         (id, tenant_id, legal_entity_id, item_id, serial_number, stock_lot_id,
          current_location_id, received_at, state, issued_at)`,
      (p) =>
        `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)},${p(8)}::date,` +
        `${p(9)},${p(10)}::date)`,
      buffers.serials.map((s) => (s.length === 8 ? [...s, 'IN_STOCK', null] : s)),
    );
    await insertChunked(
      client,
      `INSERT INTO inventory_on_hand
         (tenant_id, legal_entity_id, item_id, warehouse_id, quantity, value, currency)`,
      (p) => `(${p(1)},${p(2)},${p(3)},${p(4)},${p(5)},${p(6)},${p(7)})`,
      buffers.onHand,
    );

    // Movements and costs are in; the documents become accounting facts.
    // 0043 freezes them from here on, and the deferred TRANSFER balance
    // trigger checks its net-zero-per-item assertion at the COMMIT below.
    for (let start = 0; start < buffers.postedDocumentIds.length; start += ROWS_PER_INSERT) {
      await client.query(
        `UPDATE inventory_documents SET status = 'POSTED' WHERE id = ANY($1::uuid[])`,
        [buffers.postedDocumentIds.slice(start, start + ROWS_PER_INSERT)],
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  return {
    items: buffers.items.length,
    documents: buffers.documents.length,
    movements: buffers.movements.length,
    layers: buffers.layers.length,
    consumptions: buffers.consumptions.length,
    lots: buffers.lots.length,
    serials: buffers.serials.length,
    onHand: buffers.onHand.length,
  };
}

async function insertChunked(
  client: PoolClient,
  head: string,
  row: (p: (k: number) => string) => string,
  rows: readonly unknown[][],
): Promise<void> {
  for (let start = 0; start < rows.length; start += ROWS_PER_INSERT) {
    const slice = rows.slice(start, start + ROWS_PER_INSERT);
    if (slice.length === 0) return;
    const values: unknown[] = [];
    const fragments: string[] = [];
    for (const r of slice) {
      const base = values.length;
      fragments.push(row((k) => `$${base + k}`));
      values.push(...r);
    }
    await client.query(`${head} VALUES ${fragments.join(',')}`, values);
  }
}

// ---------------------------------------------------------------------------
// Dates — the same helpers banking uses, kept local like banking keeps them
// ---------------------------------------------------------------------------

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Adds days without leaving the period, so every date sits in a seeded window. */
function shiftDate(from: string, days: number, to: string): string {
  const candidate = addDays(from, days);
  return candidate > to ? to : candidate;
}
