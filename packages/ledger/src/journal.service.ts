/**
 * Journal definitions, manual journals and their lifecycle.
 *
 * DRAFT -> SUBMITTED -> APPROVED -> POSTED -> REVERSED, with the last transition
 * available only through a new reversing entry. The interesting property is what is
 * NOT here: nothing mutates a posted entry, because 0006's trigger would refuse it
 * and migration 0025 revoked the privilege that would be needed anyway. This file
 * therefore reads as if the ledger were append-only, which it is.
 */
import { Pool, PoolClient } from 'pg';
import {
  AppError,
  assertVersion,
  notFound,
  uuidv7,
  prepareDraft,
  reverseLines,
  type DraftLineInput,
} from '@acct/domain';
import { publish, recordAudit } from '@acct/database';
import { readInTenant, writeInTenant } from '@acct/database';
import { assertEntityPermission, entityScope, type TenantPrincipal } from '@acct/domain';
import { PostingService, type JournalEntryRow } from './posting.service';

const EDITABLE = new Set(['DRAFT', 'SUBMITTED', 'APPROVED']);

export interface JournalLineInput {
  accountId: string;
  description?: string | undefined;
  debit?: string | undefined;
  credit?: string | undefined;
  transactionCurrency?: string | undefined;
  exchangeRate?: string | undefined;
  exchangeRateDate?: string | undefined;
  exchangeRateSource?: string | undefined;
  branchId?: string | undefined;
  contactId?: string | undefined;
  dimensions?: Record<string, string> | undefined;
}

export class JournalService {
  constructor(
    private readonly pool: Pool,
    private readonly posting: PostingService,
  ) {}

  // -------------------------------------------------------------------------
  // Journal definitions (F-608)
  // -------------------------------------------------------------------------

