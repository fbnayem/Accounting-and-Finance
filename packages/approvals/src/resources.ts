/**
 * The documents an approval request can be raised against, and — the part that
 * matters — what raising one DOES to them.
 *
 * -----------------------------------------------------------------------------
 * Why the engine touches these tables at all
 * -----------------------------------------------------------------------------
 * An approval engine that only writes `approval_requests` and `approval_steps`
 * prevents nothing. It is a register of opinions, and the exit criterion is
 * "approval bypass attempts fail at API/domain layer" — so the engine has to
 * move the thing that is actually gated.
 *
 * It does that by putting the document into a state that ALREADY refuses to
 * post, and taking it out again only through a completed request:
 *
 *   INVOICE / VENDOR_BILL → `PENDING_APPROVAL`. `AR.postInvoice` and
 *     `AP.postVendorBill` refuse to post from that status with APPROVAL_REQUIRED
 *     (proved by apps/api/src/integration/document-approval.test.ts). Until this
 *     package existed NOTHING could put a document into that state, so the state
 *     was in the enum, in the contract, and unreachable — which is the audit's
 *     finding, and the reason the guard above it had never once fired in anger.
 *
 *   JOURNAL → `SUBMITTED`, and on completion `approved_by` is written. That
 *     column is what migration 0049's deferred constraint trigger reads at
 *     COMMIT of the posting transaction: a journal at or above the book's
 *     `journal_approval_threshold` cannot reach POSTED without it, and
 *     `je_maker_checker` refuses it unless the approver differs from a KNOWN
 *     preparer. 0049 says in its own header that "when the engine lands it fills
 *     journal_entries.approved_by through its own decision path"; this is that
 *     path.
 *
 * The write is therefore narrow and enumerable: one status column, one approver,
 * one timestamp, one approval_state, per row, and only ever from the engine's own
 * transaction. Everything else about the document belongs to the module that owns
 * it. This file is the whole list of what the approval engine reaches outside its
 * own tables, so a reviewer can check it in one screen.
 */
import type { PoolClient } from 'pg';
import { AppError, notFound } from '@acct/domain';
import { assertIdentifier } from '@acct/database';

export interface GatedResource {
  /** The value stored in `approval_requests.resource_type`. */
  readonly resourceType: string;
  readonly table: string;
  /** How the document is named in a refusal a person has to act on. */
  readonly label: string;
  /** A human reference (document number), falling back to the id. */
  readonly referenceColumn: string | null;
  readonly approvalStateColumn: string | null;
  readonly preparerColumn: string;
  readonly approverColumn: string;
  readonly approvedAtColumn: string;
  readonly versionColumn: string;
  /** The statuses from which approval may be requested. */
  readonly requestableFrom: readonly string[];
  /** The status a document sits in while its request is open. */
  readonly pendingStatus: string;
  /** The status a completed approval puts it in. */
  readonly approvedStatus: string;
  /** Where a rejected or withdrawn document goes back to. */
  readonly returnStatus: string;
  /** SQL expression over alias `d` producing the exact amount as text. */
  readonly amountSql: string;
  readonly currencyColumn: string;
  readonly counterpartyColumn: string | null;
  readonly projectColumn: string | null;
  readonly branchColumn: string | null;
  /** SQL subquery over alias `d` producing the distinct account ids as text[]. */
  readonly accountIdsSql: string;
}

/**
 * The three documents whose approval state is enforced somewhere OTHER than in
 * this package.
 *
 * That is the entry condition for being here. A resource type whose gate exists
 * only in the approval engine would be gated only against callers who remembered
 * to ask the approval engine, which is not a gate. Payment runs, purchase orders
 * and close reopens are all approvable in principle and are deliberately absent:
 * their posting paths do not consult an approval request yet, and listing them
 * here would produce a control that refuses nothing while appearing to cover
 * them. They are named in the integration notes instead.
 */
