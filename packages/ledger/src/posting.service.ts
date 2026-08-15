/**
 * The posting service. doc 03's algorithm, steps 1-5 and 12-17.
 *
 * Steps 6 and 8-12 are `preparePosting` in @acct/domain, which has no database and
 * is property-tested to twenty thousand cases. What is left here is everything that
 * needs a transaction:
 *
 *    1. Receive command with a unique source event ID.
 *    2. Verify the event is not already posted.      <- journal_entries_source_event_uq
 *    3. Resolve tenant, entity, book and period.     <- resolve_accounting_period (F-403)
 *    4. Reject closed period unless permitted.       <- FOR SHARE, ADR-0004 §4
 *    5. Resolve posting rule version and accounts.
 *   13. Allocate journal number.                     <- FOR UPDATE, ADR-0004 §1
 *   14. Insert header and lines atomically.
 *   16. Create audit and outbox events.
 *   17. Commit.                                      <- deferred balance trigger fires here
 *
 * Nothing else in the platform writes journal_entries or journal_lines. doc 21's
 * opening line — "later modules must call the accounting kernel through
 * commands/services; they must not create ledger rows directly" — is a property of
 * this file being the only writer.
 */
import { PoolClient } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  preparePosting,
  type PostingAccount,
  type AccountDimensionRule,
  type DraftLineInput,
  type PreparedJournal,
  type PreparedLine,
  type CurrencyPrecision,
  type RoundingMode,
  D,
} from '@acct/domain';
import { lockPeriodForPosting, publish, recordAudit } from '@acct/database';
import type { RequestContext } from '@acct/domain';
import { can, type TenantPrincipal } from '@acct/domain';
import { allocateNumber } from './numbering';
import { assertJournalApproval } from './approval';
import { LedgerProjectionService } from './projection.service';

export interface JournalEntryRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  legal_entity_id: string;
  accounting_book_id: string;
  journal_id: string;
  accounting_period_id: string;
  branch_id: string | null;
  entry_number: string | null;
  posting_date: string;
  document_date: string | null;
  description: string | null;
  source_type: string;
  source_id: string | null;
  source_event_id: string | null;
  reversal_of_id: string | null;
  base_currency: string;
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'POSTED' | 'REVERSED';
  approval_state: string;
  version: string;
  /**
   * The preparer and the checker. Declared because migration 0049 made them a
   * precondition of POSTED rather than decoration: `created_by` is the maker,
   * `approved_by` the checker, and `je_maker_checker` refuses an approval whose
   * preparer is unknown. Optional because most SELECTs in this file do not need
   * them — `commitPosting` reads them itself rather than trusting a row that may
   * have been loaded before the approval was recorded.
   */
  created_by?: string | null;
  approved_by?: string | null;
}

export interface BookContext {
  readonly bookId: string;
  readonly legalEntityId: string;
  readonly organizationId: string;
  readonly baseCurrency: string;
  readonly roundingMode: RoundingMode;
  readonly roundingAccountId: string | null;
  readonly roundingTolerance: string;
  readonly closedPeriodBehaviour: string;
  readonly journalApprovalThreshold: string | null;
}

export class PostingService {
  constructor(private readonly projections: LedgerProjectionService) {}

  // -------------------------------------------------------------------------
  // Step 3-5: resolving the world the posting happens in
  // -------------------------------------------------------------------------

