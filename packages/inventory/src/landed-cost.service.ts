import { Pool } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  D,
  Decimal,
  MONEY_SCALE,
  assertEntityPermission,
  allocateLandedCost,
  currencyPrecision,
  type LandedCostBasis,
  type TenantPrincipal,
  type DraftLineInput,
} from '@acct/domain';
import { writeInTenant, recordAudit, publish } from '@acct/database';
import { PostingService } from '@acct/ledger';
import { DocumentPostingService } from '@acct/subledger';
import { loadItemContexts, requireItemAccount } from './lookup';

/**
 * Landed cost — doc 08 "Landed cost": freight, insurance, duty, handling,
 * allocated to cost layers and capitalised.
 *
 * The allocation arithmetic is `allocateLandedCost` in @acct/domain; the
 * database trigger `assert_landed_cost_fully_allocated` (0012) re-asserts at
 * commit that the parts sum exactly to the document amount, so a drifted
 * allocation cannot reach POSTED even if this service regresses.
 *
 * Cost layers are immutable in `unit_cost` (0043), so the landed value does not
 * rewrite the layer — it lives in `landed_cost_allocations`, split between the
 * quantity still on hand (capitalised, Dr Inventory) and the quantity already
 * issued (`cogs_adjustment`, Dr COGS — doc 08: "late landed cost must adjust
 * remaining inventory and COGS for already-issued quantity"). The valuation
 * report reads the on-hand part back; see reports.service.ts.
 */

const CHARGE_TYPES = new Set(['FREIGHT', 'INSURANCE', 'DUTY', 'HANDLING', 'OTHER']);
const BASES = new Set(['VALUE', 'QUANTITY', 'WEIGHT', 'VOLUME', 'MANUAL']);

export class LandedCostService {
  constructor(
    private readonly pool: Pool,
    private readonly posting: PostingService,
    private readonly documents: DocumentPostingService,
  ) {}

  async createLandedCost(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      postingDate: string;
      chargeType: string;
      allocationBasis: string;
      amount: string;
      /** The credit side: landed cost clearing or AP accrual, per the catalog. */
      clearingAccountId: string;
      vendorBillId?: string | null | undefined;
      documentNumber?: string | null | undefined;
      targets: readonly {
        costLayerId: string;
        weight?: string | undefined;
        volume?: string | undefined;
        manualAmount?: string | undefined;
      }[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      assertEntityPermission(principal, 'inventory.adjust', book.legalEntityId);

      if (!CHARGE_TYPES.has(input.chargeType)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${input.chargeType}" is not a landed cost charge type. doc 08 names: ` +
            `${[...CHARGE_TYPES].join(', ')}.`,
        );
      }
      if (!BASES.has(input.allocationBasis)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${input.allocationBasis}" is not an allocation basis. doc 08 names: ` +
            `${[...BASES].join(', ')}.`,
        );
      }
      if (input.targets.length === 0) {
        throw new AppError('VALIDATION_FAILED', 'A landed cost with no targets allocates nothing.');
      }

      // Locked: the remaining/original split below decides how much of the
      // charge is inventory and how much is COGS, and a concurrent issue moving
      // that boundary mid-calculation would make the split wrong the moment it
      // was written.
      const { rows: layers } = await client.query<{
        id: string;
        item_id: string;
        legal_entity_id: string;
        original_quantity: string;
        remaining_quantity: string;
        unit_cost: string;
        source_movement_id: string;
      }>(
        `SELECT id, item_id, legal_entity_id, original_quantity::text AS original_quantity,
                remaining_quantity::text AS remaining_quantity, unit_cost::text AS unit_cost,
                source_movement_id
           FROM inventory_cost_layers
          WHERE id = ANY($1::uuid[]) AND accounting_book_id = $2
          ORDER BY received_date, id
          FOR UPDATE`,
        [input.targets.map((t) => t.costLayerId), book.bookId],
      );
      const byId = new Map(layers.map((l) => [l.id, l]));
      for (const target of input.targets) {
        if (!byId.has(target.costLayerId))
          throw notFound('inventory_cost_layer', target.costLayerId);
      }

      const precision = currencyPrecision(book.baseCurrency);
      const allocations = allocateLandedCost(
        input.allocationBasis as LandedCostBasis,
        input.targets.map((target) => {
          const layer = byId.get(target.costLayerId)!;
          return {
            id: target.costLayerId,
            value: D(layer.original_quantity).mul(D(layer.unit_cost)),
            quantity: D(layer.original_quantity),
            ...(target.weight !== undefined ? { weight: D(target.weight) } : {}),
            ...(target.volume !== undefined ? { volume: D(target.volume) } : {}),
            ...(target.manualAmount !== undefined ? { manualAmount: D(target.manualAmount) } : {}),
          };
        }),
        D(input.amount),
        precision,
      );

