import { PoolClient } from 'pg';
import {
  AppError,
  Money,
  D,
  uuidv7,
  accountingEventId,
  toBase,
  type TenantPrincipal,
  type CalculatedDocument,
  type DraftLineInput,
  type RequestContext,
} from '@acct/domain';
import { PostingService, type BookContext, type JournalEntryRow } from '@acct/ledger';
import { recordAudit } from '@acct/database';
import type { ResolvedTaxCode, TaxService } from './tax.service';

/**
 * The one path by which a subledger document becomes a journal.
 *
 * doc 21's dependency rule for this phase: "All invoice, credit, receipt, bill,
 * payment, tax and write-off events invoke Phase 2 posting service using the
 * posting-rule catalog." Eight document types, one function — not because they
 * are the same shape, but because the alternative is eight places that each
 * decide independently what a control account is and which of them rounds.
 *
 * What a caller supplies is the lines in accounting terms. What this adds is
 * everything that is true of every posting: the period, the lock, the entry
 * number, the balance assertion, the tax subledger and the link back from the
 * document to the entry it produced. A caller that forgot one of those would
 * produce a journal that balances and reconciles to nothing.
 */

export interface DocumentPostingRequest {
  /** `SALES_INVOICE_POSTED`, `VENDOR_BILL_POSTED`, … from the posting rule catalog. */
  readonly ruleCode: string;
  readonly sourceType: string;
  readonly sourceId: string;
  /**
   * doc 03 step 4: the idempotency key for the accounting event. Two attempts to
   * post the same invoice produce one journal, and the second returns the first.
   */
  readonly sourceEventId: string;
  readonly journalCode: string;
  readonly postingDate: string;
  readonly documentDate: string;
  readonly description: string;
  readonly branchId: string | null;
  readonly contactId: string | null;
  /**
   * The entry this one cancels, when it is a compensating entry.
   *
   * doc 01 rule 4 corrects posted history by reversal rather than mutation, and a
   * reversal that does not say what it reverses leaves two entries that only a
   * human reading amounts can pair up. `journal_entries.reversal_of_id` is what
   * the ledger's own drill chain follows, and Phase 3's sixth exit criterion is
   * that the chain is complete — so a subledger reversal has to fill it in for
   * the same reason `JournalService.reverse` does.
   */
  readonly reversalOfId?: string | null | undefined;
  readonly lines: readonly DraftLineInput[];
  readonly tax?:
    | {
        readonly calculated: CalculatedDocument;
        readonly codes: ReadonlyMap<string, ResolvedTaxCode>;
        readonly direction: 'OUTPUT' | 'INPUT' | 'WITHHOLDING';
        readonly sign: 1 | -1;
        readonly currency: string;
        readonly exchangeRate: string;
      }
    | undefined;
}

export interface DocumentPostingResult {
  readonly entry: JournalEntryRow;
  readonly taxRowsWritten: number;
  readonly replayed: boolean;
}

export class DocumentPostingService {
  constructor(
    private readonly posting: PostingService,
    private readonly tax: TaxService,
  ) {}

