import { PoolClient } from 'pg';
import {
  AppError,
  Money,
  D,
  uuidv7,
  realizedFx,
  type TenantPrincipal,
  type DraftLineInput,
} from '@acct/domain';

/**
 * The allocation protocol — ADR-0004 §2, and the thing Gate G tests hardest.
 *
 * doc 04 states it as an obligation: "Allocation is transaction-safe; concurrent
 * allocation cannot overpay an invoice or consume the same available receipt
 * twice." doc 05 says the same for payments. Two transactions each reading
 * `amount_due = 100` and each allocating 100 is the failure, and it is not
 * hypothetical — it is the default behaviour of the obvious implementation.
 *
 * Three layers, and all three are load-bearing:
 *
 *   1. Locks, here. The source document first, then the targets in ascending id
 *      order. Ascending order is what makes two allocations touching the same
 *      pair of invoices deadlock-free rather than deadlock-prone.
 *   2. Persisted balances with CHECK constraints, in the schema. A SUM() over a
 *      detail table cannot be defended by a constraint; a stored column can.
 *   3. Deferred triggers asserting the totals at COMMIT, in the schema. The
 *      backstop for anything that reaches the tables another way.
 *
 * Layer 1 alone is a race waiting for a second code path. Layer 2 alone permits
 * a lost update. This file is layer 1 and it assumes the other two exist.
 */

export type AllocationTargetKind = 'INVOICE' | 'CREDIT_NOTE' | 'VENDOR_BILL' | 'VENDOR_CREDIT';

export interface AllocationRequest {
  readonly targetType: AllocationTargetKind;
  readonly targetId: string;
  readonly amount: string;
}

export interface AllocationTarget {
  readonly id: string;
  readonly kind: AllocationTargetKind;
  readonly amountDue: string;
  readonly total: string;
  readonly currency: string;
  readonly exchangeRate: string | null;
  readonly legalEntityId: string;
  readonly status: string;
}

const TARGET_TABLES: Record<AllocationTargetKind, { table: string; open: string }> = {
  INVOICE: { table: 'invoices', open: 'amount_due' },
  CREDIT_NOTE: { table: 'credit_notes', open: 'amount_available' },
  VENDOR_BILL: { table: 'vendor_bills', open: 'amount_due' },
  VENDOR_CREDIT: { table: 'vendor_credits', open: 'amount_available' },
};

/**
 * Locks the requested targets in ascending id order and returns their current
 * open amounts.
 *
 * The sort is the deadlock protection and it has to happen across ALL targets,
 * not per table: two concurrent allocations that each touch an invoice and a
 * credit note in opposite orders deadlock exactly as readily as two touching two
 * invoices. Sorting by id alone puts every transaction in the same sequence
 * regardless of which tables it visits.
 */
export async function lockTargets(
  client: PoolClient,
  principal: TenantPrincipal,
  requests: readonly AllocationRequest[],
): Promise<Map<string, AllocationTarget>> {
  const ordered = [...requests].sort((a, b) => (a.targetId < b.targetId ? -1 : 1));
  const targets = new Map<string, AllocationTarget>();

  for (const request of ordered) {
    const spec = TARGET_TABLES[request.targetType];
    if (!spec) {
      throw new AppError('VALIDATION_FAILED', `Unknown allocation target ${request.targetType}.`);
    }
    const { rows } = await client.query<{
      id: string;
      open_amount: string;
      total: string;
      currency: string;
      exchange_rate: string | null;
      legal_entity_id: string;
      status: string;
    }>(
      `SELECT id, ${spec.open}::text AS open_amount, total::text AS total, currency,
              exchange_rate::text AS exchange_rate, legal_entity_id, status::text AS status
         FROM ${spec.table}
        WHERE id = $1 AND tenant_id = $2
        FOR UPDATE`,
      [request.targetId, principal.tenantId],
    );
    const row = rows[0];
    if (!row) {
      // Not "not found for this tenant" — the tenant is already the only thing
      // this query can see, and saying more would confirm the id exists.
      throw new AppError(
        'NOT_FOUND',
        `${request.targetType.toLowerCase().replace('_', ' ')} ${request.targetId} does not exist.`,
      );
    }
    targets.set(request.targetId, {
      id: row.id,
      kind: request.targetType,
      amountDue: row.open_amount,
      total: row.total,
      currency: row.currency,
      exchangeRate: row.exchange_rate,
      legalEntityId: row.legal_entity_id,
      status: row.status,
    });
  }
  return targets;
}

