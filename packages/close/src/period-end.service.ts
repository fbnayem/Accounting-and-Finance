/**
 * Period-end entries — doc 21 Phase 6's "accrual/prepaid/deferred entries"
 * (F-1004), the one thing period close exists to do: put a cost or a revenue in
 * the period it belongs to.
 *
 * Three shapes, one resource, because they are one idea — an amount recognised
 * in a period other than the one it was billed or paid in — and `entry_type`
 * selects the posting rule:
 *
 *   ACCRUAL   EXPENSE_ACCRUAL           Dr Expense            / Cr Accrued Liability
 *   PREPAID   PREPAID_PURCHASE          Dr Prepaid Asset      / Cr AP/Bank
 *   DEFERRAL  DEFERRED_REVENUE_BILLING  Dr AR/Bank            / Cr Deferred Revenue
 *
 * and recognition releases one period's portion:
 *
 *   PREPAID   PREPAID_AMORTIZATION      Dr Expense            / Cr Prepaid Asset
 *   DEFERRAL  REVENUE_RECOGNIZED        Dr Deferred Revenue   / Cr Revenue
 *
 * Two design decisions worth stating plainly:
 *
 *   - **Nothing here composes a journal.** Every posting goes through
 *     `DocumentPostingService` under a named catalog rule, so the period lock,
 *     the entry number, the balance assertion and the approval threshold are the
 *     same ones an invoice gets. This package writes the SCHEDULE the postings
 *     serve, never the postings.
 *   - **An accrual's reversal is not a second machine.** It is a
 *     `scheduled_reversals` row (F-612), registered in the SAME transaction as
 *     the accrual journal — atomically, because an accrual that posts and then
 *     fails to schedule its reversal is a permanent misstatement — and claimed
 *     by `ledger_claim_due_reversals` exactly like every other schedule. The
 *     row is inserted here rather than through `JournalService.scheduleReversal`
 *     because that method opens its own transaction (it could neither see the
 *     uncommitted journal nor die with it) and demands `journal.reverse`, a
 *     permission the contract deliberately does not require for
 *     `period_end_entry.create`. The shape written is identical, including the
 *     audit action, and `scheduled_reversals_one_pending_idx` applies unchanged.
 */
import { Pool, PoolClient } from 'pg';
import {
  AppError,
  D,
  MONEY_SCALE,
  assertEntityPermission,
  entityScope,
  notFound,
  uuidv7,
  type DraftLineInput,
  type TenantPrincipal,
} from '@acct/domain';
import { publish, readInTenant, recordAudit, writeInTenant } from '@acct/database';
import { PostingService, type BookContext } from '@acct/ledger';
import { DocumentPostingService } from '@acct/subledger';
import { assertSameEntity, loadPeriod } from './internals';

export type PeriodEndEntryType = 'ACCRUAL' | 'PREPAID' | 'DEFERRAL';

export interface CreatePeriodEndEntryInput {
  readonly accountingBookId: string;
  readonly postingDate: string;
  readonly entryType: PeriodEndEntryType;
  readonly description: string;
  /** Exact decimal string in the book's base currency (ADR-0006 §1). */
  readonly totalAmount: string;
  /** Accrued liability, prepaid asset or deferred revenue. */
  readonly balanceAccountId: string;
  /** The expense or revenue account. */
  readonly plAccountId: string;
  /** AP/bank (PREPAID) or AR/bank (DEFERRAL). Refused for ACCRUAL. */
  readonly settlementAccountId?: string | undefined;
  /** ACCRUAL only: the date the reversal posts. Required. */
  readonly reversalDate?: string | undefined;
  /** PREPAID/DEFERRAL only: when recognition starts and over how many periods. */
  readonly recognitionStartDate?: string | undefined;
  readonly recognitionPeriods?: number | undefined;
}