  async listJournalDefinitions(
    principal: TenantPrincipal,
    filters: { legalEntityId?: string | undefined; accountingBookId?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const where = ['j.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];
      if (filters.legalEntityId) {
        assertEntityPermission(principal, 'journal_definition.view', filters.legalEntityId);
        params.push(filters.legalEntityId);
        where.push(`j.legal_entity_id = $${params.length}`);
      } else {
        const scope = entityScope(principal);
        if (scope.kind === 'ENTITIES') {
          params.push(scope.legalEntityIds);
          where.push(`j.legal_entity_id = ANY($${params.length}::uuid[])`);
        }
      }
      if (filters.accountingBookId) {
        params.push(filters.accountingBookId);
        where.push(`j.accounting_book_id = $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT j.id, j.legal_entity_id, j.accounting_book_id, j.code, j.name, j.journal_type,
                j.status,
                (SELECT count(*) FROM journal_entries e WHERE e.journal_id = j.id)::int AS entry_count
           FROM journals j
          WHERE ${where.join(' AND ')}
          ORDER BY j.code
          LIMIT 500`,
        params,
      );
      return { data: rows };
    });
  }

  async createJournalDefinition(
    principal: TenantPrincipal,
    input: { accountingBookId: string; code: string; name: string; journalType: string },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: books } = await client.query<{ legal_entity_id: string }>(
        `SELECT legal_entity_id FROM accounting_books WHERE id = $1 AND tenant_id = $2`,
        [input.accountingBookId, principal.tenantId],
      );
      const book = books[0];
      if (!book) throw notFound('Accounting book', input.accountingBookId);
      assertEntityPermission(principal, 'journal_definition.manage', book.legal_entity_id);

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO journals (id, tenant_id, legal_entity_id, accounting_book_id, code, name,
                               journal_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id, legal_entity_id, accounting_book_id, code, name, journal_type, status`,
        [
          id,
          principal.tenantId,
          book.legal_entity_id,
          input.accountingBookId,
          input.code,
          input.name,
          input.journalType,
        ],
      );
      await recordAudit(client, context, {
        action: 'journal_definition.created',
        resourceType: 'journal',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: book.legal_entity_id,
        after: rows[0]!,
      });
      return rows[0]!;
    });
  }

  // -------------------------------------------------------------------------
  // Journal entries
  // -------------------------------------------------------------------------

  async listJournalEntries(
    principal: TenantPrincipal,
    filters: {
      legalEntityId?: string | undefined;
      accountingBookId?: string | undefined;
      accountingPeriodId?: string | undefined;
      status?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      limit?: number | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const where = ['e.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];
      if (filters.legalEntityId) {
        assertEntityPermission(principal, 'journal.view', filters.legalEntityId);
        params.push(filters.legalEntityId);
        where.push(`e.legal_entity_id = $${params.length}`);
      } else {
        const scope = entityScope(principal);
        if (scope.kind === 'ENTITIES') {
          params.push(scope.legalEntityIds);
          where.push(`e.legal_entity_id = ANY($${params.length}::uuid[])`);
        }
      }
      for (const [value, clause] of [
        [filters.accountingBookId, 'e.accounting_book_id'],
        [filters.accountingPeriodId, 'e.accounting_period_id'],
      ] as const) {
        if (value) {
          params.push(value);
          where.push(`${clause} = $${params.length}`);
        }
      }
      if (filters.status) {
        params.push(filters.status);
        where.push(`e.status = $${params.length}::journal_status`);
      }
      if (filters.from) {
        params.push(filters.from);
        where.push(`e.posting_date >= $${params.length}::date`);
      }
      if (filters.to) {
        params.push(filters.to);
        where.push(`e.posting_date <= $${params.length}::date`);
      }
      params.push(Math.min(filters.limit ?? 100, 500));

      const { rows } = await client.query(
        `SELECT e.id, e.legal_entity_id, e.accounting_book_id, e.journal_id, e.accounting_period_id,
                e.entry_number, e.posting_date::text AS posting_date,
                e.document_date::text AS document_date, e.description, e.source_type, e.source_id,
                e.reversal_of_id, e.base_currency, e.status, e.approval_state,
                e.version::text AS version, e.posted_at, e.created_at,
                j.code AS journal_code, p.name AS period_name,
                (SELECT coalesce(sum(l.base_debit), 0)::text FROM journal_lines l
                  WHERE l.journal_entry_id = e.id) AS total_debit,
                (SELECT coalesce(sum(l.base_credit), 0)::text FROM journal_lines l
                  WHERE l.journal_entry_id = e.id) AS total_credit,
                (SELECT count(*) FROM journal_lines l WHERE l.journal_entry_id = e.id)::int
                  AS line_count
           FROM journal_entries e
           JOIN journals j ON j.id = e.journal_id
           JOIN accounting_periods p ON p.id = e.accounting_period_id
          WHERE ${where.join(' AND ')}
          ORDER BY e.posting_date DESC, e.created_at DESC
          LIMIT $${params.length}`,
        params,
      );
      return { data: rows };
    });
  }

  async getJournalEntry(principal: TenantPrincipal, id: string) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const entry = await this.load(client, principal, id);
      assertEntityPermission(principal, 'journal.view', entry.legal_entity_id);

      const { rows: lines } = await client.query(
        `SELECT l.id, l.line_no, l.account_id, a.code AS account_code, a.name AS account_name,
                a.account_type, a.is_control, l.description,
                l.transaction_currency, l.transaction_debit::text AS transaction_debit,
                l.transaction_credit::text AS transaction_credit,
                l.base_currency, l.base_debit::text AS base_debit,
                l.base_credit::text AS base_credit, l.exchange_rate::text AS exchange_rate,
                l.branch_id, l.contact_id, l.metadata,
                (SELECT coalesce(jsonb_agg(jsonb_build_object(
                          'dimension_id', d.dimension_id, 'dimension_code', dim.code,
                          'dimension_value_id', d.dimension_value_id, 'value_code', v.code)), '[]'::jsonb)
                   FROM journal_line_dimensions d
                   JOIN dimensions dim ON dim.id = d.dimension_id
                   JOIN dimension_values v ON v.id = d.dimension_value_id
                  WHERE d.journal_line_id = l.id) AS dimensions
           FROM journal_lines l
           JOIN accounts a ON a.id = l.account_id
          WHERE l.journal_entry_id = $1
          ORDER BY l.line_no`,
        [id],
      );

      const { rows: related } = await client.query(
        `SELECT id, entry_number, status::text AS status, posting_date::text AS posting_date,
                'REVERSAL' AS relation
           FROM journal_entries WHERE reversal_of_id = $1
          UNION ALL
         SELECT o.id, o.entry_number, o.status::text, o.posting_date::text, 'REVERSES'
           FROM journal_entries e JOIN journal_entries o ON o.id = e.reversal_of_id
          WHERE e.id = $1`,
        [id],
      );

      const { rows: schedules } = await client.query(
        `SELECT id, scheduled_date::text AS scheduled_date, status, reason, reversal_entry_id
           FROM scheduled_reversals WHERE journal_entry_id = $1 ORDER BY created_at DESC`,
        [id],
      );

      return { ...entry, lines, related, scheduled_reversals: schedules };
    });
  }

  /**
   * doc 03: "Draft can be edited … Draft may be temporarily unbalanced; POSTED may
   * never be unbalanced."
   *
   * The draft is stored as real `journal_lines` rows with a DRAFT parent, which is
   * what makes it editable at all: 0006's immutability trigger fires on POSTED and
   * REVERSED only, and the deferred balance assertion returns early for anything
   * that is not POSTED. Storing drafts in a jsonb blob instead would have meant two
   * representations of a journal line and two chances to convert between them wrong.
   */
  async createDraft(
    principal: TenantPrincipal,
    input: {
      accountingBookId: string;
      journalId: string;
      postingDate: string;
      documentDate?: string | undefined;
      accountingPeriodId?: string | undefined;
      description?: string | undefined;
      branchId?: string | undefined;
      sourceType?: string | undefined;
      sourceId?: string | undefined;
      sourceEventId?: string | undefined;
      lines: readonly JournalLineInput[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const book = await this.posting.loadBookContext(
        client,
        principal,
        input.accountingBookId,
        input.postingDate,
      );
      assertEntityPermission(principal, 'journal.create', book.legalEntityId);

      // doc 03 step 2, before any work: a duplicate source event returns the
      // existing entry rather than a second one. Gate C's "duplicate source events
      // are idempotent" is about the answer, not about the error.
      if (input.sourceEventId) {
        const existing = await this.posting.findBySourceEvent(client, principal, {
          legalEntityId: book.legalEntityId,
          bookId: book.bookId,
          sourceEventId: input.sourceEventId,
        });
        if (existing) return existing;
      }

      const journal = await this.loadJournalDefinition(client, input.journalId, book.bookId);
      const period = await this.posting.resolvePeriod(client, principal, {
        legalEntityId: book.legalEntityId,
        postingDate: input.postingDate,
        periodId: input.accountingPeriodId,
      });

      const entryId = uuidv7();
      const { rows } = await client.query<JournalEntryRow>(
        `INSERT INTO journal_entries (id, tenant_id, legal_entity_id, accounting_book_id,
                                      journal_id, accounting_period_id, branch_id, posting_date,
                                      document_date, description, source_type, source_id,
                                      source_event_id, base_currency, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11,$12,$13,$14,$15)
         RETURNING id, tenant_id, legal_entity_id, accounting_book_id, journal_id,
                   accounting_period_id, branch_id, entry_number,
                   posting_date::text AS posting_date, document_date::text AS document_date,
                   description, source_type, source_id, source_event_id, reversal_of_id,
                   base_currency, status::text AS status, approval_state::text AS approval_state,
                   version::text AS version`,
        [
          entryId,
          principal.tenantId,
          book.legalEntityId,
          book.bookId,
          journal.id,
          period.id,
          input.branchId ?? null,
          input.postingDate,
          input.documentDate ?? null,
          input.description ?? null,
          input.sourceType ?? 'MANUAL',
          input.sourceId ?? null,
          input.sourceEventId ?? null,
          book.baseCurrency,
          principal.userId,
        ],
      );
      const entry = rows[0]!;

      const prepared = await this.prepareDraftLines(client, book, input.lines);
      await this.posting.writeLines(
        client,
        entry,
        {
          bookId: book.bookId,
          periodId: period.id,
          postingDate: input.postingDate,
          branchId: input.branchId ?? null,
        },
        prepared,
      );

      await publish(client, context, {
        eventType: 'journal.draft_created',
        aggregateType: 'journal_entry',
        aggregateId: entryId,
        tenantId: principal.tenantId,
        organizationId: book.organizationId,
        legalEntityId: book.legalEntityId,
        accountingBookId: book.bookId,
        payload: {
          journal_code: journal.code,
          posting_date: input.postingDate,
          line_count: prepared.lines.length,
          balanced: prepared.isBalanced,
        },
      });
      await recordAudit(client, context, {
        action: 'journal.draft_created',
        resourceType: 'journal_entry',
        resourceId: entryId,
        tenantId: principal.tenantId,
        legalEntityId: book.legalEntityId,
        after: { posting_date: input.postingDate, lines: prepared.lines.length },
      });

      return {
        ...entry,
        period_name: period.name,
        total_debit: prepared.totalBaseDebit,
        total_credit: prepared.totalBaseCredit,
        is_balanced: prepared.isBalanced,
        lines: prepared.lines,
      };
    });
  }

  /** F-611 — doc 03's "Draft can be edited", which no route offered. */
  async updateDraft(
    principal: TenantPrincipal,
    id: string,
    ifMatch: string,
    input: {
      postingDate?: string | undefined;
      documentDate?: string | undefined;
      description?: string | undefined;
      accountingPeriodId?: string | undefined;
      lines?: readonly JournalLineInput[] | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const entry = await this.load(client, principal, id, { forUpdate: true });
      assertEntityPermission(principal, 'journal.edit', entry.legal_entity_id);
      assertVersion(entry.version, ifMatch, 'Journal entry', id);
      this.assertEditable(entry, 'edited');

      const postingDate = input.postingDate ?? entry.posting_date;
      const book = await this.posting.loadBookContext(
        client,
        principal,
        entry.accounting_book_id,
        postingDate,
      );
      const period = await this.posting.resolvePeriod(client, principal, {
        legalEntityId: entry.legal_entity_id,
        postingDate,
        periodId: input.accountingPeriodId ?? null,
      });

      const { rows } = await client.query<JournalEntryRow>(
        `UPDATE journal_entries
            SET posting_date = $3::date,
                document_date = coalesce($4::date, document_date),
                description = coalesce($5, description),
                accounting_period_id = $6,
                version = version + 1
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, tenant_id, legal_entity_id, accounting_book_id, journal_id,
                    accounting_period_id, branch_id, entry_number,
                    posting_date::text AS posting_date, document_date::text AS document_date,
                    description, source_type, source_id, source_event_id, reversal_of_id,
                    base_currency, status::text AS status, approval_state::text AS approval_state,
                    version::text AS version`,
        [
          id,
          principal.tenantId,
          postingDate,
          input.documentDate ?? null,
          input.description ?? null,
          period.id,
        ],
      );
      const updated = rows[0]!;

      // The lines are rewritten whenever they are supplied, and also whenever the
      // posting date moved — the period and posting_date are denormalised onto every
      // line (ADR-0003 §1) and the composite FK would reject a parent that no longer
      // matches them.
      const lines = input.lines ?? (await this.posting.readLines(client, id));
      const prepared = await this.prepareDraftLines(client, book, lines as JournalLineInput[]);
      await this.posting.writeLines(
        client,
        updated,
        {
          bookId: book.bookId,
          periodId: period.id,
          postingDate,
          branchId: updated.branch_id,
        },
        prepared,
      );

      await recordAudit(client, context, {
        action: 'journal.draft_updated',
        resourceType: 'journal_entry',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: entry.legal_entity_id,
        before: { posting_date: entry.posting_date, description: entry.description },
        after: { posting_date: postingDate, lines: prepared.lines.length },
      });

      return {
        ...updated,
        total_debit: prepared.totalBaseDebit,
        total_credit: prepared.totalBaseCredit,
        is_balanced: prepared.isBalanced,
        lines: prepared.lines,
      };
    });
  }

  async discardDraft(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const entry = await this.load(client, principal, id, { forUpdate: true });
      assertEntityPermission(principal, 'journal.edit', entry.legal_entity_id);
      this.assertEditable(entry, 'discarded');

      // Migration 0032, for the reason in posting.service.ts: `REVOKE DELETE ON
      // journal_entries` is what makes posted history permanent, and it blocks
      // removing a draft for exactly the same reason.
      await client.query(`SELECT ledger_discard_draft($1)`, [id]);

      // The audit entry outlives the journal, deliberately. "Someone created a
      // journal and then removed it" is exactly the kind of thing a reviewer asks
      // about, and it is unanswerable if the only record was the row itself.
      await recordAudit(client, context, {
        action: 'journal.draft_discarded',
        resourceType: 'journal_entry',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: entry.legal_entity_id,
        before: {
          posting_date: entry.posting_date,
          description: entry.description,
          status: entry.status,
        },
      });
      return undefined;
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async submit(principal: TenantPrincipal, id: string) {
    return this.transition(principal, id, {
      permission: 'journal.submit',
      from: ['DRAFT'],
      to: 'SUBMITTED',
      approvalState: 'PENDING',
      event: 'journal.submitted',
      // A journal that does not balance cannot be approved by anyone, so asking for
      // approval first wastes the approver's time as well as the author's.
      requireBalanced: true,
    });
  }

  async approve(principal: TenantPrincipal, id: string) {
    return this.transition(principal, id, {
      permission: 'journal.approve',
      from: ['SUBMITTED'],
      to: 'APPROVED',
      approvalState: 'APPROVED',
      event: 'journal.approved',
      requireBalanced: true,
      // doc 19 / Gate F: segregation of duties. The person who wrote the journal is
      // not the person who approves it, and the check belongs here rather than in a
      // workflow engine that Phase 6 has not built yet.
      denySelfApproval: true,
    });
  }

  private async transition(
    principal: TenantPrincipal,
    id: string,
    rule: {
      permission: string;
      from: string[];
      to: 'SUBMITTED' | 'APPROVED';
      approvalState: string;
      event: 'journal.submitted' | 'journal.approved';
      requireBalanced: boolean;
      denySelfApproval?: boolean;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const entry = await this.load(client, principal, id, { forUpdate: true });
      assertEntityPermission(principal, rule.permission, entry.legal_entity_id);

      if (entry.status === rule.to) return entry; // idempotent retry
      if (!rule.from.includes(entry.status)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This journal is ${entry.status}; ${rule.to.toLowerCase()} requires it to be ` +
            `${rule.from.join(' or ')}.`,
          { details: { status: entry.status, requested: rule.to } },
        );
      }
      if (rule.denySelfApproval && entry['created_by'] === principal.userId) {
        throw new AppError(
          'SEGREGATION_OF_DUTIES',
          'You created this journal, so you cannot approve it. Gate F requires the two to be ' +
            'different people.',
          { details: { journal_entry_id: id } },
        );
      }
      if (rule.requireBalanced) await this.assertBalanced(client, id, entry.base_currency);

      const { rows } = await client.query<JournalEntryRow>(
        `UPDATE journal_entries
            SET status = $3::journal_status,
                approval_state = $4::approval_status,
                submitted_at = CASE WHEN $3 = 'SUBMITTED' THEN now() ELSE submitted_at END,
                approved_at  = CASE WHEN $3 = 'APPROVED'  THEN now() ELSE approved_at END,
                approved_by  = CASE WHEN $3 = 'APPROVED'  THEN $5    ELSE approved_by END,
                version = version + 1
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, tenant_id, legal_entity_id, accounting_book_id, journal_id,
                    accounting_period_id, branch_id, entry_number,
                    posting_date::text AS posting_date, document_date::text AS document_date,
                    description, source_type, source_id, source_event_id, reversal_of_id,
                    base_currency, status::text AS status, approval_state::text AS approval_state,
                    version::text AS version`,
        [id, principal.tenantId, rule.to, rule.approvalState, principal.userId],
      );

      await publish(client, context, {
        eventType: rule.event,
        aggregateType: 'journal_entry',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: entry.legal_entity_id,
        accountingBookId: entry.accounting_book_id,
        payload: { from: entry.status, to: rule.to },
      });
      await recordAudit(client, context, {
        action: rule.event,
        resourceType: 'journal_entry',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: entry.legal_entity_id,
        before: { status: entry.status },
        after: { status: rule.to },
      });
      return rows[0]!;
    });
  }

  /**
   * doc 03 steps 3, 4 and 13-17.
   *
   * The whole thing is one transaction, so the period lock, the number allocation,
   * the lines, the projection, the outbox row and the audit row either all happen or
   * none do. The deferred balance trigger then fires at COMMIT and gets the last
   * word — if it disagrees with `preparePosting`, nothing is written and we have
   * found a bug in the engine rather than a wrong number in the ledger.
   */
  async post(
    principal: TenantPrincipal,
    id: string,
    input: { accountingPeriodId?: string | undefined },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const entry = await this.load(client, principal, id, { forUpdate: true });
      assertEntityPermission(principal, 'journal.post', entry.legal_entity_id);

      if (entry.status === 'POSTED') return entry; // idempotent retry
      if (!EDITABLE.has(entry.status)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This journal is ${entry.status} and cannot be posted.`,
          { details: { status: entry.status } },
        );
      }

      const book = await this.posting.loadBookContext(
        client,
        principal,
        entry.accounting_book_id,
        entry.posting_date,
      );
      const period = await this.posting.resolvePeriod(client, principal, {
        legalEntityId: entry.legal_entity_id,
        postingDate: entry.posting_date,
        periodId: input.accountingPeriodId ?? entry.accounting_period_id,
      });
      await this.posting.lockPeriod(client, principal, period.id, book.closedPeriodBehaviour);

      const lines = await this.posting.readLines(client, id);
      const prepared = await this.posting.prepare(client, book, lines);
      await this.posting.writeLines(
        client,
        entry,
        {
          bookId: book.bookId,
          periodId: period.id,
          postingDate: entry.posting_date,
          branchId: entry.branch_id,
        },
        prepared,
      );

      const entryNumber = await this.posting.allocateEntryNumber(
        client,
        principal,
        {
          legalEntityId: entry.legal_entity_id,
          branchId: entry.branch_id,
          entryId: id,
          on: new Date(`${entry.posting_date}T00:00:00Z`),
        },
        async (action, resourceId, after) => {
          await recordAudit(client, context, {
            action,
            resourceType: 'number_sequence',
            resourceId,
            tenantId: principal.tenantId,
            legalEntityId: entry.legal_entity_id,
            after,
          });
        },
      );

      return this.posting.commitPosting(client, context, principal, entry, book, prepared, {
        periodId: period.id,
        entryNumber,
      });
    });
  }

