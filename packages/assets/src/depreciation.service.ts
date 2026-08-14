import { Pool } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  D,
  sumExact,
  assertEntityPermission,
  type Decimal,
  type TenantPrincipal,
  type DraftLineInput,
} from '@acct/domain';
import { writeInTenant, readInTenant, recordAudit } from '@acct/database';
import { PostingService } from '@acct/ledger';
import { DocumentPostingService } from '@acct/subledger';
import { loadFixedAsset } from './register.service';

/**
 * The depreciation run — doc 09's eight-step algorithm, and Phase 5 exit
 * criterion 5: "Depreciation rerun is idempotent for same asset/book/period."
 *
 * Idempotency here is layered, deliberately, because each layer catches a
 * different failure:
 *
 *   1. This service posts only lines whose status is SCHEDULED, claimed with
 *      `FOR UPDATE SKIP LOCKED` (ADR-0004) — a concurrent run claims disjoint
 *      lines instead of deadlocking or double-reading.
 *   2. A rerun that finds nothing eligible is a no-op that returns the
 *      original POSTED run, not an error: retrying a month-end job must be
 *      boring.
 *   3. `UNIQUE (asset_book_id, accounting_period_id)` blocks a second line per
 *      asset/book/period, and guard_depreciation_line_posted (0043) blocks the
 *      rerun that UPDATEs the existing POSTED line. The database holds the
 *      criterion even if this service is bypassed.
 */

export interface ScheduleLineCandidate {
  readonly id: string;
  readonly assetBookId: string;
  readonly status: string;
  readonly scheduledAmount: string;
  readonly depreciationExpenseAccountId: string;
  readonly accumulatedDepreciationAccountId: string;
}

/**
 * The eligibility rule, stated once: only a SCHEDULED line posts.
 *
 * A POSTED line already has a journal — posting it again is the double-charge
 * exit criterion 5 forbids. A SKIPPED or REVISED line was deliberately taken
 * out of play. The run's SQL applies the same filter; this function exists so
 * the rule is testable without a database, in both directions: a rerun selects
 * nothing, and a new asset's SCHEDULED line in an already-run period still
 * selects.
 */
export function eligibleScheduleLines<T extends { readonly status: string }>(
  lines: readonly T[],
): T[] {
  return lines.filter((line) => line.status === 'SCHEDULED');
}

/**
 * Aggregates eligible lines into the run's journal: Dr Depreciation Expense /
 * Cr Accumulated Depreciation, summed per account so a hundred assets in one
 * category produce two lines, not two hundred — while assets of different
 * categories keep their own account pairs.
 */
export function depreciationRunLines(lines: readonly ScheduleLineCandidate[]): {
  drafts: DraftLineInput[];
  total: Decimal;
} {
  const debits = new Map<string, Decimal>();
  const credits = new Map<string, Decimal>();
  for (const line of lines) {
    const amount = D(line.scheduledAmount);
    if (!amount.isPositive()) {
      // buildSchedule never emits a zero or negative charge, so one arriving
      // here means the stored schedule was corrupted — posting it would either
      // do nothing or credit expense.
      throw new AppError(
        'VALIDATION_FAILED',
        `Schedule line ${line.id} carries ${amount.toString()}, which is not a depreciation charge.`,
        { details: { schedule_line_id: line.id } },
      );
    }
    debits.set(
      line.depreciationExpenseAccountId,
      (debits.get(line.depreciationExpenseAccountId) ?? D('0')).add(amount),
    );
    credits.set(
      line.accumulatedDepreciationAccountId,
      (credits.get(line.accumulatedDepreciationAccountId) ?? D('0')).add(amount),
    );
  }

  const drafts: DraftLineInput[] = [];
  for (const [accountId, amount] of debits) {
    drafts.push({ accountId, description: 'Depreciation expense', debit: amount.toString() });
  }
  for (const [accountId, amount] of credits) {
    drafts.push({ accountId, description: 'Accumulated depreciation', credit: amount.toString() });
  }
  const total = sumExact(lines.map((line) => D(line.scheduledAmount)));
  return { drafts, total };
}

interface ClaimedLine {
  id: string;
  asset_book_id: string;
  fixed_asset_id: string;
  scheduled_amount: string;
  status: string;
  currency: string;
  depreciation_expense_account_id: string;
  accumulated_depreciation_account_id: string;
}

export class DepreciationRunService {
  constructor(
    private readonly pool: Pool,
    private readonly posting: PostingService,
    private readonly documents: DocumentPostingService,
  ) {}

  async createDepreciationRun(
    principal: TenantPrincipal,
    input: { accountingBookId: string; accountingPeriodId: string },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: periods } = await client.query<{
        id: string;
        legal_entity_id: string;
        name: string;
        end_date: string;
      }>(
        `SELECT id, legal_entity_id, name, end_date::text AS end_date
           FROM accounting_periods WHERE id = $1`,
        [input.accountingPeriodId],
      );
      const period = periods[0];
      if (!period) throw notFound('accounting_period', input.accountingPeriodId);