export interface ListPeriodEndEntriesQuery {
  readonly accountingBookId?: string | undefined;
  readonly periodFrom?: string | undefined;
  readonly periodTo?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

// ---------------------------------------------------------------------------
// The schedule arithmetic — pure, exact decimal, unit-tested.
// ---------------------------------------------------------------------------

/** total − recognised, as a canonical decimal string. */
export function remainingBalance(totalAmount: string, recognizedTotal: string): string {
  return D(totalAmount).sub(D(recognizedTotal)).toString();
}

/**
 * The straight-line portion for the next recognition.
 *
 * Rounded to the currency's minor unit (HALF_UP, ADR-0006 §4) so eleven months of
 * a 1200.00 prepaid are 100.00 each — and the FINAL tranche takes whatever
 * remains, so the twelve postings sum to the total exactly rather than to twelve
 * roundings of it. 100.00 over 3 is therefore 33.33, 33.33, 33.34.
 */
export function recognitionPortion(input: {
  readonly totalAmount: string;
  readonly recognitionPeriods: number;
  readonly recognizedTotal: string;
  readonly recognizedCount: number;
  readonly minorUnit: number;
}): string {
  const remaining = D(input.totalAmount).sub(D(input.recognizedTotal));
  if (!remaining.isPositive()) return remaining.toString();
  if (input.recognizedCount >= input.recognitionPeriods - 1) {
    return remaining.toString();
  }
  const portion = D(input.totalAmount).div(D(input.recognitionPeriods), input.minorUnit, 'HALF_UP');
  if (portion.isZero() || portion.gt(remaining)) return remaining.toString();
  return portion.toString();
}

// ---------------------------------------------------------------------------

const RULE_BY_TYPE: Record<PeriodEndEntryType, string> = {
  ACCRUAL: 'EXPENSE_ACCRUAL',
  PREPAID: 'PREPAID_PURCHASE',
  DEFERRAL: 'DEFERRED_REVENUE_BILLING',
};

const RECOGNITION_RULE: Record<'PREPAID' | 'DEFERRAL', string> = {
  PREPAID: 'PREPAID_AMORTIZATION',
  DEFERRAL: 'REVENUE_RECOGNIZED',
};

interface EntryRow {
  id: string;
  tenant_id: string;
  legal_entity_id: string;
  accounting_book_id: string;
  accounting_period_id: string;
  entry_type: PeriodEndEntryType;
  description: string;
  currency: string;
  total_amount: string;
  balance_account_id: string;
  pl_account_id: string;
  settlement_account_id: string | null;
  recognition_start_date: string | null;
  recognition_periods: number | null;
  posting_date: string;
  journal_entry_id: string;
  scheduled_reversal_id: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
}

const ENTRY_COLUMNS = `e.id, e.tenant_id, e.legal_entity_id, e.accounting_book_id,
       e.accounting_period_id, e.entry_type, e.description, e.currency,
       e.total_amount::text AS total_amount, e.balance_account_id, e.pl_account_id,
       e.settlement_account_id, e.recognition_start_date::text AS recognition_start_date,
       e.recognition_periods, e.posting_date::text AS posting_date, e.journal_entry_id,
       e.scheduled_reversal_id, e.status, e.created_by, e.created_at`;

export class PeriodEndEntryService {
  constructor(
    private readonly pool: Pool,
    private readonly posting: PostingService,
    private readonly documents: DocumentPostingService,
  ) {}

  /** `createPeriodEndEntry` — POST /period-end-entries. */
  async create(principal: TenantPrincipal, input: CreatePeriodEndEntryInput) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      assertEntityPermission(principal, 'period_end_entry.create', book.legalEntityId);

