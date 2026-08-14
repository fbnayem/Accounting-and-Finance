import {
  AppError,
  D,
  accountingDate,
  normalizeText,
  type AccountingDate,
  type CanonicalBankTransaction,
} from '@acct/domain';

/**
 * Import adapters — doc 06 "Feed/import ingestion".
 *
 * Every format collapses to `CanonicalBankTransaction` here and nowhere else.
 * That is the whole design: dedupe, rules, matching and reconciliation are
 * written once against the canonical shape and never learn which adapter
 * produced a row. An adapter that leaked its format downstream — an OFX flag, a
 * CAMT-only field — would make every one of those four a per-format branch.
 *
 * doc 06 lists live API, CSV, OFX/QFX/QIF, CAMT/MT940 and processor files. The
 * ones implemented here are the ones a generic/global first release needs; the
 * statement standards are geography-driven and doc 06 says so ("as market need
 * dictates", "by geography"). Each unimplemented format fails loudly with the
 * reason rather than silently parsing to nothing.
 */

export type ImportFormat =
  'API' | 'CSV' | 'OFX' | 'QFX' | 'QIF' | 'MT940' | 'CAMT053' | 'PROCESSOR';

export interface ParsedStatement {
  readonly format: ImportFormat;
  readonly statementRef: string | null;
  readonly periodStart: AccountingDate | null;
  readonly periodEnd: AccountingDate | null;
  readonly openingBalance: string | null;
  readonly closingBalance: string | null;
  readonly transactions: readonly CanonicalBankTransaction[];
}

export interface AdapterInput {
  readonly format: ImportFormat;
  readonly currency: string;
  /** Raw file content, for the file formats. */
  readonly content?: string | undefined;
  /** Already-canonical rows, for the API and processor paths. */
  readonly rows?: readonly RawRow[] | undefined;
  readonly statementRef?: string | null | undefined;
}

/** What a live connector or a JSON body hands us before normalization. */
export interface RawRow {
  readonly providerTransactionId?: string | null;
  readonly date: string;
  readonly valueDate?: string | null;
  readonly amount: string;
  readonly description?: string | null;
  readonly counterparty?: string | null;
  readonly reference?: string | null;
  readonly balance?: string | null;
  readonly categoryCode?: string | null;
}

export function parseStatement(input: AdapterInput): ParsedStatement {
  switch (input.format) {
    case 'API':
    case 'PROCESSOR':
      return fromRows(input);
    case 'CSV':
      return fromCsv(input);
    case 'OFX':
    case 'QFX':
      return fromOfx(input);
    case 'QIF':
      return fromQif(input);
    case 'MT940':
    case 'CAMT053':
      throw new AppError(
        'VALIDATION_FAILED',
        `${input.format} is a geography-specific statement standard. doc 06 scopes these ` +
          `"by geography" and the first release is generic/global, so no country pack defines ` +
          `its dialect yet. Import the same statement as CSV or connect the account by API.`,
      );
    default:
      throw new AppError('VALIDATION_FAILED', `Unknown import format "${String(input.format)}".`);
  }
}

// ---------------------------------------------------------------------------

function fromRows(input: AdapterInput): ParsedStatement {
  const rows = input.rows ?? [];
  if (rows.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'An import must contain at least one transaction.');
  }
  const transactions = rows.map((r, i) => canonicalise(r, input.currency, i));
  return {
    format: input.format,
    statementRef: input.statementRef ?? null,
    ...periodOf(transactions),
    openingBalance: null,
    closingBalance: rows[rows.length - 1]?.balance ?? null,
    transactions,
  };
}

/**
 * CSV, with a header row that names its own columns.
 *
 * Deliberately header-driven rather than positional: every bank exports a
 * different column order, and a positional parser silently reads the balance
 * column as the amount the first time a bank reorders its export. Unknown
 * columns are ignored; missing required ones are named in the error.
 */