  /**
   * The book, its base currency and the effective accounting policy.
   *
   * ADR-0003 §6: the book's base currency is authoritative for posting, not the
   * entity's functional currency. F-203: every posting rule resolves its accounts
   * through the policy, so the policy is loaded on the same trip.
   */
  async loadBookContext(
    client: PoolClient,
    principal: TenantPrincipal,
    bookId: string,
    on: string,
  ): Promise<BookContext> {
    const { rows } = await client.query<{
      id: string;
      legal_entity_id: string;
      organization_id: string;
      base_currency: string;
      status: string;
      posting_enabled: boolean;
      rounding_mode: string | null;
      rounding_account_id: string | null;
      rounding_tolerance: string | null;
      closed_period_behaviour: string | null;
      journal_approval_threshold: string | null;
    }>(
      `SELECT b.id, b.legal_entity_id, le.organization_id, b.base_currency, b.status,
              le.posting_enabled,
              p.rounding_mode::text AS rounding_mode,
              p.rounding_account_id,
              p.rounding_tolerance::text AS rounding_tolerance,
              p.closed_period_behaviour,
              p.journal_approval_threshold::text AS journal_approval_threshold
         FROM accounting_books b
         JOIN legal_entities le ON le.id = b.legal_entity_id
         LEFT JOIN LATERAL (
           SELECT * FROM accounting_policies ap
            WHERE ap.legal_entity_id = b.legal_entity_id
              AND (ap.accounting_book_id = b.id OR ap.accounting_book_id IS NULL)
              AND ap.valid_from <= $3::date
              AND (ap.valid_to IS NULL OR ap.valid_to > $3::date)
            -- A book-specific policy beats the entity default; that is what the
            -- nullable accounting_book_id means.
            ORDER BY ap.accounting_book_id NULLS LAST, ap.version DESC
            LIMIT 1
         ) p ON true
        WHERE b.id = $1 AND b.tenant_id = $2`,
      [bookId, principal.tenantId, on],
    );
    const book = rows[0];
    if (!book) throw notFound('Accounting book', bookId);
    if (book.status !== 'ACTIVE') {
      throw new AppError('VALIDATION_FAILED', `Accounting book ${bookId} is ${book.status}.`);
    }
    if (!book.posting_enabled) {
      // doc 02: posting stays disabled until the entity is activated. Saying so is
      // more useful than a foreign key error three statements later.
      throw new AppError(
        'VALIDATION_FAILED',
        'Posting is disabled for this legal entity. Activate it first ' +
          '(POST /legal-entities/{id}/activate).',
        { details: { legal_entity_id: book.legal_entity_id } },
      );
    }

    return {
      bookId: book.id,
      legalEntityId: book.legal_entity_id,
      organizationId: book.organization_id,
      baseCurrency: book.base_currency,
      roundingMode: (book.rounding_mode as RoundingMode | null) ?? 'HALF_UP',
      roundingAccountId: book.rounding_account_id,
      roundingTolerance: book.rounding_tolerance ?? '0',
      closedPeriodBehaviour: book.closed_period_behaviour ?? 'REJECT',
      journalApprovalThreshold: book.journal_approval_threshold,
    };
  }