      // Canonicalised to numeric(24,8)'s scale at the boundary, so the amount in
      // this response and the amount every later read returns are byte-identical.
      const total = D(input.totalAmount, MONEY_SCALE);
      if (!total.isPositive()) {
        throw new AppError(
          'VALIDATION_FAILED',
          `A period-end entry's amount is positive; the direction comes from entry_type, not from ` +
            `a sign.`,
          {
            fieldErrors: [{ field: 'total_amount', code: 'NOT_POSITIVE', message: 'must be > 0' }],
          },
        );
      }
      if (input.balanceAccountId === input.plAccountId) {
        throw new AppError(
          'VALIDATION_FAILED',
          'The balance-sheet account and the P&L account are the same account, so the posting ' +
            'would defer nothing.',
        );
      }

      if (input.entryType === 'ACCRUAL') {
        if (!input.reversalDate) {
          throw new AppError(
            'VALIDATION_FAILED',
            'An accrual must say when it reverses: an accrual that never unwinds is a permanent ' +
              'misstatement, so reversal_date is required (doc 21 Phase 6, F-612).',
            { fieldErrors: [{ field: 'reversal_date', code: 'REQUIRED', message: 'required' }] },
          );
        }
        if (input.reversalDate <= input.postingDate) {
          throw new AppError(
            'VALIDATION_FAILED',
            `A reversal scheduled for ${input.reversalDate} is not after the posting date ` +
              `${input.postingDate}. An accrual reverses in a later period, not its own.`,
            {
              fieldErrors: [
                { field: 'reversal_date', code: 'TOO_EARLY', message: 'not after posting_date' },
              ],
            },
          );
        }
        if (input.settlementAccountId) {
          throw new AppError(
            'VALIDATION_FAILED',
            'An accrual has two sides — expense and accrued liability — and no settlement ' +
              'account; it settles when the real bill arrives and the reversal has cleared it.',
          );
        }
        if (input.recognitionStartDate || input.recognitionPeriods) {
          throw new AppError(
            'VALIDATION_FAILED',
            'An accrual carries no recognition schedule: it unwinds through its scheduled ' +
              'reversal, not through POST /period-end-entries/{id}/recognize.',
          );
        }
      } else {
        if (!input.settlementAccountId) {
          throw new AppError(
            'VALIDATION_FAILED',
            `A ${input.entryType} entry must name the account its initial posting settles ` +
              `against — AP or bank for a prepaid, AR or bank for a deferral.`,
            {
              fieldErrors: [
                { field: 'settlement_account_id', code: 'REQUIRED', message: 'required' },
              ],
            },
          );
        }
        if (!input.recognitionStartDate || !input.recognitionPeriods) {
          throw new AppError(
            'VALIDATION_FAILED',
            `A ${input.entryType} entry needs its recognition schedule — recognition_start_date ` +
              `and recognition_periods — because the balance it creates is only explainable ` +
              `against the schedule that releases it.`,
          );
        }
        if (input.reversalDate) {
          throw new AppError(
            'VALIDATION_FAILED',
            `A ${input.entryType} entry does not reverse; its balance releases through ` +
              `POST /period-end-entries/{id}/recognize. reversal_date is for accruals.`,
          );
        }
      }

      const id = uuidv7();
      const lines = this.initialLines(input, book);
      const result = await this.documents.post(client, context, principal, book, {
        ruleCode: RULE_BY_TYPE[input.entryType],
        sourceType: 'period_end_entry',
        sourceId: id,
        sourceEventId: `period_end_entry.created:${id}`,
        journalCode: 'GEN',
        postingDate: input.postingDate,
        documentDate: input.postingDate,
        description: input.description,
        branchId: null,
        contactId: null,
        lines,
      });

