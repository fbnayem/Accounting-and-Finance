import { Pool, PoolClient } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  assertEntityPermission,
  type TenantPrincipal,
} from '@acct/domain';
import { publish, recordAudit, readInTenant, writeInTenant } from '@acct/database';
import { addDecimal } from './document-posting.service';

/**
 * Tax returns — doc 07's OPEN -> PREPARING -> READY -> FILED -> AMENDED machine.
 *
 * The Phase 3 exit criterion this file answers to: the return's figures come
 * from the tax subledger and are recorded as computed, so that comparing them
 * to the GL tax control accounts is a real reconciliation rather than a number
 * agreeing with itself.
 *
 * The design constraint everything else follows from: 0036 executes
 * `REVOKE UPDATE, DELETE ON tax_transactions FROM app_runtime` ("the tax
 * subledger is the evidence a filed return was built from"), so a return cannot
 * stamp the rows it reported. What a return does own is its snapshot, so
 * membership lives there: the snapshot carries the exact transaction ids it
 * aggregated, and a later preparation reads the filed snapshots to decide what
 * has already been reported. Because the subledger is insert-only under that
 * revoke, a filed snapshot's id list can never be invalidated after the fact —
 * a row is either in it or arrived later, and a row that arrived later is swept
 * into the next return as a late transaction rather than dropped.
 */

export interface ReturnTransactionRow extends Record<string, unknown> {
  id: string;
  posting_date: string;
  direction: string;
  tax_code: string;
  component_code: string | null;
  currency: string;
  taxable_amount: string;
  tax_amount: string;
  base_taxable_amount: string;
  base_tax_amount: string;
  recoverable_amount: string;
  nonrecoverable_amount: string;
}

/** One already-filed period's date range and everything its filed versions reported. */
export interface FiledCoverage {
  readonly startDate: string;
  readonly endDate: string;
  readonly reportedTransactionIds: ReadonlySet<string>;
}

export interface ReturnPartition {
  /** Dated inside the period being prepared — reported now. */
  readonly current: ReturnTransactionRow[];
  /**
   * Dated inside an already-filed period but absent from every filed snapshot
   * covering that date — posted after that return filed. Reported now, flagged
   * as late, because the alternative is a transaction no return ever carries.
   */
  readonly late: ReturnTransactionRow[];
  /** On a filed snapshot already; reporting these again would double-count them. */
  readonly alreadyReported: ReturnTransactionRow[];
  /** Another period's business: future-dated, or in a prior period that has not filed yet. */
  readonly outOfScope: ReturnTransactionRow[];
}

/**
 * The double-reporting invariant, as one decidable function.
 *
 * Every candidate row lands in exactly one bucket, and only `current` and
 * `late` reach the return. Dates are ISO `YYYY-MM-DD` strings, which order
 * correctly under string comparison.
 */
export function partitionForReturn(
  rows: readonly ReturnTransactionRow[],
  period: { startDate: string; endDate: string },
  filed: readonly FiledCoverage[],
): ReturnPartition {
  const current: ReturnTransactionRow[] = [];
  const late: ReturnTransactionRow[] = [];
  const alreadyReported: ReturnTransactionRow[] = [];
  const outOfScope: ReturnTransactionRow[] = [];

  for (const row of rows) {
    if (row.posting_date >= period.startDate && row.posting_date <= period.endDate) {
      current.push(row);
      continue;
    }
    if (row.posting_date > period.endDate) {
      outOfScope.push(row);
      continue;
    }
    const cover = filed.find(
      (f) => row.posting_date >= f.startDate && row.posting_date <= f.endDate,
    );
    if (!cover) {
      // Its own period has not filed; when it does, its return reports this row.
      outOfScope.push(row);
    } else if (cover.reportedTransactionIds.has(row.id)) {
      alreadyReported.push(row);
    } else {
      late.push(row);
    }
  }
  return { current, late, alreadyReported, outOfScope };
}

