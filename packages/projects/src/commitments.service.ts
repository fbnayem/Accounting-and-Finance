import { Pool, PoolClient } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  D,
  MONEY_SCALE,
  relieveCommitment,
  assertEntityPermission,
  type CommitmentStatus,
  type RequestContext,
  type TenantPrincipal,
} from '@acct/domain';
import { writeInTenant, recordAudit } from '@acct/database';
import { BudgetControlService, type BudgetControlResult } from './budget-control.service';

/**
 * Commitments — the substrate budget control stands on (F-106: before this
 * table existed, doc 10's block/warn/override policy could only ever have been
 * advisory).
 *
 * Two movements, matching doc 10's acceptance criteria exactly:
 *
 *   - Approving a purchase order COMMITS its lines against the budget.
 *   - "Closing/canceling PO releases unused commitment" — and billing against
 *     a PO line relieves what the bill consumed, so the same taka is never
 *     counted once as commitment and again as actual.
 *
 * The arithmetic and the refusals (over-relief, relieving a closed commitment)
 * live in @acct/domain's `relieveCommitment`, so the database CHECKs are the
 * second line of defence, not the error message.
 *
 * No route creates or releases a commitment directly: both are consequences of
 * what happens to the purchase order, so both are exposed as
 * `...InTransaction` methods for the procurement paths to call, plus
 * pool-wrapped forms for wiring where no transaction exists yet.
 *
 * BudgetControlService is a constructor dependency rather than something the
 * caller invokes beforehand, and that is the whole of F-106's second half. The
 * check has to run against the same (period, account) the commitment is about to
 * be written to, on the same connection, inside the same transaction — so that
 * the verdict and the encumbrance it authorises commit or roll back together,
 * and so that two approvals racing for the last of a budget line serialize on
 * the row locks this transaction already holds. A caller that checked first and
 * committed afterwards would be running a report, not a control.
 */

interface CommitmentRow {
  id: string;
  legal_entity_id: string;
  committed_amount: string;
  relieved_amount: string;
  open_amount: string;
  status: string;
  source_id: string;
  source_line_id: string | null;
  account_id: string;
  currency: string;
}

const COMMITMENT_RETURNING = `id, legal_entity_id, accounting_book_id, accounting_period_id,
  account_id, source_type, source_id, source_line_id, currency,
  committed_amount::text AS committed_amount, relieved_amount::text AS relieved_amount,
  open_amount::text AS open_amount, status::text AS status, created_at`;

export class CommitmentsService {
  constructor(
    private readonly pool: Pool,
    private readonly budgetControl: BudgetControlService,
  ) {}