      // The reversal, registered with the F-612 machine in the same transaction.
      let scheduledReversalId: string | null = null;
      if (input.entryType === 'ACCRUAL') {
        scheduledReversalId = uuidv7();
        await client.query(
          `INSERT INTO scheduled_reversals (id, tenant_id, legal_entity_id, accounting_book_id,
                                            journal_entry_id, scheduled_date, reason, created_by)
           VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8)`,
          [
            scheduledReversalId,
            principal.tenantId,
            book.legalEntityId,
            book.bookId,
            result.entry.id,
            input.reversalDate,
            `Accrual reversal: ${input.description}`,
            principal.userId,
          ],
        );
        // The same action JournalService.scheduleReversal records, so the audit
        // trail reads identically however the schedule was made.
        await recordAudit(client, context, {
          action: 'journal.reversal_scheduled',
          resourceType: 'journal_entry',
          resourceId: result.entry.id,
          tenantId: principal.tenantId,
          legalEntityId: book.legalEntityId,
          reason: `Accrual reversal: ${input.description}`,
          after: {
            scheduled_reversal_id: scheduledReversalId,
            scheduled_date: input.reversalDate,
            period_end_entry_id: id,
          },
        });
      }

      await client.query(
        `INSERT INTO period_end_entries
           (id, tenant_id, legal_entity_id, accounting_book_id, accounting_period_id,
            entry_type, description, currency, total_amount, balance_account_id, pl_account_id,
            settlement_account_id, recognition_start_date, recognition_periods, posting_date,
            journal_entry_id, scheduled_reversal_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10,$11,$12,$13::date,$14,$15::date,$16,$17,$18)`,
        [
          id,
          principal.tenantId,
          book.legalEntityId,
          book.bookId,
          result.entry.accounting_period_id,
          input.entryType,
          input.description,
          book.baseCurrency,
          total.toString(),
          input.balanceAccountId,
          input.plAccountId,
          input.settlementAccountId ?? null,
          input.recognitionStartDate ?? null,
          input.recognitionPeriods ?? null,
          input.postingDate,
          result.entry.id,
          scheduledReversalId,
          principal.userId,
        ],
      );