/**
 * Validates a set of allocations against the locked targets and the source's
 * unapplied amount.
 *
 * Every rejection names the number that failed. "Over-allocated" tells the
 * person nothing; "allocating 120.00 to INV-4 which has 80.00 outstanding"
 * tells them what to type instead.
 */
export function validateAllocations(input: {
  readonly sourceUnapplied: string;
  readonly sourceCurrency: string;
  readonly requests: readonly AllocationRequest[];
  readonly targets: ReadonlyMap<string, AllocationTarget>;
  readonly documentLabel: (target: AllocationTarget) => string;
}): void {
  const problems: string[] = [];
  const perTarget = new Map<string, Money>();

  for (const request of input.requests) {
    const amount = Money.of(D(request.amount), input.sourceCurrency);
    if (!amount.isPositive()) {
      problems.push(`An allocation of ${request.amount} is not positive.`);
      continue;
    }
    const target = input.targets.get(request.targetId);
    if (!target) continue;

    if (target.currency !== input.sourceCurrency) {
      problems.push(
        `${input.documentLabel(target)} is in ${target.currency} and the payment is in ` +
          `${input.sourceCurrency}. Cross-currency allocation needs the settlement rate, which ` +
          'this request does not carry.',
      );
      continue;
    }
    if (!['POSTED', 'PARTIALLY_PAID'].includes(target.status)) {
      problems.push(
        `${input.documentLabel(target)} is ${target.status}; only a posted document has a ` +
          'balance to allocate against.',
      );
      continue;
    }

    const running = (perTarget.get(request.targetId) ?? Money.zero(input.sourceCurrency)).add(
      amount,
    );
    perTarget.set(request.targetId, running);

    const due = Money.of(D(target.amountDue), input.sourceCurrency);
    if (running.gt(due)) {
      problems.push(
        `Allocating ${running.toString()} to ${input.documentLabel(target)}, which has ` +
          `${due.toString()} outstanding.`,
      );
    }
  }

  const total = input.requests.reduce(
    (a, r) => a.add(Money.of(D(r.amount), input.sourceCurrency)),
    Money.zero(input.sourceCurrency),
  );
  const available = Money.of(D(input.sourceUnapplied), input.sourceCurrency);
  if (total.gt(available)) {
    problems.push(
      `The allocations total ${total.toString()} but only ${available.toString()} is unapplied.`,
    );
  }

  if (problems.length > 0) {
    throw new AppError('OVER_ALLOCATION', `This allocation was refused. ${problems.join(' ')}`, {
      details: { problems },
    });
  }
}

/**
 * Applies one allocation to its target: reduces the open balance and moves the
 * document's status when it reaches zero.
 *
 * The status transition is here rather than in a trigger because PAID is a
 * business fact with an event attached, and a trigger cannot publish one without
 * becoming a second place where domain logic lives.
 */