  /**
   * doc 03: "Full reversal copies original lines with debit/credit inverted,
   * references original journal, records reason/date/actor and posts normally."
   *
   * "Posts normally" is load-bearing. The reversal goes through the same period
   * lock, the same number allocation and the same balance assertion as any other
   * journal, so a reversal into a closed period is refused exactly like an original
   * would be. Reversing into a closed period by side door is how a signed-off period
   * changes after the fact.
   */
  async reverse(
    principal: TenantPrincipal,
    id: string,
    input: { reason: string; postingDate?: string | undefined },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const original = await this.load(client, principal, id, { forUpdate: true });
      assertEntityPermission(principal, 'journal.reverse', original.legal_entity_id);

      // Checked before the status, deliberately. Once an entry has been reversed its
      // status is REVERSED, so a status-first check would answer "only a POSTED
      // journal can be reversed" — true, and the least useful of the two true things
      // that can be said. The caller wants to know which entry already reversed it.
      const { rows: already } = await client.query<{ id: string; entry_number: string | null }>(
        `SELECT id, entry_number FROM journal_entries WHERE reversal_of_id = $1`,
        [id],
      );
      if (already[0]) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This journal was already reversed by ${already[0].entry_number ?? already[0].id}. ` +
            'Reversing twice would restate the original amount rather than cancel it.',
          { details: { reversal_entry_id: already[0].id } },
        );
      }
      if (original.status !== 'POSTED') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Only a POSTED journal can be reversed; this one is ${original.status}.` +
            (EDITABLE.has(original.status)
              ? ' An unposted draft is edited or discarded instead.'
              : ''),
          { details: { status: original.status } },
        );
      }

      const postingDate = input.postingDate ?? original.posting_date;
      const book = await this.posting.loadBookContext(
        client,
        principal,
        original.accounting_book_id,
        postingDate,
      );
      const period = await this.posting.resolvePeriod(client, principal, {
        legalEntityId: original.legal_entity_id,
        postingDate,
      });
      await this.posting.lockPeriod(client, principal, period.id, book.closedPeriodBehaviour);

      const originalLines = await this.posting.readLines(client, id);
      const prepared = await this.posting.prepare(client, book, originalLines);
      const inverted = {
        ...prepared,
        lines: reverseLines(prepared.lines),
        totalBaseDebit: prepared.totalBaseCredit,
        totalBaseCredit: prepared.totalBaseDebit,
      };

      const reversalId = uuidv7();
      const { rows } = await client.query<JournalEntryRow>(
        `INSERT INTO journal_entries (id, tenant_id, legal_entity_id, accounting_book_id,
                                      journal_id, accounting_period_id, branch_id, posting_date,
                                      document_date, description, source_type, source_id,
                                      reversal_of_id, reversal_reason, base_currency, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,'REVERSAL',$11,$12,$13,$14,$15)
         RETURNING id, tenant_id, legal_entity_id, accounting_book_id, journal_id,
                   accounting_period_id, branch_id, entry_number,
                   posting_date::text AS posting_date, document_date::text AS document_date,
                   description, source_type, source_id, source_event_id, reversal_of_id,
                   base_currency, status::text AS status, approval_state::text AS approval_state,
                   version::text AS version`,
        [
          reversalId,
          principal.tenantId,
          original.legal_entity_id,
          original.accounting_book_id,
          original.journal_id,
          period.id,
          original.branch_id,
          postingDate,
          original.document_date,
          `Reversal of ${original.entry_number ?? id}: ${input.reason}`,
          id,
          id,
          input.reason,
          original.base_currency,
          principal.userId,
        ],
      );
      const reversal = rows[0]!;

      await this.posting.writeLines(
        client,
        reversal,
        {
          bookId: book.bookId,
          periodId: period.id,
          postingDate,
          branchId: original.branch_id,
        },
        inverted,
      );

      const entryNumber = await this.posting.allocateEntryNumber(
        client,
        principal,
        {
          legalEntityId: original.legal_entity_id,
          branchId: original.branch_id,
          entryId: reversalId,
          on: new Date(`${postingDate}T00:00:00Z`),
        },
        async (action, resourceId, after) => {
          await recordAudit(client, context, {
            action,
            resourceType: 'number_sequence',
            resourceId,
            tenantId: principal.tenantId,
            legalEntityId: original.legal_entity_id,
            after,
          });
        },
      );

      const posted = await this.posting.commitPosting(
        client,
        context,
        principal,
        reversal,
        book,
        inverted,
        { periodId: period.id, entryNumber },
      );

      // The one UPDATE 0006 permits on a posted entry: POSTED -> REVERSED, with
      // every accounting fact unchanged. If this statement ever tried to change
      // anything else the trigger would refuse it.
      await client.query(
        `UPDATE journal_entries SET status = 'REVERSED', version = version + 1 WHERE id = $1`,
        [id],
      );

      await publish(client, context, {
        eventType: 'journal.reversed',
        aggregateType: 'journal_entry',
        aggregateId: id,
        tenantId: principal.tenantId,
        organizationId: book.organizationId,
        legalEntityId: original.legal_entity_id,
        accountingBookId: book.bookId,
        payload: {
          reversal_entry_id: reversalId,
          reversal_entry_number: entryNumber,
          original_entry_number: original.entry_number,
          reason: input.reason,
          posting_date: postingDate,
        },
      });
      await recordAudit(client, context, {
        action: 'journal.reversed',
        resourceType: 'journal_entry',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: original.legal_entity_id,
        reason: input.reason,
        before: { status: 'POSTED' },
        after: { status: 'REVERSED', reversal_entry_id: reversalId },
      });

      return { ...posted, reverses: { id, entry_number: original.entry_number } };
    });
  }

  // -------------------------------------------------------------------------
  // Scheduled reversals (F-612)
  // -------------------------------------------------------------------------

  async scheduleReversal(
    principal: TenantPrincipal,
    id: string,
    input: { scheduledDate: string; reason: string },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const entry = await this.load(client, principal, id);
      assertEntityPermission(principal, 'journal.reverse', entry.legal_entity_id);

      if (entry.status !== 'POSTED') {
        throw new AppError(
          'VALIDATION_FAILED',
          `Only a POSTED journal can have a reversal scheduled; this one is ${entry.status}.`,
        );
      }
      if (input.scheduledDate <= entry.posting_date) {
        throw new AppError(
          'VALIDATION_FAILED',
          `A reversal scheduled for ${input.scheduledDate} is not after the original posting ` +
            `date ${entry.posting_date}. An accrual reverses in a later period, not its own.`,
          { fieldErrors: [{ field: 'scheduled_date', code: 'TOO_EARLY', message: 'not after' }] },
        );
      }

      const scheduleId = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO scheduled_reversals (id, tenant_id, legal_entity_id, accounting_book_id,
                                          journal_entry_id, scheduled_date, reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7,$8)
         RETURNING id, journal_entry_id, scheduled_date::text AS scheduled_date, reason, status`,
        [
          scheduleId,
          principal.tenantId,
          entry.legal_entity_id,
          entry.accounting_book_id,
          id,
          input.scheduledDate,
          input.reason,
          principal.userId,
        ],
      );

      await recordAudit(client, context, {
        action: 'journal.reversal_scheduled',
        resourceType: 'journal_entry',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: entry.legal_entity_id,
        reason: input.reason,
        after: rows[0]!,
      });
      return rows[0]!;
    });
  }

  async listScheduledReversals(
    principal: TenantPrincipal,
    filters: { legalEntityId?: string | undefined; status?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const where = ['s.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];
      if (filters.legalEntityId) {
        assertEntityPermission(principal, 'journal.view', filters.legalEntityId);
        params.push(filters.legalEntityId);
        where.push(`s.legal_entity_id = $${params.length}`);
      } else {
        const scope = entityScope(principal);
        if (scope.kind === 'ENTITIES') {
          params.push(scope.legalEntityIds);
          where.push(`s.legal_entity_id = ANY($${params.length}::uuid[])`);
        }
      }
      if (filters.status) {
        params.push(filters.status);
        where.push(`s.status = $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT s.id, s.legal_entity_id, s.journal_entry_id, s.scheduled_date::text AS scheduled_date,
                s.reason, s.status, s.attempts, s.last_error, s.executed_at, s.reversal_entry_id,
                s.cancelled_at, s.cancel_reason,
                e.entry_number, e.posting_date::text AS original_posting_date
           FROM scheduled_reversals s
           JOIN journal_entries e ON e.id = s.journal_entry_id
          WHERE ${where.join(' AND ')}
          ORDER BY s.scheduled_date, s.id
          LIMIT 500`,
        params,
      );
      return { data: rows };
    });
  }

  async cancelScheduledReversal(principal: TenantPrincipal, id: string, input: { reason: string }) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: found } = await client.query<{
        id: string;
        tenant_id: string;
        legal_entity_id: string;
        status: string;
        journal_entry_id: string;
      }>(
        `SELECT id, tenant_id, legal_entity_id, status, journal_entry_id
           FROM scheduled_reversals WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [id, principal.tenantId],
      );
      const schedule = found[0];
      if (!schedule) throw notFound('Scheduled reversal', id);
      assertEntityPermission(principal, 'journal.reverse', schedule.legal_entity_id);

      if (schedule.status !== 'PENDING') {
        throw new AppError(
          'VALIDATION_FAILED',
          `This schedule is ${schedule.status}.` +
            (schedule.status === 'EXECUTED'
              ? ' The reversal has already posted; reverse the reversal to undo it.'
              : ''),
          { details: { status: schedule.status } },
        );
      }

      const { rows } = await client.query(
        `UPDATE scheduled_reversals
            SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3
          WHERE id = $1
          RETURNING id, journal_entry_id, scheduled_date::text AS scheduled_date, status,
                    cancel_reason`,
        [id, principal.userId, input.reason],
      );
      await recordAudit(client, context, {
        action: 'journal.reversal_schedule_cancelled',
        resourceType: 'scheduled_reversal',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: schedule.legal_entity_id,
        reason: input.reason,
        before: { status: 'PENDING' },
        after: { status: 'CANCELLED' },
      });
      return rows[0]!;
    });
  }

  // -------------------------------------------------------------------------

  private async prepareDraftLines(
    client: PoolClient,
    book: Awaited<ReturnType<PostingService['loadBookContext']>>,
    lines: readonly JournalLineInput[],
  ) {
    const draftLines: DraftLineInput[] = lines.map((l, i) => ({
      lineNo: i + 1,
      accountId: l.accountId,
      description: l.description ?? null,
      transactionCurrency: l.transactionCurrency,
      debit: l.debit,
      credit: l.credit,
      exchangeRate: l.exchangeRate,
      exchangeRateDate: l.exchangeRateDate,
      exchangeRateSource: l.exchangeRateSource,
      branchId: l.branchId,
      contactId: l.contactId,
      dimensions: l.dimensions,
    }));

    const accountIds = draftLines.map((l) => l.accountId);
    const [accounts, currencies] = await Promise.all([
      this.posting.loadAccounts(client, book.legalEntityId, accountIds),
      this.posting.loadCurrencies(client),
    ]);
    return prepareDraft(draftLines, {
      baseCurrency: book.baseCurrency,
      accounts,
      currencies,
      roundingMode: book.roundingMode,
      roundingAccountId: book.roundingAccountId,
      roundingTolerance: book.roundingTolerance,
    });
  }

  private assertEditable(entry: JournalEntryRow, verb: string): void {
    if (EDITABLE.has(entry.status)) return;
    throw new AppError(
      'POSTED_IMMUTABLE',
      `This journal is ${entry.status} and cannot be ${verb}. Posted history is corrected by ` +
        'reversal (doc 01 rule 4), never by editing.',
      { details: { status: entry.status } },
    );
  }

  private async assertBalanced(
    client: PoolClient,
    entryId: string,
    currency: string,
  ): Promise<void> {
    const { rows } = await client.query<{ debit: string; credit: string; lines: string }>(
      `SELECT coalesce(sum(base_debit), 0)::text AS debit,
              coalesce(sum(base_credit), 0)::text AS credit,
              count(*)::text AS lines
         FROM journal_lines WHERE journal_entry_id = $1`,
      [entryId],
    );
    const totals = rows[0]!;
    if (Number(totals.lines) === 0) {
      throw new AppError('UNBALANCED_JOURNAL', 'This journal has no lines.');
    }
    if (totals.debit !== totals.credit) {
      throw new AppError(
        'UNBALANCED_JOURNAL',
        `This journal does not balance: debits ${totals.debit} against credits ${totals.credit} ` +
          `${currency}.`,
        { details: { debit: totals.debit, credit: totals.credit, currency } },
      );
    }
  }

  private async load(
    client: PoolClient,
    principal: TenantPrincipal,
    id: string,
    options: { forUpdate?: boolean } = {},
  ): Promise<JournalEntryRow> {
    const { rows } = await client.query<JournalEntryRow>(
      `SELECT id, tenant_id, legal_entity_id, accounting_book_id, journal_id,
              accounting_period_id, branch_id, entry_number, posting_date::text AS posting_date,
              document_date::text AS document_date, description, source_type, source_id,
              source_event_id, reversal_of_id, reversal_reason, base_currency,
              status::text AS status, approval_state::text AS approval_state,
              version::text AS version, created_by, posted_at, posted_by, created_at
         FROM journal_entries WHERE id = $1 AND tenant_id = $2
         ${options.forUpdate ? 'FOR UPDATE' : ''}`,
      [id, principal.tenantId],
    );
    if (!rows[0]) throw notFound('Journal entry', id);
    return rows[0];
  }

  private async loadJournalDefinition(
    client: PoolClient,
    journalId: string,
    bookId: string,
  ): Promise<{ id: string; code: string; journal_type: string }> {
    const { rows } = await client.query<{ id: string; code: string; journal_type: string }>(
      `SELECT id, code, journal_type FROM journals
        WHERE id = $1 AND accounting_book_id = $2 AND status = 'ACTIVE'`,
      [journalId, bookId],
    );
    if (!rows[0]) {
      throw new AppError(
        'BOOK_MISMATCH',
        `Journal ${journalId} does not belong to this accounting book, or is not active.`,
        { details: { journal_id: journalId, accounting_book_id: bookId } },
      );
    }
    return rows[0];
  }
}

/** Exposed for the worker, which posts scheduled reversals without an HTTP request. */
export const JOURNAL_EDITABLE_STATUSES = EDITABLE;