      await publish(client, context, {
        eventType: 'period_end_entry.created',
        aggregateType: 'period_end_entry',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: book.legalEntityId,
        accountingBookId: book.bookId,
        payload: {
          entry_type: input.entryType,
          total_amount: total.toString(),
          currency: book.baseCurrency,
          posting_date: input.postingDate,
          accounting_period_id: result.entry.accounting_period_id,
          journal_entry_id: result.entry.id,
          scheduled_reversal_id: scheduledReversalId,
          reversal_date: input.reversalDate ?? null,
          recognition_periods: input.recognitionPeriods ?? null,
        },
      });
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: book.legalEntityId,
        action: 'period_end_entry.created',
        resourceType: 'period_end_entry',
        resourceId: id,
        after: {
          entry_type: input.entryType,
          total_amount: total.toString(),
          journal_entry_id: result.entry.id,
          entry_number: result.entry.entry_number,
          scheduled_reversal_id: scheduledReversalId,
        },
      });

      return {
        id,
        legal_entity_id: book.legalEntityId,
        accounting_book_id: book.bookId,
        accounting_period_id: result.entry.accounting_period_id,
        entry_type: input.entryType,
        description: input.description,
        currency: book.baseCurrency,
        total_amount: total.toString(),
        recognized_total: D(0, MONEY_SCALE).toString(),
        remaining_balance: total.toString(),
        balance_account_id: input.balanceAccountId,
        pl_account_id: input.plAccountId,
        settlement_account_id: input.settlementAccountId ?? null,
        recognition_start_date: input.recognitionStartDate ?? null,
        recognition_periods: input.recognitionPeriods ?? null,
        posting_date: input.postingDate,
        status: 'ACTIVE',
        journal_entry_id: result.entry.id,
        entry_number: result.entry.entry_number,
        scheduled_reversal: scheduledReversalId
          ? {
              id: scheduledReversalId,
              scheduled_date: input.reversalDate,
              status: 'PENDING',
            }
          : null,
      };
    });
  }

  /** `recognizePeriodEndEntry` — POST /period-end-entries/{id}/recognize. */
  async recognize(
    principal: TenantPrincipal,
    id: string,
    input: { accountingPeriodId: string; amount?: string | undefined },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const entry = await loadEntry(client, id, 'FOR UPDATE');
      assertEntityPermission(principal, 'period_end_entry.recognize', entry.legal_entity_id);

      if (entry.entry_type === 'ACCRUAL') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Period-end entry ${id} is an ACCRUAL. It unwinds through its scheduled reversal ` +
            `(scheduled_reversals ${entry.scheduled_reversal_id}), which the ledger scheduler ` +
            `posts on its date — recognition applies to PREPAID and DEFERRAL entries only.`,
          { details: { scheduled_reversal_id: entry.scheduled_reversal_id } },
        );
      }

      const period = await loadPeriod(client, input.accountingPeriodId);
      assertSameEntity('Accounting period', entry.legal_entity_id, period.legal_entity_id, {
        accounting_period_id: period.id,
      });
      const { rows: periodMeta } = await client.query<{ is_adjustment: boolean }>(
        `SELECT is_adjustment FROM accounting_periods WHERE id = $1`,
        [period.id],
      );
      if (periodMeta[0]?.is_adjustment) {
        throw new AppError(
          'VALIDATION_FAILED',
          `${period.name} is an adjustment period. Recognition posts by date and an adjustment ` +
            `period is never resolved by date (F-403); post an adjustment journal instead.`,
        );
      }
      if (period.end_date < entry.posting_date) {
        throw new AppError(
          'VALIDATION_FAILED',
          `${period.name} ends ${period.end_date}, before this entry was posted ` +
            `(${entry.posting_date}). A balance cannot be released into a period earlier than ` +
            `the one that created it.`,
        );
      }

      // Idempotent per entry and period — the property 0046 gave depreciation
      // runs. `per_once_per_period` is the structural half; this read (under the
      // entry's FOR UPDATE) is what lets a rerun answer with the first run's
      // result rather than a constraint violation.
      const { rows: existing } = await client.query<{
        id: string;
        amount: string;
        journal_entry_id: string;
        recognized_at: string;
      }>(
        `SELECT id, amount::text AS amount, journal_entry_id, recognized_at
           FROM period_end_recognitions
          WHERE period_end_entry_id = $1 AND accounting_period_id = $2`,
        [id, period.id],
      );
      const recognizedBefore = await recognizedTotal(client, id);
      if (existing[0]) {
        return {
          id: existing[0].id,
          period_end_entry_id: id,
          accounting_period_id: period.id,
          amount: existing[0].amount,
          journal_entry_id: existing[0].journal_entry_id,
          recognized_at: existing[0].recognized_at,
          recognized_total: recognizedBefore.total,
          remaining_balance: remainingBalance(entry.total_amount, recognizedBefore.total),
          entry_status: entry.status,
          replayed: true,
        };
      }

      const remaining = D(entry.total_amount).sub(D(recognizedBefore.total));
      if (!remaining.isPositive()) {
        throw new AppError(
          'POSTED_IMMUTABLE',
          `Period-end entry ${id} is fully recognised: ${recognizedBefore.total} of ` +
            `${entry.total_amount} has been released over ${recognizedBefore.count} period(s). ` +
            `There is nothing left to recognise.`,
        );
      }

      const { rows: currencyRows } = await client.query<{ minor_unit: number }>(
        `SELECT minor_unit FROM currencies WHERE code = $1`,
        [entry.currency],
      );
      // Canonicalised to numeric(24,8)'s scale, so this response and a later
      // replay of it — which reads the stored row — are byte-identical.
      const amount = D(
        input.amount ??
          recognitionPortion({
            totalAmount: entry.total_amount,
            recognitionPeriods: entry.recognition_periods ?? 1,
            recognizedTotal: recognizedBefore.total,
            recognizedCount: recognizedBefore.count,
            minorUnit: currencyRows[0]?.minor_unit ?? 2,
          }),
        MONEY_SCALE,
      );
      if (!amount.isPositive()) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A recognition amount is positive; releasing a negative portion would be a new ' +
            'deferral, not a recognition.',
          { fieldErrors: [{ field: 'amount', code: 'NOT_POSITIVE', message: 'must be > 0' }] },
        );
      }
      if (amount.gt(remaining)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Recognising ${amount.toString()} would exceed the ${remaining.toString()} this entry ` +
            `still carries (${recognizedBefore.total} of ${entry.total_amount} already ` +
            `recognised). The database refuses the sum as well.`,
          {
            details: {
              amount: amount.toString(),
              remaining: remaining.toString(),
            },
          },
        );
      }

      const book = await this.posting.loadBookContext(
        client,
        principal,
        entry.accounting_book_id,
        period.end_date,
      );
      const rule = RECOGNITION_RULE[entry.entry_type as 'PREPAID' | 'DEFERRAL'];
      const lines: DraftLineInput[] =
        entry.entry_type === 'PREPAID'
          ? [
              {
                accountId: entry.pl_account_id,
                description: `Amortization: ${entry.description}`,
                transactionCurrency: book.baseCurrency,
                debit: amount.toString(),
              },
              {
                accountId: entry.balance_account_id,
                description: `Prepaid release: ${entry.description}`,
                transactionCurrency: book.baseCurrency,
                credit: amount.toString(),
              },
            ]
          : [
              {
                accountId: entry.balance_account_id,
                description: `Deferred revenue release: ${entry.description}`,
                transactionCurrency: book.baseCurrency,
                debit: amount.toString(),
              },
              {
                accountId: entry.pl_account_id,
                description: `Revenue recognised: ${entry.description}`,
                transactionCurrency: book.baseCurrency,
                credit: amount.toString(),
              },
            ];

      const result = await this.documents.post(client, context, principal, book, {
        ruleCode: rule,
        sourceType: 'period_end_entry',
        sourceId: id,
        // Deterministic per (entry, period): a redelivery finds the first journal
        // through journal_entries_source_event_uq rather than posting a second.
        sourceEventId: `period_end_entry.recognized:${id}:${period.id}`,
        journalCode: 'GEN',
        postingDate: period.end_date,
        documentDate: period.end_date,
        description: `${entry.description} — ${period.name}`,
        branchId: null,
        contactId: null,
        lines,
      });

      const recognitionId = uuidv7();
      await client.query(
        `INSERT INTO period_end_recognitions
           (id, tenant_id, legal_entity_id, period_end_entry_id, accounting_period_id,
            amount, journal_entry_id, recognized_by)
         VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,$8)`,
        [
          recognitionId,
          principal.tenantId,
          entry.legal_entity_id,
          id,
          period.id,
          amount.toString(),
          result.entry.id,
          principal.userId,
        ],
      );

      const newTotal = D(recognizedBefore.total).add(amount);
      const fullyRecognized = newTotal.equals(D(entry.total_amount));
      if (fullyRecognized) {
        await client.query(
          `UPDATE period_end_entries SET status = 'FULLY_RECOGNIZED' WHERE id = $1`,
          [id],
        );
      }

      await publish(client, context, {
        eventType: 'period_end_entry.recognized',
        aggregateType: 'period_end_entry',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: entry.legal_entity_id,
        accountingBookId: entry.accounting_book_id,
        payload: {
          accounting_period_id: period.id,
          amount: amount.toString(),
          journal_entry_id: result.entry.id,
          recognized_total: newTotal.toString(),
          remaining_balance: D(entry.total_amount).sub(newTotal).toString(),
          fully_recognized: fullyRecognized,
        },
      });
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: entry.legal_entity_id,
        action: 'period_end_entry.recognized',
        resourceType: 'period_end_entry',
        resourceId: id,
        after: {
          accounting_period_id: period.id,
          amount: amount.toString(),
          journal_entry_id: result.entry.id,
          entry_number: result.entry.entry_number,
          recognized_total: newTotal.toString(),
          status: fullyRecognized ? 'FULLY_RECOGNIZED' : 'ACTIVE',
        },
      });

      return {
        id: recognitionId,
        period_end_entry_id: id,
        accounting_period_id: period.id,
        period_name: period.name,
        amount: amount.toString(),
        journal_entry_id: result.entry.id,
        entry_number: result.entry.entry_number,
        recognized_total: newTotal.toString(),
        remaining_balance: D(entry.total_amount).sub(newTotal).toString(),
        entry_status: fullyRecognized ? 'FULLY_RECOGNIZED' : 'ACTIVE',
        replayed: false,
      };
    });
  }

  /** `listPeriodEndEntries` — GET /period-end-entries. */
  async list(principal: TenantPrincipal, query: ListPeriodEndEntriesQuery = {}) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const where = ['e.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];

      if (query.accountingBookId) {
        const { rows: books } = await client.query<{ legal_entity_id: string }>(
          `SELECT legal_entity_id FROM accounting_books WHERE id = $1 AND tenant_id = $2`,
          [query.accountingBookId, principal.tenantId],
        );
        if (!books[0]) throw notFound('Accounting book', query.accountingBookId);
        assertEntityPermission(principal, 'period_end_entry.view', books[0].legal_entity_id);
        params.push(query.accountingBookId);
        where.push(`e.accounting_book_id = $${params.length}`);
      } else {
        const scope = entityScope(principal);
        if (scope.kind === 'ENTITIES') {
          params.push(scope.legalEntityIds);
          where.push(`e.legal_entity_id = ANY($${params.length}::uuid[])`);
        }
      }
      if (query.periodFrom) {
        params.push(query.periodFrom);
        where.push(`p.end_date >= $${params.length}::date`);
      }
      if (query.periodTo) {
        params.push(query.periodTo);
        where.push(`p.start_date <= $${params.length}::date`);
      }
      if (query.cursor) {
        params.push(query.cursor);
        where.push(`e.id < $${params.length}::uuid`);
      }
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
      params.push(limit + 1);

      const { rows } = await client.query<
        EntryRow & {
          period_name: string;
          entry_number: string | null;
          recognized_total: string;
          recognized_count: number;
          reversal_status: string | null;
          reversal_date: string | null;
        }
      >(
        `SELECT ${ENTRY_COLUMNS}, p.name AS period_name, j.entry_number,
                coalesce(r.total, 0)::text AS recognized_total,
                coalesce(r.count, 0)::int AS recognized_count,
                s.status AS reversal_status, s.scheduled_date::text AS reversal_date
           FROM period_end_entries e
           JOIN accounting_periods p ON p.id = e.accounting_period_id
           JOIN journal_entries j ON j.id = e.journal_entry_id
           LEFT JOIN scheduled_reversals s ON s.id = e.scheduled_reversal_id
           LEFT JOIN LATERAL (
             SELECT sum(pr.amount) AS total, count(*) AS count
               FROM period_end_recognitions pr WHERE pr.period_end_entry_id = e.id
           ) r ON true
          WHERE ${where.join(' AND ')}
          ORDER BY e.id DESC
          LIMIT $${params.length}`,
        params,
      );

      const page = rows.slice(0, limit);
      const data = page.map((row) => ({
        ...row,
        remaining_balance: remainingBalance(row.total_amount, row.recognized_total),
      }));
      const hasMore = rows.length > limit;
      return {
        data,
        meta: {
          has_more: hasMore,
          next_cursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
        },
      };
    });
  }

  /** `getPeriodEndEntry` — GET /period-end-entries/{id}. The drill behind the checklist task. */
  async get(principal: TenantPrincipal, id: string) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const entry = await loadEntry(client, id);
      assertEntityPermission(principal, 'period_end_entry.view', entry.legal_entity_id);

      const { rows: recognitions } = await client.query(
        `SELECT r.id, r.accounting_period_id, p.name AS period_name,
                r.amount::text AS amount, r.journal_entry_id, j.entry_number,
                r.recognized_by, r.recognized_at
           FROM period_end_recognitions r
           JOIN accounting_periods p ON p.id = r.accounting_period_id
           JOIN journal_entries j ON j.id = r.journal_entry_id
          WHERE r.period_end_entry_id = $1
          ORDER BY p.start_date, r.id`,
        [id],
      );

      const { rows: journals } = await client.query<{
        entry_number: string | null;
        status: string;
      }>(`SELECT entry_number, status::text AS status FROM journal_entries WHERE id = $1`, [
        entry.journal_entry_id,
      ]);

      let scheduledReversal: Record<string, unknown> | null = null;
      if (entry.scheduled_reversal_id) {
        const { rows } = await client.query(
          `SELECT id, scheduled_date::text AS scheduled_date, status, reason, attempts,
                  last_error, executed_at, reversal_entry_id, cancelled_at, cancel_reason
             FROM scheduled_reversals WHERE id = $1`,
          [entry.scheduled_reversal_id],
        );
        scheduledReversal = (rows[0] as Record<string, unknown>) ?? null;
      }

      const recognized = await recognizedTotal(client, id);
      return {
        ...entry,
        entry_number: journals[0]?.entry_number ?? null,
        journal_status: journals[0]?.status ?? null,
        recognized_total: recognized.total,
        recognized_count: recognized.count,
        remaining_balance: remainingBalance(entry.total_amount, recognized.total),
        recognitions,
        scheduled_reversal: scheduledReversal,
      };
    });
  }

  private initialLines(input: CreatePeriodEndEntryInput, book: BookContext): DraftLineInput[] {
    const amount = D(input.totalAmount).toString();
    const currency = book.baseCurrency;
    switch (input.entryType) {
      case 'ACCRUAL':
        // EXPENSE_ACCRUAL: Dr Expense / Cr Accrued Liability.
        return [
          {
            accountId: input.plAccountId,
            description: input.description,
            transactionCurrency: currency,
            debit: amount,
          },
          {
            accountId: input.balanceAccountId,
            description: `Accrued liability: ${input.description}`,
            transactionCurrency: currency,
            credit: amount,
          },
        ];
      case 'PREPAID':
        // PREPAID_PURCHASE: Dr Prepaid Asset / Cr AP/Bank.
        return [
          {
            accountId: input.balanceAccountId,
            description: `Prepaid asset: ${input.description}`,
            transactionCurrency: currency,
            debit: amount,
          },
          {
            accountId: input.settlementAccountId!,
            description: input.description,
            transactionCurrency: currency,
            credit: amount,
          },
        ];
      case 'DEFERRAL':
        // DEFERRED_REVENUE_BILLING: Dr AR/Bank / Cr Deferred Revenue.
        return [
          {
            accountId: input.settlementAccountId!,
            description: input.description,
            transactionCurrency: currency,
            debit: amount,
          },
          {
            accountId: input.balanceAccountId,
            description: `Deferred revenue: ${input.description}`,
            transactionCurrency: currency,
            credit: amount,
          },
        ];
    }
  }
}

async function loadEntry(
  client: PoolClient,
  id: string,
  lock: 'FOR UPDATE' | '' = '',
): Promise<EntryRow> {
  const { rows } = await client.query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM period_end_entries e WHERE e.id = $1 ${lock}`,
    [id],
  );
  const entry = rows[0];
  if (!entry) throw notFound('Period-end entry', id);
  return entry;
}

async function recognizedTotal(
  client: PoolClient,
  entryId: string,
): Promise<{ total: string; count: number }> {
  const { rows } = await client.query<{ total: string; count: string }>(
    `SELECT coalesce(sum(amount), 0)::text AS total, count(*)::text AS count
       FROM period_end_recognitions WHERE period_end_entry_id = $1`,
    [entryId],
  );
  return { total: rows[0]?.total ?? '0', count: Number(rows[0]?.count ?? '0') };
}