export async function applyToTarget(
  client: PoolClient,
  target: AllocationTarget,
  amount: string,
  column: 'amount_paid' | 'amount_credited' | 'amount_written_off',
): Promise<{ status: string; amountDue: string; settled: boolean }> {
  const spec = TARGET_TABLES[target.kind];
  const isCredit = target.kind === 'CREDIT_NOTE' || target.kind === 'VENDOR_CREDIT';

  if (isCredit) {
    const { rows } = await client.query<{ amount_available: string; amount_applied: string }>(
      `UPDATE ${spec.table}
          SET amount_applied  = amount_applied + $2::numeric,
              amount_available = total - (amount_applied + $2::numeric)
        WHERE id = $1
        RETURNING amount_available::text AS amount_available, amount_applied::text AS amount_applied`,
      [target.id, amount],
    );
    const row = rows[0]!;
    return {
      status: 'POSTED',
      amountDue: row.amount_available,
      settled: D(row.amount_available).isZero(),
    };
  }

  // amount_due is written from the full definition of the settlement CHECK
  // (F-703) rather than decremented, so the two cannot drift apart.
  //
  // The `- $2` is not a duplicate of the increment above it: every expression in
  // a single UPDATE's SET list evaluates against the OLD row, so the settlement
  // columns read here still hold their pre-increment values. Leaving it out
  // produces a row that fails its own CHECK by exactly the amount allocated.
  const writeOffTerm = spec.table === 'invoices' ? ' - amount_written_off' : '';
  const { rows } = await client.query<{ amount_due: string; status: string }>(
    `UPDATE ${spec.table}
        SET ${column} = ${column} + $2::numeric,
            amount_due = total - amount_paid - amount_credited${writeOffTerm} - $2::numeric
      WHERE id = $1
      RETURNING amount_due::text AS amount_due, status::text AS status`,
    [target.id, amount],
  );
  const row = rows[0]!;
  const settled = D(row.amount_due).isZero();

  const nextStatus = settled ? 'PAID' : 'PARTIALLY_PAID';
  if (row.status !== nextStatus) {
    await client.query(`UPDATE ${spec.table} SET status = $2::document_status WHERE id = $1`, [
      target.id,
      nextStatus,
    ]);
  }
  return { status: nextStatus, amountDue: row.amount_due, settled };
}

/**
 * The vocabulary ArService and SalesService share for credit application and
 * the invoice edit guard. It lives here rather than in either service because
 * SalesService imports ArService to delegate posting and application — the same
 * symbols exported from sales.service.ts would close the cycle ar → sales → ar.
 */

/** One request to apply a posted credit note's available credit to an invoice. */
export interface CreditApplicationInput {
  readonly invoiceId: string;
  readonly amount: string;
}

/**
 * Credit applications restated as allocation requests, so applying a credit
 * note runs the same lock/validate/apply protocol as allocating a receipt —
 * one protocol, not a parallel one that skips a layer.
 */
export function creditApplicationRequests(
  applications: readonly CreditApplicationInput[],
): AllocationRequest[] {
  return applications.map((application) => ({
    targetType: 'INVOICE' as const,
    targetId: application.invoiceId,
    amount: application.amount,
  }));
}

/**
 * doc 04's lifecycle rule as a guard: DRAFT is the only editable state.
 *
 * The refusals differ because the fixes differ. A posted invoice is an
 * accounting fact corrected by credit note (doc 01 rule 4); an approved or
 * submitted one is covered by an approval that names these exact figures, and
 * editing underneath it would post amounts nobody approved.
 */
export function assertInvoiceEditable(status: string): void {
  if (status === 'DRAFT') return;

  if (status === 'POSTED' || status === 'PARTIALLY_PAID' || status === 'PAID') {
    throw new AppError(
      'POSTED_IMMUTABLE',
      `This invoice is ${status}; its financial values are accounting facts. Correct it with a ` +
        'credit note or void-and-reissue, never by editing (doc 01 rule 4).',
      { details: { status } },
    );
  }
  if (status === 'PENDING_APPROVAL' || status === 'APPROVED') {
    throw new AppError(
      'VALIDATION_FAILED',
      `This invoice is ${status}. The approval covers the figures as submitted — editing them ` +
        'now would post amounts nobody approved. Void it and raise a new draft.',
      { details: { status } },
    );
  }
  throw new AppError(
    'VALIDATION_FAILED',
    `This invoice is ${status} and cannot be edited. A ${status} invoice is closed history; ` +
      'raise a new invoice instead.',
    { details: { status } },
  );
}