  /**
   * Resolves the journal a document type posts into, creating it on first use.
   *
   * doc 03 names eleven journal types and a document has to land in one. Failing
   * the first invoice because nobody created a "Sales journal" would be correct
   * and useless — doc 02's criterion is that an organization reaches
   * posting-ready without direct database work. The creation is audited by the
   * caller's own audit record, so it is visible rather than silent.
   */
  async resolveJournal(
    client: PoolClient,
    principal: TenantPrincipal,
    book: BookContext,
    code: string,
    name: string,
    type: string,
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM journals WHERE accounting_book_id = $1 AND code = $2`,
      [book.bookId, code],
    );
    if (rows[0]) return rows[0].id;

    const { rows: created } = await client.query<{ id: string }>(
      `INSERT INTO journals (id, tenant_id, legal_entity_id, accounting_book_id, code, name,
                             journal_type)
       -- journals.journal_type is text with a CHECK, not an enum (0005). Casting
       -- to a type that does not exist fails at plan time, so every subledger
       -- document that had to create its journal on first use failed here.
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (accounting_book_id, code) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [uuidv7(), principal.tenantId, book.legalEntityId, book.bookId, code, name, type],
    );
    return created[0]!.id;
  }

  /**
   * Posts a document.
   *
   * The order is doc 03's posting algorithm and is not rearrangeable: resolve the
   * period before locking it, lock before reading balances, allocate the number
   * last so a failure downstream does not consume one. A gap in a document
   * sequence is a question an auditor asks and nobody can answer afterwards.
   */
  async post(
    client: PoolClient,
    context: RequestContext,
    principal: TenantPrincipal,
    book: BookContext,
    request: DocumentPostingRequest,
  ): Promise<DocumentPostingResult> {
    // `journal_entries.source_event_id` is a uuid; callers name their events
    // readably (`invoice.posted:<id>`). Hashing the name here rather than at
    // every call site means the readable form stays in the code that raises the
    // event, and one function decides how it reaches the column — F-725, which
    // was found by the first request that actually tried to post.
    const sourceEventId = accountingEventId(request.sourceEventId);

    // doc 03 step 4, before anything else has a side effect.
    const existing = await this.posting.findBySourceEvent(client, principal, {
      legalEntityId: book.legalEntityId,
      bookId: book.bookId,
      sourceEventId,
    });
    if (existing) return { entry: existing, taxRowsWritten: 0, replayed: true };

    if (request.lines.length === 0) {
      throw new AppError(
        'VALIDATION_FAILED',
        `${request.sourceType} ${request.sourceId} produced no accounting lines. A document that ` +
          'posts nothing is a configuration gap, not a valid posting.',
        { details: { rule: request.ruleCode, source_id: request.sourceId } },
      );
    }

    const journalId = await this.resolveJournal(
      client,
      principal,
      book,
      request.journalCode,
      JOURNAL_NAMES[request.journalCode] ?? request.journalCode,
      JOURNAL_TYPES[request.journalCode] ?? 'GENERAL',
    );

    const period = await this.posting.resolvePeriod(client, principal, {
      legalEntityId: book.legalEntityId,
      postingDate: request.postingDate,
    });
    await this.posting.lockPeriod(client, principal, period.id, book.closedPeriodBehaviour);

    const entryId = uuidv7();
    const { rows } = await client.query<JournalEntryRow>(
      `INSERT INTO journal_entries (id, tenant_id, legal_entity_id, accounting_book_id, journal_id,
                                    accounting_period_id, branch_id, posting_date, document_date,
                                    description, source_type, source_id, source_event_id,
                                    base_currency, status, created_by, reversal_of_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9::date,$10,$11,$12,$13,$14,'DRAFT',$15,$16)
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
        journalId,
        period.id,
        request.branchId,
        request.postingDate,
        request.documentDate,
        request.description,
        request.sourceType,
        request.sourceId,
        sourceEventId,
        book.baseCurrency,
        principal.userId,
        request.reversalOfId ?? null,
      ],
    );
    const entry = rows[0]!;

    const prepared = await this.posting.prepare(client, book, request.lines);
    await this.posting.writeLines(
      client,
      entry,
      {
        bookId: book.bookId,
        periodId: period.id,
        postingDate: request.postingDate,
        branchId: request.branchId,
      },
      prepared,
    );

    const entryNumber = await this.posting.allocateEntryNumber(
      client,
      principal,
      {
        legalEntityId: book.legalEntityId,
        branchId: request.branchId,
        entryId,
        on: new Date(`${request.postingDate}T00:00:00Z`),
      },
      async (action, resourceId, after) => {
        await recordAudit(client, context, {
          action,
          resourceType: 'number_sequence',
          resourceId,
          tenantId: principal.tenantId,
          legalEntityId: book.legalEntityId,
          after,
        });
      },
    );

    const posted = await this.posting.commitPosting(
      client,
      context,
      principal,
      entry,
      book,
      prepared,
      { periodId: period.id, entryNumber },
    );

    // The tax subledger, in the same transaction as the journal it explains.
    // Gate D compares the two; writing them apart is how they come to differ,
    // and a nightly job that reconciles them would only be discovering it late.
    let taxRowsWritten = 0;
    if (request.tax) {
      taxRowsWritten = await this.tax.recordTransactions(
        client,
        principal,
        {
          legalEntityId: book.legalEntityId,
          accountingBookId: book.bookId,
          journalEntryId: posted.id,
          sourceType: request.sourceType,
          sourceId: request.sourceId,
          transactionDate: request.documentDate,
          postingDate: request.postingDate,
          currency: request.tax.currency,
          exchangeRate: request.tax.exchangeRate,
          baseCurrency: book.baseCurrency,
          direction: request.tax.direction,
          sign: request.tax.sign,
        },
        request.tax.calculated,
        request.tax.codes,
      );
    }

    return { entry: posted, taxRowsWritten, replayed: false };
  }
}

/**
 * doc 03's journal types, keyed by the code each document type posts into.
 *
 * A constant rather than configuration: a tenant may add journals, but which
 * journal a sales invoice lands in is an accounting convention, not a
 * preference, and making it configurable creates a tenant whose sales sit in the
 * purchase journal with nothing wrong according to the system.
 */
const JOURNAL_NAMES: Record<string, string> = {
  SAL: 'Sales journal',
  PUR: 'Purchase journal',
  BNK: 'Bank journal',
  CSH: 'Cash journal',
  GEN: 'General journal',
};

const JOURNAL_TYPES: Record<string, string> = {
  SAL: 'SALES',
  PUR: 'PURCHASE',
  BNK: 'BANK',
  CSH: 'CASH',
  GEN: 'GENERAL',
};

/**
 * Builds the accounting lines for a sale.
 *
 * Posting rule catalog, SALES_INVOICE_POSTED:
 *   Dr Accounts Receivable — gross
 *   Cr Revenue             — net, by line
 *   Cr Output Tax Payable  — by component
 *
 * Per line rather than one summarised revenue line, because doc 12's Sales by
 * Customer/Product/Dimension reports read the ledger, and a summarised line
 * cannot carry two different dimensions.
 */
export function salesInvoiceLines(input: {
  readonly calculated: CalculatedDocument;
  readonly revenueAccountByLine: ReadonlyMap<number, string>;
  readonly taxAccountByComponent: ReadonlyMap<string, string>;
  readonly arAccountId: string;
  readonly currency: string;
  readonly baseCurrency: string;
  readonly exchangeRate: string;
  readonly exchangeRateDate: string | null;
  readonly contactId: string;
  readonly dimensionsByLine?: ReadonlyMap<number, Record<string, string>> | undefined;
  readonly sign?: 1 | -1;
}): DraftLineInput[] {
  const sign = input.sign ?? 1;
  const debit = (v: string) => (sign === 1 ? { debit: v } : { credit: v });
  const credit = (v: string) => (sign === 1 ? { credit: v } : { debit: v });
  const fx = {
    transactionCurrency: input.currency,
    exchangeRate: input.exchangeRate,
    ...(input.exchangeRateDate ? { exchangeRateDate: input.exchangeRateDate } : {}),
  };

  const lines: DraftLineInput[] = [
    {
      accountId: input.arAccountId,
      description: 'Accounts receivable',
      contactId: input.contactId,
      ...debit(input.calculated.total),
      ...fx,
    },
  ];

  for (const line of input.calculated.lines) {
    const accountId = input.revenueAccountByLine.get(line.lineNo);
    if (!accountId) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Line ${line.lineNo} has no revenue account, so there is nothing to credit.`,
        { details: { line_no: line.lineNo } },
      );
    }
    lines.push({
      accountId,
      description: `Line ${line.lineNo}`,
      ...credit(line.netAmount),
      ...fx,
      ...(input.dimensionsByLine?.get(line.lineNo)
        ? { dimensions: input.dimensionsByLine.get(line.lineNo) as Record<string, string> }
        : {}),
    });
  }

  for (const component of input.calculated.taxByComponent) {
    if (component.taxAmount === '0.00000000') continue;
    const accountId = input.taxAccountByComponent.get(component.componentId);
    if (!accountId) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Tax component ${component.code} has no output tax account on its tax code, so the tax ` +
          'it calculated has nowhere to post. Set payable_account_id on the tax code.',
        { details: { component: component.code } },
      );
    }
    lines.push({
      accountId,
      description: `Output tax ${component.code}`,
      ...credit(component.taxAmount),
      ...fx,
    });
  }

  return lines;
}

/**
 * Builds the accounting lines for a purchase.
 *
 * Posting rule catalog, VENDOR_BILL_POSTED:
 *   Dr Destination (expense/asset/inventory) — net, by line
 *   Dr Recoverable Input Tax                 — by component
 *   Dr Destination                           — non-recoverable tax, capitalised
 *   Cr Accounts Payable                      — gross
 *
 * The non-recoverable half is added to the LINE's destination rather than to a
 * tax account, which is doc 07's rule: "Nonrecoverable tax capitalizes into
 * inventory/asset cost or expense based on line destination." Posting it to a
 * tax account instead is the standard way an asset ends up understated.
 */
export function vendorBillLines(input: {
  readonly calculated: CalculatedDocument;
  readonly destinationAccountByLine: ReadonlyMap<number, string>;
  readonly taxAccountByComponent: ReadonlyMap<string, string>;
  readonly apAccountId: string;
  readonly currency: string;
  readonly exchangeRate: string;
  readonly exchangeRateDate: string | null;
  readonly contactId: string;
  readonly dimensionsByLine?: ReadonlyMap<number, Record<string, string>> | undefined;
  readonly sign?: 1 | -1;
}): DraftLineInput[] {
  const sign = input.sign ?? 1;
  const debit = (v: string) => (sign === 1 ? { debit: v } : { credit: v });
  const credit = (v: string) => (sign === 1 ? { credit: v } : { debit: v });
  const fx = {
    transactionCurrency: input.currency,
    exchangeRate: input.exchangeRate,
    ...(input.exchangeRateDate ? { exchangeRateDate: input.exchangeRateDate } : {}),
  };
  const lines: DraftLineInput[] = [];

  for (const line of input.calculated.lines) {
    const accountId = input.destinationAccountByLine.get(line.lineNo);
    if (!accountId) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Line ${line.lineNo} has no destination account, so there is nothing to debit.`,
        { details: { line_no: line.lineNo } },
      );
    }
    // Net plus the non-recoverable tax on this line: one debit, because they
    // land in the same account and splitting them would make the expense report
    // disagree with the expense.
    const nonrecoverable = line.components.reduce(
      (a: string, c: { nonrecoverableAmount: string }) => addDecimal(a, c.nonrecoverableAmount),
      '0',
    );
    lines.push({
      accountId,
      description: `Line ${line.lineNo}`,
      ...debit(addDecimal(line.netAmount, nonrecoverable)),
      ...fx,
      ...(input.dimensionsByLine?.get(line.lineNo)
        ? { dimensions: input.dimensionsByLine.get(line.lineNo) as Record<string, string> }
        : {}),
    });
  }

  for (const component of input.calculated.taxByComponent) {
    if (component.recoverableAmount === '0.00000000') continue;
    const accountId = input.taxAccountByComponent.get(component.componentId);
    if (!accountId) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Tax component ${component.code} has no input tax account on its tax code, so the ` +
          'recoverable tax has nowhere to post. Set receivable_account_id on the tax code.',
        { details: { component: component.code } },
      );
    }
    lines.push({
      accountId,
      description: `Input tax ${component.code}`,
      ...debit(component.recoverableAmount),
      ...fx,
    });
  }

  lines.push({
    accountId: input.apAccountId,
    description: 'Accounts payable',
    contactId: input.contactId,
    ...credit(input.calculated.total),
    ...fx,
  });

  return lines;
}

/**
 * Adds two already-rounded decimal strings.
 *
 * Delegates to `Money` rather than doing string arithmetic here. There is one
 * implementation of money in this codebase and `pnpm dod:check` enforces it —
 * a local helper is how the second one starts, and the second one is always the
 * one that rounds differently.
 */
function addDecimal(a: string, b: string): string {
  return Money.of(D(a), NEUTRAL)
    .add(Money.of(D(b), NEUTRAL))
    .toString();
}

/**
 * These sums are within one line of one document, so both operands are already
 * in the same currency and the code is only needed to satisfy Money's invariant.
 */
const NEUTRAL = 'XXX';

export { addDecimal };

export { toBase };
