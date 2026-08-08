/**
 * Presentation formatting.
 *
 * ADR-0006 consequences: "The presentation layer formats using
 * `currencies.minor_unit`; it never rounds a value that the server has already
 * rounded." So these functions take a decimal string and a minor unit, and neither
 * of them does arithmetic — a UI that recomputes a total is a UI that will one day
 * disagree with the ledger.
 *
 * ADR-0010 §3: "Colour is never the sole carrier of meaning. A negative balance is
 * red **and** parenthesised or signed." `formatAmount` provides the non-colour
 * signal, so a component cannot forget it.
 */

export type NegativeStyle = 'parentheses' | 'sign';

export interface AmountFormatOptions {
  readonly minorUnit: number;
  readonly locale?: string;
  readonly negative?: NegativeStyle;
  readonly showThousands?: boolean;
}

/**
 * Formats a decimal string for display.
 *
 * Deliberately string-in, string-out. Passing the value through `Number` to reach
 * `Intl.NumberFormat` would reintroduce binary floating point at the last step, and
 * an amount that displays as 1,234.56 while the ledger holds 1,234.555 is a support
 * ticket nobody can reproduce.
 */
export function formatAmount(value: string, options: AmountFormatOptions): string {
  const { minorUnit, negative = 'parentheses', showThousands = true } = options;

  const isNegative = value.trimStart().startsWith('-');
  const unsigned = value.trim().replace(/^[+-]/, '');
  const [rawInt = '0', rawFrac = ''] = unsigned.split('.');

  // Truncate rather than round: the server already applied the ADR-0006 boundary,
  // and rounding again here could move the last digit.
  const fraction = minorUnit > 0 ? rawFrac.slice(0, minorUnit).padEnd(minorUnit, '0') : '';

  const integer = showThousands ? groupThousands(rawInt) : rawInt;
  const body = minorUnit > 0 ? `${integer}.${fraction}` : integer;

  if (!isNegative) return body;
  return negative === 'parentheses' ? `(${body})` : `-${body}`;
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * The text a screen reader should announce for an amount.
 *
 * Parentheses are a sighted convention; a screen reader renders "(1,234.56)" as an
 * unhelpful punctuation soup. The visible form stays conventional and the
 * accessible name says "negative", which is criterion 1.3.1 in practice.
 */
export function amountAccessibleLabel(
  value: string,
  currencyCode: string,
  options: AmountFormatOptions,
): string {
  const isNegative = value.trimStart().startsWith('-');
  const formatted = formatAmount(value, { ...options, negative: 'sign', showThousands: true });
  const magnitude = formatted.replace(/^-/, '');
  return `${isNegative ? 'negative ' : ''}${magnitude} ${currencyCode}`;
}

/** Debit/credit presentation, which is not the same as positive/negative. */
export function formatDebitCredit(
  debit: string,
  credit: string,
  options: AmountFormatOptions,
): { debit: string; credit: string } {
  const blankIfZero = (v: string) => (/^0(\.0*)?$/.test(v.trim()) ? '' : formatAmount(v, options));
  // A zero cell is left blank rather than shown as 0.00. F-001 made zero-value
  // lines legal, and a trial balance in which every cell is populated is unreadable.
  return { debit: blankIfZero(debit), credit: blankIfZero(credit) };
}

/** An accounting date is already `YYYY-MM-DD`; never construct a `Date` to show it. */
export function formatAccountingDate(value: string, locale = 'en-CA'): string {
  if (locale === 'en-CA') return value; // ISO, and unambiguous
  const [y, m, d] = value.split('-');
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  }).format(new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))));
}