      const id = uuidv7();
      await client.query(
        `INSERT INTO landed_costs
           (id, tenant_id, legal_entity_id, accounting_book_id, document_number, posting_date,
            charge_type, allocation_basis, currency, amount, vendor_bill_id, status)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10::numeric,$11,'DRAFT')`,
        [
          id,
          principal.tenantId,
          book.legalEntityId,
          book.bookId,
          input.documentNumber ?? null,
          input.postingDate,
          input.chargeType,
          input.allocationBasis,
          book.baseCurrency,
          input.amount,
          input.vendorBillId ?? null,
        ],
      );

      const items = await loadItemContexts(
        client,
        layers.map((l) => l.item_id),
        book.legalEntityId,
      );

      const lines: DraftLineInput[] = [];
      const written = [];
      let total = Decimal.zero(MONEY_SCALE);
      for (const allocation of allocations) {
        const layer = byId.get(allocation.targetId)!;
        const item = items.get(layer.item_id)!;

        // The already-issued fraction of the layer takes its share of the
        // charge to COGS immediately: the stock it belongs to has been sold,
        // and capitalising its freight into a layer it already left would
        // overstate what remains. Rounded at the minor unit; the on-hand part
        // is the exact difference so the two always sum to the allocation.
        const original = D(layer.original_quantity);
        const issued = original.sub(D(layer.remaining_quantity));
        const cogsAdjustment = issued.isZero()
          ? Decimal.zero(MONEY_SCALE)
          : allocation.amount
              .mul(issued)
              .div(original, precision.minorUnit, book.roundingMode)
              .rescale(MONEY_SCALE);
        const capitalised = allocation.amount.sub(cogsAdjustment);

        const { rows: created } = await client.query<Record<string, unknown>>(
          `INSERT INTO landed_cost_allocations
             (id, tenant_id, legal_entity_id, landed_cost_id, cost_layer_id,
              inventory_movement_id, allocated_amount, cogs_adjustment)
           VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8::numeric)
           RETURNING id, cost_layer_id, inventory_movement_id,
                     allocated_amount::text AS allocated_amount,
                     cogs_adjustment::text AS cogs_adjustment`,
          [
            uuidv7(),
            principal.tenantId,
            book.legalEntityId,
            id,
            layer.id,
            layer.source_movement_id,
            allocation.amount.toString(),
            cogsAdjustment.toString(),
          ],
        );
        written.push(created[0]);
        total = total.add(allocation.amount);

        if (!capitalised.isZero()) {
          lines.push({
            accountId: requireItemAccount(item, 'inventoryAccountId'),
            description: `${input.chargeType} capitalised into ${item.sku}`,
            debit: capitalised.toString(),
          });
        }
        if (!cogsAdjustment.isZero()) {
          lines.push({
            accountId: requireItemAccount(item, 'cogsAccountId'),
            description: `${input.chargeType} on already-issued ${item.sku}`,
            debit: cogsAdjustment.toString(),
          });
        }
      }
      lines.push({
        accountId: input.clearingAccountId,
        description: `${input.chargeType} landed cost`,
        credit: total.toString(),
      });

      const result = await this.documents.post(client, context, principal, book, {
        ruleCode: 'LANDED_COST_CAPITALIZED',
        sourceType: 'landed_cost',
        sourceId: id,
        sourceEventId: `inventory.landed_cost_allocated:${id}`,
        journalCode: 'PUR',
        postingDate: input.postingDate,
        documentDate: input.postingDate,
        description: `Landed cost ${input.chargeType} ${input.documentNumber ?? ''}`.trim(),
        branchId: null,
        contactId: null,
        lines,
      });

      const { rows: posted } = await client.query<Record<string, unknown>>(
        `UPDATE landed_costs SET status = 'POSTED', accounting_entry_id = $2
          WHERE id = $1
        RETURNING id, legal_entity_id, document_number, posting_date::text AS posting_date,
                  charge_type, allocation_basis, currency, amount::text AS amount,
                  vendor_bill_id, status::text AS status, accounting_entry_id`,
        [id, result.entry.id],
      );

      await publish(client, context, {
        eventType: 'inventory.landed_cost_allocated',
        aggregateType: 'landed_cost',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: book.legalEntityId,
        accountingBookId: book.bookId,
        payload: {
          amount: input.amount,
          charge_type: input.chargeType,
          journal_entry_id: result.entry.id,
        },
      });

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: book.legalEntityId,
        action: 'inventory.landed_cost_allocated',
        resourceType: 'landed_cost',
        resourceId: id,
        after: { ...(posted[0] as Record<string, unknown>), allocations: written },
      });

      return { ...posted[0], allocations: written, journal_entry_id: result.entry.id };
    });
  }
}