  /**
   * F-403 / ADR-0003 §7 — period resolution, normative and single.
   *
   * The regular period containing `postingDate`, unless the caller names an
   * adjustment period explicitly AND holds `journal.post_to_adjustment_period`.
   * Adjustment periods overlap period 12 by design, so "the period containing this
   * date" is genuinely ambiguous and the ambiguity is resolved by permission rather
   * than by ordering.
   */
  async resolvePeriod(
    client: PoolClient,
    principal: TenantPrincipal,
    input: { legalEntityId: string; postingDate: string; periodId?: string | null | undefined },
  ): Promise<{ id: string; name: string; is_adjustment: boolean; status: string }> {
    if (input.periodId) {
      const { rows } = await client.query<{
        id: string;
        name: string;
        is_adjustment: boolean;
        status: string;
        legal_entity_id: string;
        start_date: string;
        end_date: string;
      }>(
        `SELECT id, name, is_adjustment, status::text AS status, legal_entity_id,
                start_date::text AS start_date, end_date::text AS end_date
           FROM accounting_periods WHERE id = $1 AND tenant_id = $2`,
        [input.periodId, principal.tenantId],
      );
      const period = rows[0];
      if (!period || period.legal_entity_id !== input.legalEntityId) {
        throw notFound('Accounting period', input.periodId);
      }
      if (period.is_adjustment && !can(principal, 'journal.post_to_adjustment_period')) {
        throw new AppError(
          'FORBIDDEN',
          `${period.name} is an adjustment period. Posting to one requires the ` +
            'journal.post_to_adjustment_period permission (F-403).',
          { details: { permission: 'journal.post_to_adjustment_period', period: period.name } },
        );
      }
      if (input.postingDate < period.start_date || input.postingDate > period.end_date) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Posting date ${input.postingDate} is outside ${period.name} ` +
            `(${period.start_date} to ${period.end_date}).`,
          {
            fieldErrors: [
              { field: 'posting_date', code: 'OUTSIDE_PERIOD', message: 'out of range' },
            ],
          },
        );
      }
      return period;
    }

    const { rows } = await client.query<{
      id: string;
      name: string;
      is_adjustment: boolean;
      status: string;
    }>(
      `SELECT p.id, p.name, p.is_adjustment, p.status::text AS status
         FROM accounting_periods p
        WHERE p.id = resolve_accounting_period($1::uuid, $2::date)`,
      [input.legalEntityId, input.postingDate],
    );
    const period = rows[0];
    if (!period) {
      throw new AppError(
        'NO_PERIOD_FOR_DATE',
        `No accounting period covers ${input.postingDate}. Create the fiscal year that contains ` +
          'it before posting into it.',
        { details: { posting_date: input.postingDate, legal_entity_id: input.legalEntityId } },
      );
    }
    return period;
  }

  /**
   * Step 4, and the race Gate C names: "Closing a period between request validation
   * and commit cannot allow a race-condition post."
   *
   * `FOR SHARE` on the period row (ADR-0004 §4). Two concurrent posts into the same
   * open period both hold the share lock and do not block each other. A close takes
   * `FOR UPDATE` on the same row, so it waits behind any post in flight, and any
   * post that arrives after it blocks and then reads the closed status. The window
   * the criterion describes does not exist, because the lock closes it rather than
   * a re-check that could itself be raced.
   */
  async lockPeriod(
    client: PoolClient,
    principal: TenantPrincipal,
    periodId: string,
    behaviour: string,
  ): Promise<void> {
    const period = await lockPeriodForPosting<{
      id: string;
      name: string;
      status: string;
      tenant_id: string;
    }>(client, periodId);
    if (!period || period.tenant_id !== principal.tenantId) {
      throw notFound('Accounting period', periodId);
    }
    if (period.status === 'OPEN') return;

    if (period.status === 'HARD_CLOSED') {
      throw new AppError(
        'PERIOD_CLOSED',
        `${period.name} is hard-closed. Post to an open period, or reopen it — which requires ` +
          'accounting_period.reopen, a reason and an audit entry (doc 02).',
        { details: { period: period.name, status: period.status } },
      );
    }

    // SOFT_CLOSED. doc 01 defines it as "only privileged/approved posting", and
    // `accounting_policies.closed_period_behaviour` decides whether this tenant
    // wants that door at all. REJECT is the shipped default, so a tenant that has
    // never thought about it gets the safe answer.
    if (behaviour !== 'ALLOW_PRIVILEGED') {
      throw new AppError(
        'PERIOD_CLOSED',
        `${period.name} is soft-closed and this entity's accounting policy rejects postings to ` +
          'closed periods. Set closed_period_behaviour to ALLOW_PRIVILEGED to permit them.',
        { details: { period: period.name, status: period.status, behaviour } },
      );
    }
    if (!can(principal, 'accounting_period.soft_close')) {
      throw new AppError(
        'PERIOD_CLOSED',
        `${period.name} is soft-closed. Only a user who could close it may post into it ` +
          '(accounting_period.soft_close).',
        { details: { period: period.name, permission: 'accounting_period.soft_close' } },
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 5 and 8-9: the facts preparePosting needs
  // -------------------------------------------------------------------------

  async loadAccounts(
    client: PoolClient,
    legalEntityId: string,
    accountIds: readonly string[],
  ): Promise<Map<string, PostingAccount>> {
    const ids = [...new Set(accountIds)];
    if (ids.length === 0) return new Map();

    const { rows } = await client.query<{
      id: string;
      code: string;
      name: string;
      account_type: PostingAccount['accountType'];
      normal_balance: PostingAccount['normalBalance'];
      is_posting: boolean;
      is_control: boolean;
      status: PostingAccount['status'];
    }>(
      // legal_entity_id in the WHERE, not merely in the join: this is the read that
      // makes F-003 impossible to reach. An account belonging to another entity is
      // simply not returned, and preparePosting then reports it as unknown.
      `SELECT id, code, name, account_type, normal_balance, is_posting, is_control, status
         FROM accounts WHERE id = ANY($1::uuid[]) AND legal_entity_id = $2`,
      [ids, legalEntityId],
    );

    const { rows: ruleRows } = await client.query<{
      account_id: string;
      dimension_id: string;
      dimension_code: string;
      rule: AccountDimensionRule['rule'];
      default_value_id: string | null;
    }>(
      `SELECT r.account_id, r.dimension_id, d.code AS dimension_code, r.rule::text AS rule,
              r.default_value_id
         FROM account_dimension_rules r
         JOIN dimensions d ON d.id = r.dimension_id
        WHERE r.account_id = ANY($1::uuid[])`,
      [ids],
    );

    const rulesByAccount = new Map<string, AccountDimensionRule[]>();
    for (const r of ruleRows) {
      const list = rulesByAccount.get(r.account_id) ?? [];
      list.push({
        dimensionId: r.dimension_id,
        dimensionCode: r.dimension_code,
        rule: r.rule,
        defaultValueId: r.default_value_id,
      });
      rulesByAccount.set(r.account_id, list);
    }

    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          code: row.code,
          name: row.name,
          accountType: row.account_type,
          normalBalance: row.normal_balance,
          isPosting: row.is_posting,
          isControl: row.is_control,
          status: row.status,
          dimensionRules: rulesByAccount.get(row.id) ?? [],
        } satisfies PostingAccount,
      ]),
    );
  }

  async loadCurrencies(client: PoolClient): Promise<Map<string, CurrencyPrecision>> {
    const { rows } = await client.query<{
      code: string;
      minor_unit: number;
      cash_rounding_increment: string | null;
    }>(
      `SELECT code, minor_unit, cash_rounding_increment::text AS cash_rounding_increment
         FROM currencies WHERE is_active`,
    );
    return new Map(
      rows.map((r) => [
        r.code,
        {
          code: r.code,
          minorUnit: r.minor_unit,
          ...(r.cash_rounding_increment && Number(r.cash_rounding_increment) > 0
            ? { cashRoundingIncrement: D(r.cash_rounding_increment) }
            : {}),
        },
      ]),
    );
  }

  /** Everything preparePosting needs, in two queries plus the currency table. */
  async prepare(
    client: PoolClient,
    book: BookContext,
    lines: readonly DraftLineInput[],
  ): Promise<PreparedJournal> {
    const accountIds = lines.map((l) => l.accountId);
    if (book.roundingAccountId) accountIds.push(book.roundingAccountId);
    const [accounts, currencies] = await Promise.all([
      this.loadAccounts(client, book.legalEntityId, accountIds),
      this.loadCurrencies(client),
    ]);

    return preparePosting(lines, {
      baseCurrency: book.baseCurrency,
      accounts,
      currencies,
      roundingMode: book.roundingMode,
      roundingAccountId: book.roundingAccountId,
      roundingTolerance: book.roundingTolerance,
    });
  }

  // -------------------------------------------------------------------------
  // Step 14: writing the lines
  // -------------------------------------------------------------------------

  /**
   * Replaces an entry's lines with the prepared set.
   *
   * Delete-then-insert rather than a diff. The entry is DRAFT here — 0006's trigger
   * would refuse anything else — and a diff would have to reason about which stored
   * line corresponds to which prepared one, including the rounding line that appears
   * and disappears as amounts change. Line identifiers are not referenced by
   * anything outside the entry, so replacing them costs nothing and removes a whole
   * class of partial-update bug.
   */
  async writeLines(
    client: PoolClient,
    entry: { id: string; legal_entity_id: string; tenant_id: string },
    scope: { bookId: string; periodId: string; postingDate: string; branchId: string | null },
    prepared: PreparedJournal,
  ): Promise<void> {
    // F-619 / migration 0032. The application role has no DELETE on journal_lines —
    // 0006 revoked it so posted history cannot be removed — so the clearing runs
    // through the SECURITY DEFINER function, which reaches unposted entries only and
    // re-checks the tenant that RLS would have checked.
    await client.query(`SELECT ledger_clear_draft_lines($1)`, [entry.id]);

    for (const [index, line] of prepared.lines.entries()) {
      const lineId = uuidv7();
      await client.query(
        `INSERT INTO journal_lines (
           id, tenant_id, journal_entry_id, legal_entity_id, accounting_book_id,
           accounting_period_id, posting_date, branch_id, line_no, account_id, description,
           transaction_currency, transaction_debit, transaction_credit,
           base_currency, base_debit, base_credit,
           exchange_rate, exchange_rate_date, exchange_rate_source, contact_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8,$9,$10,$11,$12,$13::numeric,$14::numeric,
                 $15,$16::numeric,$17::numeric,$18::numeric,$19::date,$20,$21,$22::jsonb)`,
        [
          lineId,
          entry.tenant_id,
          entry.id,
          entry.legal_entity_id,
          scope.bookId,
          scope.periodId,
          scope.postingDate,
          line.branchId ?? scope.branchId,
          index + 1,
          line.accountId,
          line.description,
          line.transactionCurrency,
          line.transactionDebit,
          line.transactionCredit,
          line.baseCurrency,
          line.baseDebit,
          line.baseCredit,
          line.exchangeRate,
          line.exchangeRateDate,
          line.exchangeRateSource,
          line.contactId,
          JSON.stringify(line.isRoundingAdjustment ? { rounding_adjustment: true } : {}),
        ],
      );

      for (const dimension of line.dimensions) {
        await client.query(
          `INSERT INTO journal_line_dimensions (tenant_id, journal_line_id, legal_entity_id,
                                                dimension_id, dimension_value_id)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            entry.tenant_id,
            lineId,
            entry.legal_entity_id,
            dimension.dimensionId,
            dimension.dimensionValueId,
          ],
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Step 13: the number
  // -------------------------------------------------------------------------

  /**
   * doc 01: document numbers are gapless and allocated under `FOR UPDATE`
   * (ADR-0004 §1). `je_posted_has_number` makes a numberless POSTED entry
   * impossible, so this runs on every post.
   *
   * If the entity has no JOURNAL sequence, one is created here rather than the post
   * failing. The alternative is a first post that fails on setup the user was never
   * told to do, and doc 02's acceptance criterion is that an organization reaches
   * posting-ready "without direct database work". The creation is audited, so it is
   * visible rather than magic.
   */
  async allocateEntryNumber(
    client: PoolClient,
    principal: TenantPrincipal,
    context: { legalEntityId: string; branchId: string | null; entryId: string; on: Date },
    audit: (action: string, resourceId: string, after: unknown) => Promise<void>,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM number_sequences
        WHERE legal_entity_id = $1 AND document_type = 'JOURNAL' AND status = 'ACTIVE'
          AND (branch_id = $2 OR branch_id IS NULL)
        ORDER BY branch_id NULLS LAST
        LIMIT 1`,
      [context.legalEntityId, context.branchId],
    );

    let sequenceId = rows[0]?.id;
    if (!sequenceId) {
      sequenceId = uuidv7();
      await client.query(
        `INSERT INTO number_sequences (id, tenant_id, legal_entity_id, document_type,
                                       prefix, padding, next_number, reset_rule)
         VALUES ($1,$2,$3,'JOURNAL','JE-{YYYY}-',5,1,'ANNUAL')`,
        [sequenceId, principal.tenantId, context.legalEntityId],
      );
      await audit('number_sequence.auto_created', sequenceId, {
        document_type: 'JOURNAL',
        reason: 'the first journal posting for this entity found no JOURNAL sequence',
      });
    }

    const allocated = await allocateNumber(client, {
      sequenceId,
      resourceType: 'journal_entry',
      resourceId: context.entryId,
      on: context.on,
    });
    return allocated.formatted;
  }

  // -------------------------------------------------------------------------
  // The post itself
  // -------------------------------------------------------------------------

  /**
   * Marks a prepared entry POSTED and refreshes the projection.
   *
   * Called by the manual journal path, the opening-balance path, the reversal path
   * and the recurring-journal worker. Every one of them goes through here, so
   * "every posted journal balances" is a property of one function rather than of
   * four that resemble each other.
   */
  async commitPosting(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    entry: JournalEntryRow,
    book: BookContext,
    prepared: PreparedJournal,
    options: { periodId: string; entryNumber: string; postingRuleVersionId?: string | null },
  ): Promise<JournalEntryRow> {
    // The approval threshold, inside the transaction that writes the journal.
    //
    // Here rather than in the four callers because this method is the only place
    // a journal becomes POSTED — the manual path, the subledger document path,
    // the reversal path and the recurring-journal worker all arrive here — and a
    // rule stated in four places is a rule three of them will eventually differ
    // about. The database repeats it at COMMIT (0049); this half exists so the
    // refusal reaches the caller as an actionable message naming both numbers
    // rather than as a mapped constraint violation.
    await this.assertApproved(client, principal, entry, book, prepared);

    // doc 02's high-risk category, checked here rather than at the guard because the
    // guard cannot know which accounts a body names until the body is resolved.
    if (prepared.controlAccounts.length > 0 && !can(principal, 'journal.post_control')) {
      const names = prepared.lines
        .filter((l) => l.isControl)
        .map((l) => `${l.accountCode} ${l.accountName}`);
      throw new AppError(
        'FORBIDDEN',
        `This journal posts to control account(s) ${[...new Set(names)].join(', ')}. A manual ` +
          'posting to a control account breaks the subledger reconciliation Gate D tests, so it ' +
          'requires journal.post_control (doc 02 high-risk).',
        { details: { permission: 'journal.post_control', accounts: [...new Set(names)] } },
      );
    }

    const { rows } = await client.query<JournalEntryRow>(
      `UPDATE journal_entries
          SET status = 'POSTED',
              accounting_period_id = $3,
              entry_number = $4,
              posting_rule_version_id = coalesce($5, posting_rule_version_id),
              posted_at = now(),
              posted_by = $6,
              version = version + 1
        WHERE id = $1 AND tenant_id = $2
        RETURNING id, tenant_id, legal_entity_id, accounting_book_id, journal_id,
                  accounting_period_id, branch_id, entry_number, posting_date::text AS posting_date,
                  document_date::text AS document_date, description, source_type, source_id,
                  source_event_id, reversal_of_id, base_currency, status::text AS status,
                  approval_state::text AS approval_state, version::text AS version`,
      [
        entry.id,
        principal.tenantId,
        options.periodId,
        options.entryNumber,
        options.postingRuleVersionId ?? null,
        principal.userId,
      ],
    );
    const posted = rows[0]!;

    await this.projections.refresh(client, {
      tenantId: principal.tenantId,
      legalEntityId: entry.legal_entity_id,
      bookId: book.bookId,
      accountIds: [...new Set(prepared.lines.map((l) => l.accountId))],
    });

    await publish(client, context, {
      eventType: 'journal.posted',
      aggregateType: 'journal_entry',
      aggregateId: entry.id,
      tenantId: principal.tenantId,
      organizationId: book.organizationId,
      legalEntityId: entry.legal_entity_id,
      accountingBookId: book.bookId,
      payload: {
        entry_number: options.entryNumber,
        posting_date: entry.posting_date,
        accounting_period_id: options.periodId,
        base_currency: book.baseCurrency,
        total_debit: prepared.totalBaseDebit,
        total_credit: prepared.totalBaseCredit,
        line_count: prepared.lines.length,
        source_type: entry.source_type,
        source_id: entry.source_id,
        rounding_adjustment: prepared.roundingAdjustment,
      },
    });
    await recordAudit(client, context, {
      action: 'journal.posted',
      resourceType: 'journal_entry',
      resourceId: entry.id,
      tenantId: principal.tenantId,
      legalEntityId: entry.legal_entity_id,
      after: {
        entry_number: options.entryNumber,
        total_debit: prepared.totalBaseDebit,
        lines: prepared.lines.length,
        control_accounts: prepared.controlAccounts.length,
      },
    });

    return posted;
  }

  /**
   * Refuses a journal that needs an approval and has not got one.
   *
   * Reads the approval columns from the database rather than from the `entry`
   * the caller is holding. The manual path loads its row before locking the
   * period and preparing the lines, so by the time we reach here that row is
   * several statements old; the subledger path inserts its header itself. In
   * both cases the authoritative answer to "who approved this" is the row as it
   * stands in this transaction, and re-reading it costs one indexed lookup
   * against a row this transaction already holds a lock on.
   *
   * The amount is the journal's absolute value: debits and credits are equal on
   * anything that will survive `journal_entries_balanced`, and `greatest` of the
   * two is the honest figure to judge while they might not be. Compared with
   * exact decimals — a threshold is a boundary, and a boundary compared in
   * binary floating point is a boundary that moves (ADR-0006 §1).
   */
  private async assertApproved(
    client: PoolClient,
    principal: TenantPrincipal,
    entry: JournalEntryRow,
    book: BookContext,
    prepared: PreparedJournal,
  ): Promise<void> {
    const { rows } = await client.query<{
      created_by: string | null;
      approved_by: string | null;
      reversal_of_id: string | null;
      entry_number: string | null;
      reverses_approved: boolean;
    }>(
      `SELECT e.created_by, e.approved_by, e.reversal_of_id, e.entry_number,
              (o.id IS NOT NULL AND o.approved_by IS NOT NULL) AS reverses_approved
         FROM journal_entries e
         LEFT JOIN journal_entries o ON o.id = e.reversal_of_id
        WHERE e.id = $1 AND e.tenant_id = $2`,
      [entry.id, principal.tenantId],
    );
    const row = rows[0];
    if (!row) throw notFound('Journal entry', entry.id);

    const debit = D(prepared.totalBaseDebit).abs();
    const credit = D(prepared.totalBaseCredit).abs();

    assertJournalApproval({
      threshold: book.journalApprovalThreshold,
      amount: (debit.gte(credit) ? debit : credit).toString(),
      currency: book.baseCurrency,
      preparedBy: row.created_by,
      approvedBy: row.approved_by,
      reference: row.entry_number ?? entry.id,
      reversesApprovedEntry: row.reverses_approved,
    });
  }

  /**
   * doc 03: "Verify event is not already posted."
   *
   * The unique index does the enforcing; this turns the 23505 into the answer the
   * caller wants, which is the existing entry rather than an error. Gate C's
   * "duplicate source events are idempotent" is about the second call returning the
   * first call's result, not about it failing politely.
   */
  async findBySourceEvent(
    client: PoolClient,
    principal: TenantPrincipal,
    scope: { legalEntityId: string; bookId: string; sourceEventId: string },
  ): Promise<JournalEntryRow | null> {
    const { rows } = await client.query<JournalEntryRow>(
      `SELECT id, tenant_id, legal_entity_id, accounting_book_id, journal_id,
              accounting_period_id, branch_id, entry_number, posting_date::text AS posting_date,
              document_date::text AS document_date, description, source_type, source_id,
              source_event_id, reversal_of_id, base_currency, status::text AS status,
              approval_state::text AS approval_state, version::text AS version
         FROM journal_entries
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND accounting_book_id = $3
          AND source_event_id = $4`,
      [principal.tenantId, scope.legalEntityId, scope.bookId, scope.sourceEventId],
    );
    return rows[0] ?? null;
  }

  /** Reads stored lines back into the shape `preparePosting` takes. */
  async readLines(client: PoolClient, entryId: string): Promise<DraftLineInput[]> {
    const { rows } = await client.query<{
      line_no: number;
      account_id: string;
      description: string | null;
      transaction_currency: string;
      transaction_debit: string;
      transaction_credit: string;
      exchange_rate: string | null;
      exchange_rate_date: string | null;
      exchange_rate_source: string | null;
      branch_id: string | null;
      contact_id: string | null;
      dimensions: Record<string, string> | null;
    }>(
      // A rounding line written by a previous prepare is excluded: it is an OUTPUT
      // of the calculation. Feeding it back in would let the adjustment compound
      // every time a draft is re-saved, and the second prepare would see a journal
      // that already balances and produce a different one from the first.
      `SELECT l.line_no, l.account_id, l.description, l.transaction_currency,
              l.transaction_debit::text AS transaction_debit,
              l.transaction_credit::text AS transaction_credit,
              l.exchange_rate::text AS exchange_rate,
              l.exchange_rate_date::text AS exchange_rate_date,
              l.exchange_rate_source, l.branch_id, l.contact_id,
              (SELECT jsonb_object_agg(d.dimension_id::text, d.dimension_value_id::text)
                 FROM journal_line_dimensions d WHERE d.journal_line_id = l.id) AS dimensions
         FROM journal_lines l
        WHERE l.journal_entry_id = $1
          AND coalesce(l.metadata ->> 'rounding_adjustment', 'false') <> 'true'
        ORDER BY l.line_no`,
      [entryId],
    );

    return rows.map((r) => ({
      lineNo: r.line_no,
      accountId: r.account_id,
      description: r.description,
      transactionCurrency: r.transaction_currency,
      debit: r.transaction_debit,
      credit: r.transaction_credit,
      exchangeRate: r.exchange_rate,
      exchangeRateDate: r.exchange_rate_date,
      exchangeRateSource: r.exchange_rate_source,
      branchId: r.branch_id,
      contactId: r.contact_id,
      ...(r.dimensions ? { dimensions: r.dimensions } : {}),
    }));
  }
}

/** The stored line rows a report or a reversal reads. */
export function toDraftLines(lines: readonly PreparedLine[]): DraftLineInput[] {
  return lines.map((l) => ({
    lineNo: l.lineNo,
    accountId: l.accountId,
    description: l.description,
    transactionCurrency: l.transactionCurrency,
    debit: l.transactionDebit,
    credit: l.transactionCredit,
    exchangeRate: l.exchangeRate,
    exchangeRateDate: l.exchangeRateDate,
    exchangeRateSource: l.exchangeRateSource,
    branchId: l.branchId,
    contactId: l.contactId,
    dimensions: Object.fromEntries(l.dimensions.map((d) => [d.dimensionId, d.dimensionValueId])),
  }));
}