function fromCsv(input: AdapterInput): ParsedStatement {
  const text = (input.content ?? '').trim();
  if (!text) {
    throw new AppError('VALIDATION_FAILED', 'The CSV file is empty.');
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = splitCsvLine(lines[0]!).map((h) => normalizeText(h).replace(/ /g, '_'));

  const columnFor = (...names: string[]): number => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };

  const iDate = columnFor('date', 'transaction_date', 'booking_date', 'posted_date');
  const iAmount = columnFor('amount', 'value');
  const iDebit = columnFor('debit', 'paid_out', 'withdrawal');
  const iCredit = columnFor('credit', 'paid_in', 'deposit');

  const missing: string[] = [];
  if (iDate < 0) missing.push('date');
  if (iAmount < 0 && (iDebit < 0 || iCredit < 0)) missing.push('amount (or debit and credit)');
  if (missing.length > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `The CSV header does not name ${missing.join(' and ')}. Found: ${header.join(', ')}. ` +
        `Columns are matched by name, not position, so a reordered export still imports.`,
    );
  }

  const iValueDate = columnFor('value_date', 'settlement_date');
  const iDescription = columnFor('description', 'narrative', 'details', 'memo');
  const iCounterparty = columnFor('counterparty', 'payee', 'name', 'merchant');
  const iReference = columnFor('reference', 'ref', 'payment_reference');
  const iBalance = columnFor('balance', 'running_balance');
  const iProvider = columnFor('transaction_id', 'id', 'provider_transaction_id', 'fitid');

  const transactions = lines.slice(1).map((line, i) => {
    const cells = splitCsvLine(line);
    const at = (idx: number): string | null =>
      idx >= 0 && idx < cells.length ? cells[idx]!.trim() || null : null;

    // Debit/credit columns are the other common shape, and they are mutually
    // exclusive per row. A row with both populated is a file we do not
    // understand, not a row we should guess at.
    let amount = at(iAmount);
    if (amount === null) {
      const debit = at(iDebit);
      const credit = at(iCredit);
      if (debit && credit) {
        throw new AppError(
          'VALIDATION_FAILED',
          `CSV row ${i + 2} populates both debit and credit; the direction is ambiguous.`,
        );
      }
      amount = debit ? `-${stripThousands(debit)}` : stripThousands(credit ?? '0');
    } else {
      amount = stripThousands(amount);
    }

    return canonicalise(
      {
        providerTransactionId: at(iProvider),
        date: at(iDate) ?? '',
        valueDate: at(iValueDate),
        amount,
        description: at(iDescription),
        counterparty: at(iCounterparty),
        reference: at(iReference),
        balance: at(iBalance) ? stripThousands(at(iBalance)!) : null,
      },
      input.currency,
      i,
    );
  });

  return {
    format: 'CSV',
    statementRef: input.statementRef ?? null,
    ...periodOf(transactions),
    openingBalance: null,
    closingBalance: transactions[transactions.length - 1]?.runningBalance?.toString() ?? null,
    transactions,
  };
}

/** OFX/QFX: SGML-ish tags, one `<STMTTRN>` block per transaction. */
function fromOfx(input: AdapterInput): ParsedStatement {
  const text = input.content ?? '';
  const blocks = [...text.matchAll(/<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi)].map((m) => m[1]!);
  if (blocks.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'No <STMTTRN> blocks found. This does not look like an OFX/QFX statement.',
    );
  }
  const tag = (block: string, name: string): string | null => {
    const m = new RegExp(`<${name}>([^<\r\n]*)`, 'i').exec(block);
    return m ? m[1]!.trim() || null : null;
  };

  const transactions = blocks.map((b, i) =>
    canonicalise(
      {
        // FITID is OFX's provider transaction id, and doc 06's primary dedupe key.
        providerTransactionId: tag(b, 'FITID'),
        date: ofxDate(tag(b, 'DTPOSTED')),
        valueDate: tag(b, 'DTAVAIL') ? ofxDate(tag(b, 'DTAVAIL')) : null,
        amount: tag(b, 'TRNAMT') ?? '0',
        description: tag(b, 'MEMO'),
        counterparty: tag(b, 'NAME'),
        reference: tag(b, 'CHECKNUM') ?? tag(b, 'REFNUM'),
      },
      input.currency,
      i,
    ),
  );

  const ledgerBal = /<LEDGERBAL>[\s\S]*?<BALAMT>([^<\r\n]*)/i.exec(text)?.[1]?.trim() ?? null;
  return {
    format: input.format === 'QFX' ? 'QFX' : 'OFX',
    statementRef: input.statementRef ?? null,
    ...periodOf(transactions),
    openingBalance: null,
    closingBalance: ledgerBal,
    transactions,
  };
}

/** QIF: line-prefixed records terminated by `^`. No transaction ids exist in it. */
function fromQif(input: AdapterInput): ParsedStatement {
  const text = (input.content ?? '').trim();
  if (!text) throw new AppError('VALIDATION_FAILED', 'The QIF file is empty.');

  const records = text.split(/^\^\s*$/m).filter((r) => r.trim().length > 0);
  const transactions: CanonicalBankTransaction[] = [];

  records.forEach((record, i) => {
    const fields = new Map<string, string>();
    for (const line of record.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('!')) continue;
      const key = trimmed[0]!;
      const value = trimmed.slice(1).trim();
      // M (memo) can repeat; keep the first, which is the payee-facing one.
      if (!fields.has(key)) fields.set(key, value);
    }
    if (!fields.has('D') || !fields.has('T')) return;
    transactions.push(
      canonicalise(
        {
          // QIF carries no stable identifier, so every row falls to the
          // fingerprint path. That is exactly why the fingerprint index is not
          // unique (F-028): re-importing a QIF must raise review items, not
          // silently drop a real second coffee of the same amount.
          providerTransactionId: null,
          date: qifDate(fields.get('D')!),
          amount: stripThousands(fields.get('T')!),
          description: fields.get('M') ?? null,
          counterparty: fields.get('P') ?? null,
          reference: fields.get('N') ?? null,
        },
        input.currency,
        i,
      ),
    );
  });

  if (transactions.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'No QIF records with both a date (D) and an amount (T) were found.',
    );
  }
  return {
    format: 'QIF',
    statementRef: input.statementRef ?? null,
    ...periodOf(transactions),
    openingBalance: null,
    closingBalance: null,
    transactions,
  };
}