      // Depreciation belongs to the period, so it posts on the period's last
      // day — loadBookContext also verifies the book exists and is ACTIVE.
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        period.end_date,
      );
      if (book.legalEntityId !== period.legal_entity_id) {
        throw new AppError(
          'BOOK_MISMATCH',
          `Period ${input.accountingPeriodId} belongs to another legal entity than book ` +
            `${input.accountingBookId}.`,
          {
            details: {
              accounting_book_id: input.accountingBookId,
              accounting_period_id: period.id,
            },
          },
        );
      }
      assertEntityPermission(principal, 'asset.depreciate', book.legalEntityId);

      // Step 2 of doc 09's algorithm: load ELIGIBLE UNPOSTED lines — and claim
      // them. SKIP LOCKED (ADR-0004) means two concurrent runs partition the
      // lines instead of both reading all of them; whichever posts a line
      // first owns it, and the other never saw it.
      const { rows: claimed } = await client.query<ClaimedLine>(
        `SELECT l.id, l.asset_book_id, a.id AS fixed_asset_id,
                l.scheduled_amount::text AS scheduled_amount, l.status::text AS status,
                a.currency, c.depreciation_expense_account_id,
                c.accumulated_depreciation_account_id
           FROM depreciation_schedule_lines l
           JOIN asset_books b ON b.id = l.asset_book_id
           JOIN fixed_assets a ON a.id = b.fixed_asset_id
           JOIN asset_categories c ON c.id = a.asset_category_id
          WHERE l.accounting_period_id = $1
            AND l.status = 'SCHEDULED'
            AND b.accounting_book_id = $2
            AND b.status = 'ACTIVE'
          ORDER BY l.id
            FOR UPDATE OF l SKIP LOCKED`,
        [input.accountingPeriodId, input.accountingBookId],
      );
      const lines = eligibleScheduleLines(claimed);

      const { rows: postedRuns } = await client.query<{
        id: string;
        total_amount: string;
        journal_entry_id: string | null;
        version: number;
        created_at: string;
      }>(
        `SELECT id, total_amount::text AS total_amount, journal_entry_id, version, created_at
           FROM depreciation_runs
          WHERE legal_entity_id = $1 AND accounting_book_id = $2 AND accounting_period_id = $3
            AND status = 'POSTED'`,
        [book.legalEntityId, input.accountingBookId, input.accountingPeriodId],
      );
      const postedRun = postedRuns[0];

      if (lines.length === 0) {
        if (postedRun) {
          // Exit criterion 5's first half: the rerun posts nothing and hands
          // back the run that already did the work, exactly as a replayed
          // document posting hands back its original entry.
          return {
            id: postedRun.id,
            accounting_book_id: input.accountingBookId,
            accounting_period_id: input.accountingPeriodId,
            status: 'POSTED',
            total_amount: postedRun.total_amount,
            journal_entry_id: postedRun.journal_entry_id,
            version: postedRun.version,
            lines_posted: 0,
            replayed: true,
          };
        }
        throw new AppError(
          'VALIDATION_FAILED',
          `No schedule line is eligible for period ${period.name} in this book. Either nothing ` +
            `is capitalized into the period, or another run is claiming the lines right now.`,
          {
            details: {
              accounting_period_id: period.id,
              accounting_book_id: input.accountingBookId,
            },
          },
        );
      }

      if (postedRun) {
        // Exit criterion 5's second half — an asset capitalized after the
        // period's run should still post — is blocked by the schema, not this
        // service: depreciation_runs_posted_uq admits ONE POSTED run per
        // entity/book/period, so these lines cannot reach a POSTED run of
        // their own. Refused with the facts named rather than surfacing the
        // unique-index violation as a 500 at COMMIT (the F-809 lesson).
        throw new AppError(
          'POSTED_IMMUTABLE',
          `Run ${postedRun.id} already posted depreciation for period ${period.name}, and ` +
            `depreciation_runs_posted_uq admits one POSTED run per entity/book/period — the ` +
            `${lines.length} newly eligible line(s) cannot post until that index is rekeyed. ` +
            `They remain SCHEDULED and will post with the next period's run once it is.`,
          {
            details: {
              posted_run_id: postedRun.id,
              eligible_lines: lines.length,
              accounting_period_id: period.id,
            },
          },
        );
      }

      const { drafts, total } = depreciationRunLines(
        lines.map((line) => ({
          id: line.id,
          assetBookId: line.asset_book_id,
          status: line.status,
          scheduledAmount: line.scheduled_amount,
          depreciationExpenseAccountId: line.depreciation_expense_account_id,
          accumulatedDepreciationAccountId: line.accumulated_depreciation_account_id,
        })),
      );

      const runId = uuidv7();
      await client.query(
        `INSERT INTO depreciation_runs
           (id, tenant_id, legal_entity_id, accounting_book_id, accounting_period_id, version,
            status, total_amount)
         VALUES ($1,$2,$3,$4,$5,
                 (SELECT count(*) + 1 FROM depreciation_runs
                   WHERE legal_entity_id = $3 AND accounting_book_id = $4
                     AND accounting_period_id = $5),
                 'DRAFT',$6)`,
        [
          runId,
          principal.tenantId,
          book.legalEntityId,
          input.accountingBookId,
          input.accountingPeriodId,
          total.toString(),
        ],
      );

      // The event id is the run's, not the period's: a later incremental run
      // for the same period (once the unique index allows one) must produce
      // its own journal, not replay-return this one.
      const result = await this.documents.post(client, context, principal, book, {
        ruleCode: 'ASSET_DEPRECIATION',
        sourceType: 'depreciation_run',
        sourceId: runId,
        sourceEventId: `asset.depreciation_posted:${runId}`,
        journalCode: 'GEN',
        postingDate: period.end_date,
        documentDate: period.end_date,
        description: `Depreciation ${period.name}`,
        branchId: null,
        contactId: null,
        lines: drafts,
      });

      // Step 7: mark the EXACT lines this run claimed. Guard 0043 permits
      // SCHEDULED -> POSTED and will refuse any later touch of these rows.
      await client.query(
        `UPDATE depreciation_schedule_lines
            SET status = 'POSTED', posted_amount = scheduled_amount,
                depreciation_run_id = $2, journal_entry_id = $3
          WHERE id = ANY($1::uuid[])`,
        [lines.map((line) => line.id), runId, result.entry.id],
      );

      // The book's running accumulated total, and the per-asset history row.
      // asset_books.accumulated_depreciation is current state, not history —
      // the history is asset_transactions and the schedule lines themselves.
      for (const line of lines) {
        await client.query(
          `UPDATE asset_books
              SET accumulated_depreciation = accumulated_depreciation + $2
            WHERE id = $1`,
          [line.asset_book_id, line.scheduled_amount],
        );
        await client.query(
          `INSERT INTO asset_transactions
             (id, tenant_id, legal_entity_id, fixed_asset_id, asset_book_id, kind, posting_date,
              amount, currency, journal_entry_id)
           VALUES ($1,$2,$3,$4,$5,'DEPRECIATION',$6,$7,$8,$9)`,
          [
            uuidv7(),
            principal.tenantId,
            book.legalEntityId,
            line.fixed_asset_id,
            line.asset_book_id,
            period.end_date,
            line.scheduled_amount,
            line.currency,
            result.entry.id,
          ],
        );
      }

      const { rows: runs } = await client.query(
        `UPDATE depreciation_runs
            SET status = 'POSTED', journal_entry_id = $2, approved_by = $3, approved_at = now()
          WHERE id = $1
        RETURNING id, legal_entity_id, accounting_book_id, accounting_period_id, version,
                  status::text AS status, total_amount::text AS total_amount, journal_entry_id,
                  created_at`,
        [runId, result.entry.id, principal.userId],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: book.legalEntityId,
        action: 'asset.depreciation_posted',
        resourceType: 'depreciation_run',
        resourceId: runId,
        after: { ...(runs[0] as Record<string, unknown>), lines_posted: lines.length },
      });

      return { ...runs[0], lines_posted: lines.length, replayed: false };
    });
  }

  /**
   * F-910: doc 09's Depreciation Schedule report per asset book — period,
   * expected amount, posted amount, journal and status. Exit criterion 5 is
   * about a rerun not posting twice, and a schedule nobody can read gives that
   * no evidence.
   */
  async getDepreciationSchedule(
    principal: TenantPrincipal,
    fixedAssetId: string,
    query: { accountingBookId?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const asset = await loadFixedAsset(client, fixedAssetId);
      assertEntityPermission(principal, 'asset.view', asset.legal_entity_id);

      const { rows } = await client.query(
        `SELECT l.id, l.asset_book_id, b.accounting_book_id, p.id AS accounting_period_id,
                p.name AS period_name, p.start_date::text AS period_start,
                p.end_date::text AS period_end, l.revision,
                l.scheduled_amount::text AS scheduled_amount,
                l.posted_amount::text AS posted_amount, l.status::text AS status,
                l.depreciation_run_id, l.journal_entry_id
           FROM depreciation_schedule_lines l
           JOIN asset_books b ON b.id = l.asset_book_id
           JOIN accounting_periods p ON p.id = l.accounting_period_id
          WHERE b.fixed_asset_id = $1
            AND ($2::uuid IS NULL OR b.accounting_book_id = $2)
          ORDER BY b.accounting_book_id, p.start_date`,
        [fixedAssetId, query.accountingBookId ?? null],
      );
      return { data: rows };
    });
  }
}