/**
 * Records one allocation row and its realized FX.
 *
 * ADR-0007 puts realized FX per allocation rather than per payment, because one
 * receipt may settle invoices booked at different rates and a single figure for
 * the receipt cannot be attributed to any of them.
 */
export async function recordAllocation(
  client: PoolClient,
  principal: TenantPrincipal,
  input: {
    readonly table: 'receipt_allocations' | 'payment_allocations';
    readonly sourceColumn: 'customer_receipt_id' | 'vendor_payment_id';
    readonly sourceId: string;
    readonly target: AllocationTarget;
    readonly amount: string;
    readonly settlementRate: string;
    readonly baseCurrency: string;
  },
): Promise<{ id: string; realizedFx: string; documentRate: string }> {
  const documentRate = input.target.exchangeRate ?? input.settlementRate;
  const fx = realizedFx({
    allocatedAmount: input.amount,
    documentRate,
    settlementRate: input.settlementRate,
    baseCurrency: input.baseCurrency,
  });
  const baseAmount = Money.of(
    D(input.amount).mul(D(input.settlementRate)),
    input.baseCurrency,
  ).toString();

  const id = uuidv7();
  await client.query(
    `INSERT INTO ${input.table} (id, tenant_id, ${input.sourceColumn}, target_type, target_id,
                                 amount, base_amount, realized_fx_amount, allocated_by)
     VALUES ($1,$2,$3,$4,$5::uuid,$6::numeric,$7::numeric,$8::numeric,$9)`,
    [
      id,
      principal.tenantId,
      input.sourceId,
      input.target.kind,
      input.target.id,
      input.amount,
      baseAmount,
      fx,
      principal.userId,
    ],
  );
  return { id, realizedFx: fx, documentRate };
}

/**
 * One allocation, in the terms the settlement journal needs: the amount applied,
 * the rate the target document was BOOKED at, and the realized FX
 * `recordAllocation` computed and stored. `allocationId` is carried so the
 * caller can stamp the journal entry back onto the allocation rows and build an
 * idempotency key that distinguishes this batch from the next one.
 */
export interface SettlementAllocation {
  readonly allocationId: string;
  readonly targetId: string;
  readonly amount: string;
  readonly documentRate: string;
  readonly realizedFx: string;
}

/**
 * Builds the journal lines a settlement leaves in the ledger.
 *
 * Two movements, both of which the subledger performs whether or not anyone
 * posts them — which is exactly why this function exists:
 *
 *   1. Reclassification. Cash applied to a document after it was received sat
 *      in the advance account; applying it moves the balance onto the control
 *      account the document lives on. AR: Dr customer advance / Cr AR.
 *      AP: Dr AP / Cr vendor advance. Without this journal the aging total
 *      falls while the control account stands still, and Phase 3's first exit
 *      criterion fails on the first late allocation.
 *
 *   2. Realized FX, per allocation (ADR-0007). The control line converts at
 *      the rate the document was BOOKED at and the advance line at the rate
 *      the cash SETTLED at, so the difference must be posted explicitly —
 *      Cr realized FX gain or Dr realized FX loss — or the journal does not
 *      balance. Making the FX line load-bearing is deliberate: forgetting it
 *      becomes an error the posting kernel refuses, not a misstatement it
 *      accepts.
 *
 * An allocation with a zero amount posts only its FX correction against the
 * control account (the case where the payment's own posting already relieved
 * the control at the settlement rate: gain → Dr control / Cr gain, loss →
 * Dr loss / Cr control). An allocation with zero amount AND zero FX
 * contributes nothing, and a request in which every allocation is such
 * returns no lines at all — the caller skips the posting rather than writing
 * an entry that records nothing.
 */