// ---------------------------------------------------------------------------

function canonicalise(row: RawRow, currency: string, index: number): CanonicalBankTransaction {
  let date: AccountingDate;
  try {
    date = accountingDate(isoDate(row.date));
  } catch (err) {
    // `isoDate` raises its own diagnosis for the cases it can name — an
    // ambiguous DD/MM vs MM/DD file, most importantly. Wrapping that in the
    // generic message would discard the one thing the caller needs to know.
    if (err instanceof AppError) throw err;
    throw new AppError(
      'VALIDATION_FAILED',
      `Row ${index + 1} has an unreadable date "${row.date}". Expected ISO (YYYY-MM-DD).`,
    );
  }

  let amount;
  try {
    amount = D(String(row.amount).trim());
  } catch {
    throw new AppError(
      'VALIDATION_FAILED',
      `Row ${index + 1} has an unreadable amount "${row.amount}".`,
    );
  }
  if (amount.isZero()) {
    // `bank_transactions` CHECKs amount <> 0. A zero-amount bank line is a
    // statement artefact, not a cash movement.
    throw new AppError(
      'VALIDATION_FAILED',
      `Row ${index + 1} has a zero amount, which is not a cash movement.`,
    );
  }

  return {
    providerTransactionId: row.providerTransactionId ?? null,
    transactionDate: date,
    valueDate: row.valueDate ? accountingDate(isoDate(row.valueDate)) : null,
    currency,
    amount,
    description: row.description ?? null,
    counterpartyName: row.counterparty ?? null,
    reference: row.reference ?? null,
    runningBalance: row.balance ? D(row.balance) : null,
    categoryCode: row.categoryCode ?? null,
    raw: row,
  };
}

function periodOf(transactions: readonly CanonicalBankTransaction[]): {
  periodStart: AccountingDate | null;
  periodEnd: AccountingDate | null;
} {
  if (transactions.length === 0) return { periodStart: null, periodEnd: null };
  const dates = transactions.map((t) => t.transactionDate).sort();
  return { periodStart: dates[0]!, periodEnd: dates[dates.length - 1]! };
}

/** Splits one CSV line, honouring double quotes and `""` escapes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      out.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  out.push(cell);
  return out;
}

/** Removes thousands separators without touching the decimal point. */
function stripThousands(value: string): string {
  const trimmed = value.trim().replace(/[£$€\s]/g, '');
  // European format: 1.234,56 — comma is the decimal separator.
  if (/^-?\d{1,3}(\.\d{3})+,\d+$/.test(trimmed)) {
    return trimmed.replace(/\./g, '').replace(',', '.');
  }
  return trimmed.replace(/,/g, '');
}

/** Accepts ISO, `DD/MM/YYYY` and `MM/DD/YYYY` is deliberately NOT guessed. */
function isoDate(value: string): string {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  // DD/MM/YYYY only. Guessing between that and MM/DD/YYYY is how a statement
  // silently lands three months out; an unambiguous failure is better.
  const m = /^(\d{2})[/.](\d{2})[/.](\d{4})$/.exec(v);
  if (m) {
    const [, dd, mm, yyyy] = m;
    if (Number(mm) > 12) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Date "${v}" has a month above 12. Dates are read as DD/MM/YYYY.`,
      );
    }
    return `${yyyy}-${mm}-${dd}`;
  }
  return v;
}

function ofxDate(value: string | null): string {
  if (!value) return '';
  // OFX dates are YYYYMMDD with an optional time and timezone suffix.
  const digits = value.replace(/[^0-9]/g, '');
  if (digits.length < 8) return value;
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function qifDate(value: string): string {
  // QIF is MM/DD/YY or MM/DD'YY depending on vintage. Normalised to ISO here
  // because QIF is US-originated and unambiguously month-first.
  const m = /^(\d{1,2})[/](\d{1,2})[/'](\d{2,4})$/.exec(value.trim());
  if (!m) return value.trim();
  const [, mm, dd, yy] = m;
  const year = yy!.length === 2 ? `20${yy}` : yy!;
  return `${year}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}`;
}