  async commitPurchaseOrder(
    principal: TenantPrincipal,
    input: { purchaseOrderId: string; accountingBookId: string },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) =>
      this.commitPurchaseOrderInTransaction(client, context, principal, input),
    );
  }

  /**
   * Checks each PO line against doc 10's budget control and, if every line is
   * allowed, creates one commitment per line in the period the goods are
   * expected.
   *
   * Guarded by `purchase_order.approve`: the contract declares no commitment
   * permission of its own, and the one mutation that legitimately encumbers a
   * budget is the approval that authorizes the spend.
   *
   * Check and write are interleaved line by line rather than run as two passes,
   * because the second line of an order must see the first line's encumbrance.
   * Two passes would let a single order approve twice the budget it has: each
   * line individually fits, and together they do not — the same failure mode
   * `validateAllocations` exists to prevent on the settlement side.
   */
  async commitPurchaseOrderInTransaction(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    input: { purchaseOrderId: string; accountingBookId: string },
  ) {
    const po = await loadPurchaseOrder(client, input.purchaseOrderId);
    assertEntityPermission(principal, 'purchase_order.approve', po.legal_entity_id);

    if (['CANCELLED', 'CLOSED', 'COMPLETED'].includes(po.status)) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Purchase order ${po.po_number ?? po.id} is ${po.status}; a finished order commits nothing.`,
      );
    }

    // Idempotent by source: an approval retried after a timeout must find its
    // commitments already written and do nothing, not encumber the budget twice.
    const { rows: existing } = await client.query<CommitmentRow>(
      `SELECT ${COMMITMENT_RETURNING} FROM commitments
        WHERE source_type = 'PURCHASE_ORDER' AND source_id = $1 AND status <> 'CANCELLED'
        ORDER BY created_at`,
      [input.purchaseOrderId],
    );
    if (existing.length > 0) {
      // Deliberately before the budget check as well as before the write: a
      // retried approval must not be refused by the very commitment its first
      // attempt created. Re-checking here would make an at-budget order fail on
      // the retry of its own success.
      return { data: existing, already_committed: true, budget: [] as BudgetControlResult[] };
    }

    const { rows: lines } = await client.query<{
      id: string;
      line_no: number;
      destination_account_id: string | null;
      net_amount: string;
    }>(
      `SELECT id, line_no, destination_account_id, net_amount::text AS net_amount
         FROM purchase_order_lines WHERE purchase_order_id = $1 ORDER BY line_no`,
      [input.purchaseOrderId],
    );
    if (lines.length === 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Purchase order ${po.po_number ?? po.id} has no lines to commit.`,
      );
    }
    const unaccounted = lines.filter((l) => !l.destination_account_id);
    if (unaccounted.length > 0) {
      // A commitment without the account the eventual bill will hit encumbers
      // the wrong budget line, which is worse than encumbering none: it makes
      // the control look engaged while the real spend passes unchecked.
      throw new AppError(
        'VALIDATION_FAILED',
        `PO line(s) ${unaccounted.map((l) => l.line_no).join(', ')} have no destination ` +
          'account; a commitment must name the account the spend will land on.',
        { details: { purchase_order_line_ids: unaccounted.map((l) => l.id) } },
      );
    }

    // The period the spend belongs to: when the goods are expected, falling
    // back to the order date. Adjustment periods are excluded — they overlap by
    // design, and an encumbrance does not belong in period 13.
    const commitmentDate = po.expected_date ?? po.document_date;
    const { rows: periods } = await client.query<{ id: string }>(
      `SELECT id FROM accounting_periods
        WHERE legal_entity_id = $1 AND $2::date BETWEEN start_date AND end_date
          AND NOT is_adjustment`,
      [po.legal_entity_id, commitmentDate],
    );
    const period = periods[0];
    if (!period) {
      throw new AppError(
        'NO_PERIOD_FOR_DATE',
        `No accounting period covers ${commitmentDate}, so there is no budget cell to commit ` +
          'against. Create the fiscal calendar first.',
      );
    }

    const created: CommitmentRow[] = [];
    const budget: BudgetControlResult[] = [];
    for (const line of lines) {
      const amount = D(line.net_amount).rescale(MONEY_SCALE);
      // Zero-value lines commit nothing, and a zero commitment could never be
      // relieved (relief must be positive) — it would sit OPEN forever. Checked
      // before the budget call too: a proposed spend of zero against a line
      // already over budget is "over budget" arithmetically, and refusing an
      // approval that spends nothing would be a control refusing its own null
      // case.
      if (amount.isZero()) continue;

      // The enforcement. BLOCK throws VALIDATION_FAILED, REQUIRE_OVERRIDE throws
      // APPROVAL_REQUIRED, and both messages carry every term of doc 10's
      // formula — `AppError.details` is log-only, so a caller who has to act on
      // the refusal can only read the numbers if the message states them.
      budget.push(
        await this.budgetControl.assertSpendAllowed(client, principal, {
          legalEntityId: po.legal_entity_id,
          accountingBookId: input.accountingBookId,
          accountingPeriodId: period.id,
          accountId: line.destination_account_id!,
          amount: amount.toFixed(MONEY_SCALE),
        }),
      );

      const { rows } = await client.query<CommitmentRow>(
        `INSERT INTO commitments
           (id, tenant_id, legal_entity_id, accounting_book_id, accounting_period_id, account_id,
            source_type, source_id, source_line_id, currency,
            committed_amount, relieved_amount, open_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,'PURCHASE_ORDER',$7,$8,$9,$10::numeric,0,$10::numeric,'OPEN')
         RETURNING ${COMMITMENT_RETURNING}`,
        [
          uuidv7(),
          principal.tenantId,
          po.legal_entity_id,
          input.accountingBookId,
          period.id,
          line.destination_account_id,
          input.purchaseOrderId,
          line.id,
          po.currency,
          // Net of tax: recoverable tax is a receivable, not spend, and the
          // pending-approved-spend term of doc 10's formula reads net too — the
          // consumption terms must measure the same thing.
          amount.toFixed(MONEY_SCALE),
        ],
      );
      created.push(rows[0]!);
    }

    await recordAudit(client, context, {
      tenantId: principal.tenantId,
      action: 'commitment.created',
      resourceType: 'purchase_order',
      resourceId: input.purchaseOrderId,
      after: { commitments: created },
    });

    // The verdicts travel back with the commitments so the approving route can
    // surface a WARN. A WARN that only ever reached a log is doc 10's warn
    // policy implemented as an INFORMATIONAL one.
    return { data: created, already_committed: false, budget };
  }

  async releasePurchaseOrder(
    principal: TenantPrincipal,
    input: { purchaseOrderId: string; reason?: string | undefined },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) =>
      this.releasePurchaseOrderInTransaction(client, context, principal, input),
    );
  }

  /**
   * doc 10 acceptance, verbatim: "Closing/canceling PO releases unused
   * commitment." Everything still open on the order's commitments is relieved;
   * what bills already consumed stays relieved-by-bill and is not touched.
   */
  async releasePurchaseOrderInTransaction(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    input: { purchaseOrderId: string; reason?: string | undefined },
  ) {
    const po = await loadPurchaseOrder(client, input.purchaseOrderId);
    assertEntityPermission(principal, 'purchase_order.approve', po.legal_entity_id);

    const { rows: open } = await client.query<CommitmentRow>(
      `SELECT ${COMMITMENT_RETURNING} FROM commitments
        WHERE source_type = 'PURCHASE_ORDER' AND source_id = $1
          AND status IN ('OPEN','PARTIALLY_RELIEVED')
        ORDER BY created_at
        FOR UPDATE`,
      [input.purchaseOrderId],
    );

    const released: CommitmentRow[] = [];
    for (const row of open) {
      const relieved = relieveCommitment(
        {
          id: row.id,
          committedAmount: D(row.committed_amount),
          relievedAmount: D(row.relieved_amount),
          status: row.status as CommitmentStatus,
        },
        D(row.open_amount),
      );
      const { rows } = await client.query<CommitmentRow>(
        `UPDATE commitments
            SET relieved_amount = $2::numeric, open_amount = $3::numeric, status = $4
          WHERE id = $1
        RETURNING ${COMMITMENT_RETURNING}`,
        [
          row.id,
          relieved.relievedAmount.toFixed(MONEY_SCALE),
          relieved.openAmount.toFixed(MONEY_SCALE),
          relieved.status,
        ],
      );
      released.push(rows[0]!);
    }

    await recordAudit(client, context, {
      tenantId: principal.tenantId,
      action: 'commitment.released',
      resourceType: 'purchase_order',
      resourceId: input.purchaseOrderId,
      after: { commitments: released },
      reason: input.reason ?? null,
    });

    // Releasing an already-released order relieves nothing and is not an error:
    // close-then-cancel must not fail on the cancel.
    return { data: released };
  }

  /**
   * The billing side of relief, for the vendor-bill posting path: what a bill
   * consumed against a PO line stops being commitment the moment it becomes
   * pending/actual spend, or doc 10's formula counts it twice.
   *
   * Capped at the open amount rather than refused: a bill priced above what
   * remains committed consumes the whole commitment, and the excess is ordinary
   * uncommitted spend — a fact about the bill, not an error in it. No
   * permission is asserted here; the posting path that calls this has already
   * asserted its own, and relief is bookkeeping consequent to that decision.
   * Returns null when the line was never committed, which is legal — commitment
   * accounting is optional per doc 10.
   */
  async relieveForPurchaseOrderLineInTransaction(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    input: { purchaseOrderLineId: string; amount: string },
  ) {
    const { rows } = await client.query<CommitmentRow>(
      `SELECT ${COMMITMENT_RETURNING} FROM commitments
        WHERE source_type = 'PURCHASE_ORDER' AND source_line_id = $1
          AND status IN ('OPEN','PARTIALLY_RELIEVED')
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE`,
      [input.purchaseOrderLineId],
    );
    const row = rows[0];
    if (!row) return null;

    const open = D(row.open_amount);
    const requested = D(input.amount);
    const relief = requested.gt(open) ? open : requested;
    if (!relief.isPositive()) return null;

    const relieved = relieveCommitment(
      {
        id: row.id,
        committedAmount: D(row.committed_amount),
        relievedAmount: D(row.relieved_amount),
        status: row.status as CommitmentStatus,
      },
      relief,
    );
    const { rows: updated } = await client.query<CommitmentRow>(
      `UPDATE commitments
          SET relieved_amount = $2::numeric, open_amount = $3::numeric, status = $4
        WHERE id = $1
      RETURNING ${COMMITMENT_RETURNING}`,
      [
        row.id,
        relieved.relievedAmount.toFixed(MONEY_SCALE),
        relieved.openAmount.toFixed(MONEY_SCALE),
        relieved.status,
      ],
    );

    await recordAudit(client, context, {
      tenantId: principal.tenantId,
      action: 'commitment.relieved',
      resourceType: 'commitment',
      resourceId: row.id,
      before: row as unknown as Record<string, unknown>,
      after: updated[0] as unknown as Record<string, unknown>,
    });

    return updated[0];
  }
}

/** Locked, because commit and release racing each other must serialize. */
async function loadPurchaseOrder(client: PoolClient, id: string) {
  const { rows } = await client.query<{
    id: string;
    legal_entity_id: string;
    po_number: string | null;
    status: string;
    currency: string;
    document_date: string;
    expected_date: string | null;
  }>(
    `SELECT id, legal_entity_id, po_number, status::text AS status, currency,
            document_date::text AS document_date, expected_date::text AS expected_date
       FROM purchase_orders WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!rows[0]) throw notFound('purchase_order', id);
  return rows[0];
}