export function settlementPostingLines(input: {
  readonly side: 'AR' | 'AP';
  readonly controlAccountId: string;
  readonly advanceAccountId: string | null;
  readonly realizedFxGainAccountId: string | null;
  readonly realizedFxLossAccountId: string | null;
  readonly contactId: string;
  readonly currency: string;
  readonly baseCurrency: string;
  readonly settlementRate: string;
  readonly allocations: readonly SettlementAllocation[];
}): DraftLineInput[] {
  const isAr = input.side === 'AR';
  const lines: DraftLineInput[] = [];

  for (const allocation of input.allocations) {
    const amount = D(allocation.amount);
    const fx = D(allocation.realizedFx);
    if (amount.isZero() && fx.isZero()) continue;

    if (!amount.isZero()) {
      if (!input.advanceAccountId) {
        const column = isAr ? 'customer_advance_account_id' : 'vendor_advance_account_id';
        throw new AppError(
          'VALIDATION_FAILED',
          `Applying ${allocation.amount} ${input.currency} moves money out of the ` +
            `${isAr ? 'customer' : 'vendor'} advance account, and none is configured. Set ` +
            `${column} on the accounting policy — reclassifying from an account that does not ` +
            'exist would leave the control account unreconciled.',
          { details: { target_id: allocation.targetId, column } },
        );
      }
      // Control at the DOCUMENT's rate, advance at the SETTLEMENT rate: the
      // control account must give back exactly the base amount the document
      // put in, or a residue accrues that no open item explains.
      lines.push({
        accountId: input.controlAccountId,
        description: isAr ? 'Accounts receivable' : 'Accounts payable',
        contactId: input.contactId,
        ...(isAr ? { credit: allocation.amount } : { debit: allocation.amount }),
        transactionCurrency: input.currency,
        exchangeRate: allocation.documentRate,
      });
      lines.push({
        accountId: input.advanceAccountId,
        description: isAr ? 'Customer advance' : 'Vendor advance',
        contactId: input.contactId,
        ...(isAr ? { debit: allocation.amount } : { credit: allocation.amount }),
        transactionCurrency: input.currency,
        exchangeRate: input.settlementRate,
      });
    }

    if (!fx.isZero()) {
      // The sign convention ADR-0007 implies: realizedFx is settlement minus
      // document, in base currency. Collecting MORE base than the receivable
      // carried is a gain; paying MORE base than the payable carried is a loss.
      const gain = isAr ? fx.isPositive() : fx.isNegative();
      const accountId = gain ? input.realizedFxGainAccountId : input.realizedFxLossAccountId;
      if (!accountId) {
        const column = gain ? 'realized_fx_gain_account_id' : 'realized_fx_loss_account_id';
        throw new AppError(
          'VALIDATION_FAILED',
          `This allocation realizes an FX ${gain ? 'gain' : 'loss'} of ${fx.abs().toString()} ` +
            `${input.baseCurrency} and no account is configured for it. Set ${column} on the ` +
            'accounting policy — dropping it would leave the control account off by exactly ' +
            'that amount.',
          { details: { target_id: allocation.targetId, column } },
        );
      }
      const magnitude = fx.abs().toString();
      if (amount.isZero()) {
        // The payment's own posting relieved the control at the settlement
        // rate; only the difference to the booked rate remains to correct.
        lines.push({
          accountId: input.controlAccountId,
          description: isAr ? 'Accounts receivable' : 'Accounts payable',
          contactId: input.contactId,
          ...(gain ? { debit: magnitude } : { credit: magnitude }),
        });
      }
      lines.push({
        accountId,
        description: gain ? 'Realized FX gain' : 'Realized FX loss',
        ...(gain ? { credit: magnitude } : { debit: magnitude }),
      });
    }
  }

  return lines;
}