export const GATED_RESOURCES: readonly GatedResource[] = [
  {
    resourceType: 'JOURNAL',
    table: 'journal_entries',
    label: 'Journal',
    referenceColumn: 'entry_number',
    approvalStateColumn: 'approval_state',
    preparerColumn: 'created_by',
    approverColumn: 'approved_by',
    approvedAtColumn: 'approved_at',
    versionColumn: 'version',
    requestableFrom: ['DRAFT', 'SUBMITTED'],
    pendingStatus: 'SUBMITTED',
    approvedStatus: 'APPROVED',
    // `journal_status` has no REJECTED member, so a rejected journal returns to
    // DRAFT and carries `approval_state = 'REJECTED'` as the record of what
    // happened. Losing that distinction in the status column is why the
    // approval_state column exists.
    returnStatus: 'DRAFT',
    amountSql: `(SELECT abs(greatest(coalesce(sum(l.base_debit), 0), coalesce(sum(l.base_credit), 0)))::text
                   FROM journal_lines l WHERE l.journal_entry_id = d.id)`,
    currencyColumn: 'base_currency',
    counterpartyColumn: null,
    projectColumn: null,
    branchColumn: 'branch_id',
    accountIdsSql: `(SELECT coalesce(array_agg(DISTINCT l.account_id::text), '{}')
                       FROM journal_lines l WHERE l.journal_entry_id = d.id)`,
  },
  {
    resourceType: 'INVOICE',
    table: 'invoices',
    label: 'Invoice',
    referenceColumn: 'invoice_number',
    approvalStateColumn: 'approval_state',
    preparerColumn: 'created_by',
    approverColumn: 'approved_by',
    approvedAtColumn: 'approved_at',
    versionColumn: 'version',
    requestableFrom: ['DRAFT'],
    pendingStatus: 'PENDING_APPROVAL',
    approvedStatus: 'APPROVED',
    returnStatus: 'DRAFT',
    amountSql: 'd.total::text',
    currencyColumn: 'currency',
    counterpartyColumn: 'customer_id',
    projectColumn: 'project_id',
    branchColumn: 'branch_id',
    accountIdsSql: `(SELECT coalesce(array_agg(DISTINCT il.revenue_account_id::text), '{}')
                       FROM invoice_lines il WHERE il.invoice_id = d.id)`,
  },
  {
    resourceType: 'VENDOR_BILL',
    table: 'vendor_bills',
    label: 'Vendor bill',
    referenceColumn: 'vendor_invoice_number',
    approvalStateColumn: 'approval_state',
    preparerColumn: 'created_by',
    approverColumn: 'approved_by',
    approvedAtColumn: 'approved_at',
    versionColumn: 'version',
    requestableFrom: ['DRAFT'],
    pendingStatus: 'PENDING_APPROVAL',
    approvedStatus: 'APPROVED',
    returnStatus: 'DRAFT',
    amountSql: 'd.total::text',
    currencyColumn: 'currency',
    counterpartyColumn: 'vendor_id',
    projectColumn: 'project_id',
    branchColumn: 'branch_id',
    accountIdsSql: `(SELECT coalesce(array_agg(DISTINCT bl.destination_account_id::text), '{}')
                       FROM vendor_bill_lines bl WHERE bl.vendor_bill_id = d.id)`,
  },
];

export function gatedResource(resourceType: string): GatedResource {
  const found = GATED_RESOURCES.find((r) => r.resourceType === resourceType);
  if (!found) {
    throw new AppError(
      'VALIDATION_FAILED',
      `"${resourceType}" is not a resource the approval engine can gate. It gates ` +
        `${GATED_RESOURCES.map((r) => r.resourceType).join(', ')} — the documents whose posting ` +
        `path independently refuses an unapproved document. Adding a type here without that ` +
        `refusal would register an approval nothing consults.`,
      { details: { resourceType } },
    );
  }
  return found;
}

export interface ResourceFacts {
  readonly id: string;
  readonly tenantId: string;
  readonly legalEntityId: string;
  readonly status: string;
  readonly reference: string;
  readonly preparedBy: string | null;
  readonly approvedBy: string | null;
  readonly version: string;
  /** Exact decimal string, straight from `numeric::text`. Never parsed as a number. */
  readonly amount: string;
  readonly currency: string;
  readonly counterpartyId: string | null;
  readonly projectId: string | null;
  readonly branchId: string | null;
  readonly accountIds: readonly string[];
}

interface ResourceRow {
  id: string;
  tenant_id: string;
  legal_entity_id: string;
  status: string;
  reference: string | null;
  prepared_by: string | null;
  approved_by: string | null;
  version: string;
  amount: string | null;
  currency: string;
  counterparty_id: string | null;
  project_id: string | null;
  branch_id: string | null;
  account_ids: string[] | null;
}

/**
 * Reads the document, optionally locking it.
 *
 * `FOR UPDATE` on the write paths, and the whole decision — status, preparer,
 * version, amount — is read under that lock, so the check and the write it
 * guards are in one transaction. F-106: a check outside the transaction that
 * performs the write is a race, not a guard.
 */