/**
 * doc 07: "Finalized/FILED return becomes an immutable snapshot." The DDL
 * trigger on tax_returns guards DELETE; UPDATE is guarded here, before any
 * preparation work touches the row.
 */
export function assertReturnPreparable(status: string, id: string): void {
  if (status === 'FILED' || status === 'AMENDED') {
    throw new AppError(
      'POSTED_IMMUTABLE',
      `Tax return ${id} is ${status}; a filed return is an immutable snapshot (doc 07). ` +
        'To change what was reported, create an amending return for the same period.',
      { details: { id, status } },
    );
  }
  if (status === 'CLOSED') {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Tax return ${id} is CLOSED and cannot be prepared.`,
      {
        details: { id, status },
      },
    );
  }
}

export interface ReturnBox {
  direction: string;
  tax_code: string;
  component_code: string | null;
  late: boolean;
  taxable_amount: string;
  tax_amount: string;
  base_taxable_amount: string;
  base_tax_amount: string;
  recoverable_amount: string;
  nonrecoverable_amount: string;
  transaction_count: number;
}

export interface ReturnSnapshot {
  form_code: string;
  period: { id: string; jurisdiction: string; start_date: string; end_date: string };
  basis: string;
  /** The membership record — every id this return reports, current and late. */
  transaction_ids: string[];
  late_transaction_ids: string[];
  transaction_count: number;
  late_transaction_count: number;
  boxes: ReturnBox[];
  totals: {
    output_taxable: string;
    output_tax: string;
    input_tax: string;
    recoverable_input_tax: string;
    nonrecoverable_input_tax: string;
    withholding_tax: string;
    net_payable: string;
  };
}

const negated = (value: string) => `-${value}`.replace('--', '');

/**
 * Aggregates the partitioned transactions into the return's boxes and totals.
 *
 * Output and input tax reconcile to the GL controls in base currency
 * (base_tax_amount is what the journal lines were built from). The
 * recoverable/non-recoverable split follows `TaxService.report`'s convention of
 * summing the transaction-currency columns, because tax_transactions has no
 * base-currency recoverable column — exact for a single-currency entity, and a
 * schema gap worth naming for a multi-currency one.
 */
export function buildReturnSnapshot(input: {
  formCode: string;
  period: { id: string; jurisdiction: string; startDate: string; endDate: string };
  current: readonly ReturnTransactionRow[];
  late: readonly ReturnTransactionRow[];
}): ReturnSnapshot {
  if (input.current.length === 0 && input.late.length === 0) {
    // An empty preparation is far more often a wrong jurisdiction, a wrong date
    // range or unposted source documents than a true nil period. A nil return
    // should be a decision made on evidence, not the output of an empty query.
    throw new AppError(
      'VALIDATION_FAILED',
      `Tax period ${input.period.startDate} to ${input.period.endDate} has no posted tax ` +
        'transactions to report. Verify the jurisdiction and dates, and that the source ' +
        'documents in range are posted, before preparing this return.',
      { details: { period: input.period } },
    );
  }

  const ZERO = addDecimal('0', '0');
  const boxes = new Map<string, ReturnBox>();
  const totals = {
    output_taxable: ZERO,
    output_tax: ZERO,
    input_tax: ZERO,
    recoverable_input_tax: ZERO,
    nonrecoverable_input_tax: ZERO,
    withholding_tax: ZERO,
  };

  const accumulate = (row: ReturnTransactionRow, late: boolean) => {
    if (row.direction === 'OUTPUT') {
      totals.output_taxable = addDecimal(totals.output_taxable, row.base_taxable_amount);
      totals.output_tax = addDecimal(totals.output_tax, row.base_tax_amount);
    } else if (row.direction === 'INPUT') {
      totals.input_tax = addDecimal(totals.input_tax, row.base_tax_amount);
      totals.recoverable_input_tax = addDecimal(
        totals.recoverable_input_tax,
        row.recoverable_amount,
      );
      totals.nonrecoverable_input_tax = addDecimal(
        totals.nonrecoverable_input_tax,
        row.nonrecoverable_amount,
      );
    } else if (row.direction === 'WITHHOLDING') {
      totals.withholding_tax = addDecimal(totals.withholding_tax, row.base_tax_amount);
    } else {
      throw new AppError(
        'VALIDATION_FAILED',
        `Tax transaction ${row.id} has direction ${row.direction}, which no return box accepts.`,
        { details: { id: row.id, direction: row.direction } },
      );
    }

    const key = `${row.direction}|${row.tax_code}|${row.component_code ?? ''}|${late ? 'L' : ''}`;
    const box = boxes.get(key);
    if (!box) {
      boxes.set(key, {
        direction: row.direction,
        tax_code: row.tax_code,
        component_code: row.component_code,
        late,
        taxable_amount: addDecimal(ZERO, row.taxable_amount),
        tax_amount: addDecimal(ZERO, row.tax_amount),
        base_taxable_amount: addDecimal(ZERO, row.base_taxable_amount),
        base_tax_amount: addDecimal(ZERO, row.base_tax_amount),
        recoverable_amount: addDecimal(ZERO, row.recoverable_amount),
        nonrecoverable_amount: addDecimal(ZERO, row.nonrecoverable_amount),
        transaction_count: 1,
      });
    } else {
      box.taxable_amount = addDecimal(box.taxable_amount, row.taxable_amount);
      box.tax_amount = addDecimal(box.tax_amount, row.tax_amount);
      box.base_taxable_amount = addDecimal(box.base_taxable_amount, row.base_taxable_amount);
      box.base_tax_amount = addDecimal(box.base_tax_amount, row.base_tax_amount);
      box.recoverable_amount = addDecimal(box.recoverable_amount, row.recoverable_amount);
      box.nonrecoverable_amount = addDecimal(box.nonrecoverable_amount, row.nonrecoverable_amount);
      box.transaction_count += 1;
    }
  };

  for (const row of input.current) accumulate(row, false);
  for (const row of input.late) accumulate(row, true);

  const ordered = [...boxes.values()].sort((a, b) =>
    `${a.direction}|${a.tax_code}|${a.component_code ?? ''}|${a.late ? 1 : 0}`.localeCompare(
      `${b.direction}|${b.tax_code}|${b.component_code ?? ''}|${b.late ? 1 : 0}`,
    ),
  );

  return {
    form_code: input.formCode,
    period: {
      id: input.period.id,
      jurisdiction: input.period.jurisdiction,
      start_date: input.period.startDate,
      end_date: input.period.endDate,
    },
    basis: 'tax_transactions (primary book)',
    transaction_ids: [...input.current, ...input.late].map((r) => r.id).sort(),
    late_transaction_ids: input.late.map((r) => r.id).sort(),
    transaction_count: input.current.length + input.late.length,
    late_transaction_count: input.late.length,
    boxes: ordered,
    totals: {
      ...totals,
      // Only the recoverable half of input tax offsets the liability; the
      // non-recoverable half already capitalised into cost (doc 07).
      net_payable: addDecimal(totals.output_tax, negated(totals.recoverable_input_tax)),
    },
  };
}

export interface TaxReturnRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  legal_entity_id: string;
  tax_period_id: string;
  form_code: string;
  version: number;
  status: string;
  prepared_by: string | null;
  prepared_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  filed_at: string | null;
  filing_reference: string | null;
  filing_evidence_file_id: string | null;
  snapshot: ReturnSnapshot | null;
  localization_version_id: string | null;
  amends_return_id: string | null;
  created_at: string;
}

interface TaxPeriodRow extends Record<string, unknown> {
  id: string;
  legal_entity_id: string;
  jurisdiction: string;
  name: string;
  start_date: string;
  end_date: string;
  status: string;
}

const RETURN_COLUMNS = `id, tenant_id, legal_entity_id, tax_period_id, form_code, version,
       status::text AS status, prepared_by, prepared_at::text AS prepared_at,
       approved_by, approved_at::text AS approved_at, filed_at::text AS filed_at,
       filing_reference, filing_evidence_file_id, snapshot, localization_version_id,
       amends_return_id, created_at::text AS created_at`;

export class TaxReturnService {
  constructor(private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // POST /tax-returns — F-107: the lifecycle's entry point.
  // -------------------------------------------------------------------------

  async createTaxReturn(
    principal: TenantPrincipal,
    input: {
      taxPeriodId: string;
      formCode: string;
      amendsReturnId?: string | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const period = await this.loadPeriod(client, input.taxPeriodId);
      assertEntityPermission(principal, 'tax_return.create', period.legal_entity_id);

      // A return files under a registration number. Opening one for a
      // jurisdiction the entity is not registered in produces a document that
      // can never legally be filed, so it is refused here rather than at the
      // filing deadline.
      const { rows: registrations } = await client.query<{ id: string }>(
        `SELECT id
           FROM tax_registrations
          WHERE legal_entity_id = $1 AND jurisdiction = $2 AND status = 'ACTIVE'
            AND valid_from <= $3::date AND (valid_to IS NULL OR valid_to >= $4::date)
          LIMIT 1`,
        [period.legal_entity_id, period.jurisdiction, period.end_date, period.start_date],
      );
      if (!registrations[0]) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This legal entity holds no active tax registration for ${period.jurisdiction} ` +
            `covering ${period.start_date} to ${period.end_date}. Register the entity before ` +
            'opening a return for that jurisdiction.',
          { details: { jurisdiction: period.jurisdiction, tax_period_id: period.id } },
        );
      }

      let version = 1;
      if (input.amendsReturnId) {
        const { rows: amended } = await client.query<TaxReturnRow>(
          `SELECT ${RETURN_COLUMNS} FROM tax_returns WHERE id = $1 FOR UPDATE`,
          [input.amendsReturnId],
        );
        const predecessor = amended[0];
        if (!predecessor) throw notFound('tax return', input.amendsReturnId);
        if (
          predecessor.tax_period_id !== input.taxPeriodId ||
          predecessor.form_code !== input.formCode
        ) {
          throw new AppError(
            'VALIDATION_FAILED',
            'An amendment covers the same period and form as the return it amends; ' +
              `${input.amendsReturnId} is for a different one.`,
            { details: { amends_return_id: input.amendsReturnId } },
          );
        }
        if (predecessor.status !== 'FILED') {
          throw new AppError(
            'PRECONDITION_FAILED',
            `Only a FILED return can be amended; ${input.amendsReturnId} is ` +
              `${predecessor.status}. An unfiled return is simply re-prepared.`,
            { details: { amends_return_id: input.amendsReturnId, status: predecessor.status } },
          );
        }
        version = predecessor.version + 1;
      }

      // doc 07 / doc 20: a return produced under an installed localization
      // package records which version produced it, so a later upgrade cannot
      // silently change what a historical return meant.
      const { rows: installed } = await client.query<{ localization_version_id: string }>(
        `SELECT localization_version_id
           FROM localization_installations
          WHERE legal_entity_id = $1 AND status = 'ACTIVE' AND localization_version_id IS NOT NULL
          ORDER BY installed_at DESC
          LIMIT 1`,
        [period.legal_entity_id],
      );

      try {
        const { rows } = await client.query<TaxReturnRow>(
          `INSERT INTO tax_returns (id, tenant_id, legal_entity_id, tax_period_id, form_code,
                                    version, localization_version_id, amends_return_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           RETURNING ${RETURN_COLUMNS}`,
          [
            uuidv7(),
            principal.tenantId,
            period.legal_entity_id,
            input.taxPeriodId,
            input.formCode,
            version,
            installed[0]?.localization_version_id ?? null,
            input.amendsReturnId ?? null,
          ],
        );
        const created = rows[0]!;
        await recordAudit(client, context, {
          action: 'tax_return.created',
          resourceType: 'tax_return',
          resourceId: created.id,
          tenantId: principal.tenantId,
          legalEntityId: period.legal_entity_id,
          after: created,
        });
        return created;
      } catch (err) {
        if (
          (err as { constraint?: string }).constraint ===
          'tax_returns_tax_period_id_form_code_version_key'
        ) {
          throw new AppError(
            'VALIDATION_FAILED',
            `A version ${version} return for form ${input.formCode} already exists for this ` +
              'period. Prepare that one, or amend it once it is filed — a second parallel ' +
              'return for the same period would report the same transactions twice.',
            { details: { tax_period_id: input.taxPeriodId, form_code: input.formCode, version } },
          );
        }
        throw err;
      }
    });
  }

  async listTaxReturns(
    principal: TenantPrincipal,
    filter: {
      legalEntityId?: string | undefined;
      taxPeriodId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT r.id, r.legal_entity_id, r.tax_period_id, r.form_code, r.version,
                r.status::text AS status, r.prepared_by, r.prepared_at::text AS prepared_at,
                r.approved_by, r.approved_at::text AS approved_at,
                r.filed_at::text AS filed_at, r.filing_reference, r.amends_return_id,
                p.jurisdiction, p.name AS period_name,
                p.start_date::text AS start_date, p.end_date::text AS end_date,
                r.snapshot -> 'totals' AS totals
           FROM tax_returns r
           JOIN tax_periods p ON p.id = r.tax_period_id
          WHERE ($1::uuid IS NULL OR r.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR r.tax_period_id = $2)
            AND ($3::text IS NULL OR r.status::text = $3)
          ORDER BY p.start_date DESC, r.form_code, r.version DESC
          LIMIT 200`,
        [filter.legalEntityId ?? null, filter.taxPeriodId ?? null, filter.status ?? null],
      );
      return { data: rows };
    });
  }

  // -------------------------------------------------------------------------
  // POST /tax-returns/{id}/prepare
  // -------------------------------------------------------------------------

  /**
   * Aggregates the period's subledger into the return's boxes and records the
   * result in the snapshot. Computed from tax_transactions and never read back
   * from the GL: the snapshot is one side of the return-to-GL reconciliation,
   * and a figure copied from the GL would reconcile to itself.
   */
  async prepareTaxReturn(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const ret = await this.loadReturnForUpdate(client, id);
      assertEntityPermission(principal, 'tax_return.prepare', ret.legal_entity_id);
      assertReturnPreparable(ret.status, id);

      const { period, partition } = await this.assembleReturnFacts(client, ret);
      const snapshot = buildReturnSnapshot({
        formCode: ret.form_code,
        period: {
          id: period.id,
          jurisdiction: period.jurisdiction,
          startDate: period.start_date,
          endDate: period.end_date,
        },
        current: partition.current,
        late: partition.late,
      });

      // Re-preparing an approved (READY) return clears the approval: the
      // approval covered the previous figures, not the return as a container,
      // and the new figures must pass the same SoD gate (doc 14).
      const { rows } = await client.query<TaxReturnRow>(
        `UPDATE tax_returns
            SET status = 'PREPARING', prepared_by = $2, prepared_at = now(),
                snapshot = $3::jsonb, approved_by = NULL, approved_at = NULL
          WHERE id = $1
          RETURNING ${RETURN_COLUMNS}`,
        [id, principal.userId, JSON.stringify(snapshot)],
      );
      const prepared = rows[0]!;

      await publish(client, context, {
        eventType: 'tax_return.prepared',
        aggregateType: 'tax_return',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: ret.legal_entity_id,
        payload: {
          form_code: ret.form_code,
          tax_period_id: ret.tax_period_id,
          transaction_count: snapshot.transaction_count,
          late_transaction_count: snapshot.late_transaction_count,
          net_payable: snapshot.totals.net_payable,
        },
      });
      await recordAudit(client, context, {
        action: 'tax_return.prepared',
        resourceType: 'tax_return',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: ret.legal_entity_id,
        before: ret,
        after: prepared,
      });
      return prepared;
    });
  }

  // -------------------------------------------------------------------------
  // POST /tax-returns/{id}/approve
  // -------------------------------------------------------------------------

  async approveTaxReturn(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const ret = await this.loadReturnForUpdate(client, id);
      assertEntityPermission(principal, 'tax_return.approve', ret.legal_entity_id);

      if (ret.status === 'FILED' || ret.status === 'AMENDED') {
        throw new AppError(
          'POSTED_IMMUTABLE',
          `Tax return ${id} is ${ret.status}; approval happened before filing.`,
          { details: { id, status: ret.status } },
        );
      }
      if (ret.status === 'READY') return ret;
      if (ret.status !== 'PREPARING') {
        throw new AppError(
          'PRECONDITION_FAILED',
          `Tax return ${id} has not been prepared; there are no figures to approve.`,
          { details: { id, status: ret.status } },
        );
      }
      // doc 14 SoD: preparer and approver must differ. The DB CHECK
      // (tax_returns_sod) is the backstop; this is the version with a message.
      if (ret.prepared_by === principal.userId) {
        throw new AppError(
          'SEGREGATION_OF_DUTIES',
          'The preparer of a tax return cannot approve it (doc 14). A second person ' +
            'checking the figures is the control, not a formality.',
          { details: { id, prepared_by: ret.prepared_by } },
        );
      }

      const { rows } = await client.query<TaxReturnRow>(
        `UPDATE tax_returns
            SET status = 'READY', approved_by = $2, approved_at = now()
          WHERE id = $1
          RETURNING ${RETURN_COLUMNS}`,
        [id, principal.userId],
      );
      const approved = rows[0]!;

      await publish(client, context, {
        eventType: 'tax_return.ready',
        aggregateType: 'tax_return',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: ret.legal_entity_id,
        payload: { form_code: ret.form_code, tax_period_id: ret.tax_period_id },
      });
      await recordAudit(client, context, {
        action: 'tax_return.approved',
        resourceType: 'tax_return',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: ret.legal_entity_id,
        before: ret,
        after: approved,
      });
      return approved;
    });
  }

  // -------------------------------------------------------------------------
  // POST /tax-returns/{id}/mark-filed
  // -------------------------------------------------------------------------

  /**
   * Filing requires the tax period CLOSED. `closePeriod` refuses while any
   * source document in range is unposted, so a closed period is the system's
   * statement that the period's facts are complete — filing over an open period
   * would put the government's copy ahead of the ledger's. And because nothing
   * physically stops a later posting into the closed period's date range, the
   * snapshot is re-verified against the subledger here: a return files what the
   * subledger says at the moment of filing, or it does not file.
   */
  async markTaxReturnFiled(
    principal: TenantPrincipal,
    id: string,
    input: { filingReference: string; filingEvidenceFileId?: string | undefined },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const ret = await this.loadReturnForUpdate(client, id);
      assertEntityPermission(principal, 'tax_return.file', ret.legal_entity_id);

      if (ret.status === 'FILED' || ret.status === 'AMENDED') {
        throw new AppError(
          'POSTED_IMMUTABLE',
          `Tax return ${id} is already ${ret.status}. A filed return is corrected by an ` +
            'amending return, never by filing again.',
          { details: { id, status: ret.status } },
        );
      }
      if (ret.status !== 'READY' || !ret.snapshot) {
        throw new AppError(
          'PRECONDITION_FAILED',
          `Tax return ${id} is ${ret.status}; it must be prepared and approved (READY) ` +
            'before it can be marked filed (doc 14 SoD).',
          { details: { id, status: ret.status } },
        );
      }

      const { period, partition } = await this.assembleReturnFacts(client, ret);
      if (period.status !== 'CLOSED') {
        throw new AppError(
          'PRECONDITION_FAILED',
          `Tax period ${period.name} is still ${period.status}. Close it first: an open ` +
            'period can still accept postings, and a return filed over one is contradicted ' +
            'by the next document.',
          { details: { tax_period_id: period.id, status: period.status } },
        );
      }

      // The snapshot must equal the subledger now, not as of preparation. A
      // transaction posted between prepare and file would otherwise be covered
      // by this return's period without appearing on it — silently dropped.
      const reportable = [...partition.current, ...partition.late].map((r) => r.id).sort();
      const recorded = [...ret.snapshot.transaction_ids].sort();
      const unchanged =
        reportable.length === recorded.length && reportable.every((v, i) => v === recorded[i]);
      if (!unchanged) {
        throw new AppError(
          'PRECONDITION_FAILED',
          `The tax subledger changed since this return was prepared (${recorded.length} ` +
            `transactions on the snapshot, ${reportable.length} reportable now). ` +
            'Re-prepare and re-approve so the filed snapshot matches the evidence.',
          { details: { id, snapshot_count: recorded.length, reportable_count: reportable.length } },
        );
      }

      const { rows } = await client.query<TaxReturnRow>(
        `UPDATE tax_returns
            SET status = 'FILED', filed_at = now(), filing_reference = $2,
                filing_evidence_file_id = coalesce($3, filing_evidence_file_id)
          WHERE id = $1
          RETURNING ${RETURN_COLUMNS}`,
        [id, input.filingReference, input.filingEvidenceFileId ?? null],
      );
      const filed = rows[0]!;

      // FILED -> AMENDED is the one transition a filed return makes, and only
      // when its replacement has itself been filed — the original stays the
      // authoritative filing until then.
      if (ret.amends_return_id) {
        const { rows: superseded } = await client.query<{ id: string }>(
          `UPDATE tax_returns SET status = 'AMENDED' WHERE id = $1 AND status = 'FILED'
           RETURNING id`,
          [ret.amends_return_id],
        );
        if (superseded[0]) {
          await publish(client, context, {
            eventType: 'tax_return.amended',
            aggregateType: 'tax_return',
            aggregateId: ret.amends_return_id,
            tenantId: principal.tenantId,
            legalEntityId: ret.legal_entity_id,
            payload: { amended_by: id },
          });
        }
      }

      await publish(client, context, {
        eventType: 'tax_return.filed',
        aggregateType: 'tax_return',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: ret.legal_entity_id,
        payload: {
          form_code: ret.form_code,
          tax_period_id: ret.tax_period_id,
          filing_reference: input.filingReference,
          net_payable: ret.snapshot.totals.net_payable,
        },
      });
      await recordAudit(client, context, {
        action: 'tax_return.filed',
        resourceType: 'tax_return',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: ret.legal_entity_id,
        before: ret,
        after: filed,
      });
      return filed;
    });
  }

  // -------------------------------------------------------------------------
  // Shared plumbing
  // -------------------------------------------------------------------------

  private async loadReturnForUpdate(client: PoolClient, id: string): Promise<TaxReturnRow> {
    const { rows } = await client.query<TaxReturnRow>(
      `SELECT ${RETURN_COLUMNS} FROM tax_returns WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!rows[0]) throw notFound('tax return', id);
    return rows[0];
  }

  private async loadPeriod(client: PoolClient, id: string): Promise<TaxPeriodRow> {
    const { rows } = await client.query<TaxPeriodRow>(
      `SELECT id, legal_entity_id, jurisdiction, name, start_date::text AS start_date,
              end_date::text AS end_date, status::text AS status
         FROM tax_periods WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound('tax period', id);
    return rows[0];
  }

  /**
   * Everything a preparation (or the filing re-verification) needs: the period,
   * what earlier filed returns already reported, and the candidate rows
   * partitioned by the invariant.
   */
  private async assembleReturnFacts(client: PoolClient, ret: TaxReturnRow) {
    const period = await this.loadPeriod(client, ret.tax_period_id);
    const coverage = await this.loadFiledCoverage(
      client,
      ret.legal_entity_id,
      period.jurisdiction,
      ret.form_code,
      period.start_date,
    );
    const lowerBound = coverage.reduce(
      (a, c) => (c.startDate < a ? c.startDate : a),
      period.start_date,
    );
    const rows = await this.loadCandidates(
      client,
      ret.legal_entity_id,
      lowerBound,
      period.end_date,
      ret.tax_period_id,
    );
    const partition = partitionForReturn(
      rows,
      { startDate: period.start_date, endDate: period.end_date },
      coverage,
    );
    return { period, partition };
  }

  private async loadFiledCoverage(
    client: PoolClient,
    legalEntityId: string,
    jurisdiction: string,
    formCode: string,
    beforeDate: string,
  ): Promise<FiledCoverage[]> {
    const { rows } = await client.query<{
      period_id: string;
      start_date: string;
      end_date: string;
      snapshot: { transaction_ids?: string[] } | null;
    }>(
      `SELECT p.id AS period_id, p.start_date::text AS start_date,
              p.end_date::text AS end_date, r.snapshot
         FROM tax_returns r
         JOIN tax_periods p ON p.id = r.tax_period_id
        WHERE p.legal_entity_id = $1 AND p.jurisdiction = $2 AND r.form_code = $3
          AND r.status IN ('FILED','AMENDED')
          AND p.end_date < $4::date`,
      [legalEntityId, jurisdiction, formCode, beforeDate],
    );
    const byPeriod = new Map<string, { startDate: string; endDate: string; ids: Set<string> }>();
    for (const row of rows) {
      let entry = byPeriod.get(row.period_id);
      if (!entry) {
        entry = { startDate: row.start_date, endDate: row.end_date, ids: new Set() };
        byPeriod.set(row.period_id, entry);
      }
      // Every filed version counts: an amended original and its replacement
      // have each reported their ids, and none of them may be reported again.
      for (const txnId of row.snapshot?.transaction_ids ?? []) entry.ids.add(txnId);
    }
    return [...byPeriod.values()].map((e) => ({
      startDate: e.startDate,
      endDate: e.endDate,
      reportedTransactionIds: e.ids,
    }));
  }

  private async loadCandidates(
    client: PoolClient,
    legalEntityId: string,
    fromDate: string,
    toDate: string,
    taxPeriodId: string,
  ): Promise<ReturnTransactionRow[]> {
    // Primary book only: the statutory return files from the statutory book.
    // tax_transactions are book-aware (F-024), so a secondary book's parallel
    // postings would double every figure if aggregated together.
    //
    // The stamp comes first (F-720). `TaxService.recordTransactions` decides at
    // posting time which return will report a transaction, and migration 0036
    // revokes UPDATE on the table, so that decision cannot later be edited. The
    // date range remains for rows written before an entity had tax periods, which
    // carry no stamp — an unstamped row is still a fact that has to be reported.
    const { rows } = await client.query<ReturnTransactionRow>(
      `SELECT t.id, t.posting_date::text AS posting_date, t.direction,
              tc.code AS tax_code, comp.code AS component_code, t.currency,
              t.taxable_amount::text AS taxable_amount, t.tax_amount::text AS tax_amount,
              t.base_taxable_amount::text AS base_taxable_amount,
              t.base_tax_amount::text AS base_tax_amount,
              t.recoverable_amount::text AS recoverable_amount,
              t.nonrecoverable_amount::text AS nonrecoverable_amount
         FROM tax_transactions t
         JOIN accounting_books b ON b.id = t.accounting_book_id AND b.is_primary
         JOIN tax_codes tc ON tc.id = t.tax_code_id
         LEFT JOIN tax_components comp ON comp.id = t.tax_component_id
        WHERE t.legal_entity_id = $1
          AND (t.tax_period_id = $4
               OR (t.tax_period_id IS NULL AND t.posting_date BETWEEN $2::date AND $3::date))
        ORDER BY t.posting_date, t.created_at`,
      [legalEntityId, fromDate, toDate, taxPeriodId],
    );
    return rows;
  }
}