export async function loadResourceFacts(
  client: PoolClient,
  adapter: GatedResource,
  id: string,
  options: { forUpdate?: boolean } = {},
): Promise<ResourceFacts> {
  const table = assertIdentifier(adapter.table);
  const reference =
    adapter.referenceColumn === null
      ? 'NULL::text'
      : `d.${assertIdentifier(adapter.referenceColumn)}`;
  const counterparty =
    adapter.counterpartyColumn === null
      ? 'NULL::uuid'
      : `d.${assertIdentifier(adapter.counterpartyColumn)}`;
  const project =
    adapter.projectColumn === null ? 'NULL::uuid' : `d.${assertIdentifier(adapter.projectColumn)}`;
  const branch =
    adapter.branchColumn === null ? 'NULL::uuid' : `d.${assertIdentifier(adapter.branchColumn)}`;

  // FOR UPDATE cannot be combined with the aggregate subqueries in one statement,
  // so the lock is taken first and the facts read under it.
  if (options.forUpdate) {
    await client.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
  }

  const { rows } = await client.query<ResourceRow>(
    `SELECT d.id, d.tenant_id, d.legal_entity_id,
            d.status::text                                   AS status,
            ${reference}                                     AS reference,
            d.${assertIdentifier(adapter.preparerColumn)}    AS prepared_by,
            d.${assertIdentifier(adapter.approverColumn)}    AS approved_by,
            d.${assertIdentifier(adapter.versionColumn)}::text AS version,
            ${adapter.amountSql}                             AS amount,
            d.${assertIdentifier(adapter.currencyColumn)}    AS currency,
            ${counterparty}                                  AS counterparty_id,
            ${project}                                       AS project_id,
            ${branch}                                        AS branch_id,
            ${adapter.accountIdsSql}                         AS account_ids
       FROM ${table} d
      WHERE d.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw notFound(adapter.label.toLowerCase().replace(/ /g, '_'), id);

  return {
    id: row.id,
    tenantId: row.tenant_id,
    legalEntityId: row.legal_entity_id,
    status: row.status,
    reference: row.reference ?? row.id,
    preparedBy: row.prepared_by,
    approvedBy: row.approved_by,
    version: row.version,
    // `numeric::text` from PostgreSQL, or '0' when the document has no lines yet.
    // ADR-0006 §1: it stays a string all the way to `D()`.
    amount: row.amount ?? '0',
    currency: row.currency,
    counterpartyId: row.counterparty_id,
    projectId: row.project_id,
    branchId: row.branch_id,
    accountIds: row.account_ids ?? [],
  };
}

/** Parks the document in the state its posting path already refuses. */
export async function parkForApproval(
  client: PoolClient,
  adapter: GatedResource,
  id: string,
): Promise<void> {
  const table = assertIdentifier(adapter.table);
  const setApprovalState =
    adapter.approvalStateColumn === null
      ? ''
      : `, ${assertIdentifier(adapter.approvalStateColumn)} = 'PENDING'::approval_status`;
  const { rowCount } = await client.query(
    `UPDATE ${table}
        SET status = $2::${statusCast(adapter)}${setApprovalState}
      WHERE id = $1 AND status = ANY($3::text[]::${statusCast(adapter)}[])`,
    [id, adapter.pendingStatus, adapter.requestableFrom],
  );
  if (rowCount === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${adapter.label} ${id} could not be moved into ${adapter.pendingStatus}; its status changed ` +
        `while the approval was being requested.`,
      { details: { id, resourceType: adapter.resourceType } },
    );
  }
}

/**
 * Records the approval on the document.
 *
 * This is the write that `je_maker_checker` and 0049's deferred trigger read. It
 * deliberately does NOT bypass them — if the approver equals a known preparer, or
 * the preparer is unknown, the CHECK refuses this statement, which is the second,
 * independent statement of the rule `assertSegregationOfDuties` has already made
 * in TypeScript. Two layers, on purpose: the service refusal is actionable, the
 * constraint is unbypassable.
 */
export async function recordApprovalOnResource(
  client: PoolClient,
  adapter: GatedResource,
  id: string,
  approverUserId: string,
): Promise<void> {
  const table = assertIdentifier(adapter.table);
  const setApprovalState =
    adapter.approvalStateColumn === null
      ? ''
      : `, ${assertIdentifier(adapter.approvalStateColumn)} = 'APPROVED'::approval_status`;
  const { rowCount } = await client.query(
    `UPDATE ${table}
        SET status = $2::${statusCast(adapter)},
            ${assertIdentifier(adapter.approverColumn)} = $3,
            ${assertIdentifier(adapter.approvedAtColumn)} = now()${setApprovalState}
      WHERE id = $1 AND status = $4::${statusCast(adapter)}`,
    [id, adapter.approvedStatus, approverUserId, adapter.pendingStatus],
  );
  if (rowCount === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${adapter.label} ${id} is no longer ${adapter.pendingStatus}, so the approval cannot be ` +
        `recorded on it. Something moved the document while its approval was in flight.`,
      { details: { id, resourceType: adapter.resourceType } },
    );
  }
}

/** Returns the document to its pre-request state, with the outcome recorded. */
export async function releaseResource(
  client: PoolClient,
  adapter: GatedResource,
  id: string,
  outcome: 'REJECTED' | 'CANCELLED',
): Promise<void> {
  const table = assertIdentifier(adapter.table);
  const params: unknown[] = [id, adapter.returnStatus];
  let setApprovalState = '';
  if (adapter.approvalStateColumn !== null) {
    params.push(outcome);
    setApprovalState = `, ${assertIdentifier(adapter.approvalStateColumn)} = $${params.length}::approval_status`;
  }
  params.push(adapter.pendingStatus);
  await client.query(
    `UPDATE ${table}
        SET status = $2::${statusCast(adapter)}${setApprovalState}
      WHERE id = $1 AND status = $${params.length}::${statusCast(adapter)}`,
    params,
  );
}

/** The enum type each table's `status` column is declared with. */
function statusCast(adapter: GatedResource): string {
  return adapter.table === 'journal_entries' ? 'journal_status' : 'document_status';
}
