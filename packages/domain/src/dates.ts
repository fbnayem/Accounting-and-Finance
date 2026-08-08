/**
 * Accounting dates.
 *
 * `posting_date`, `document_date`, `valid_from`/`valid_to` and every period
 * boundary are PostgreSQL `date` columns — calendar days, no time, no zone.
 * Passing a JavaScript `Date` around for these is how a posting lands in the
 * wrong period: `new Date('2026-01-01')` is midnight UTC, which is 2025-12-31
 * in every timezone west of Greenwich, and doc 01 makes `posting_date` the thing
 * that selects the accounting period.
 *
 * So an accounting date is a branded `YYYY-MM-DD` string and never a `Date`.
 */

declare const accountingDateBrand: unique symbol;
export type AccountingDate = string & { readonly [accountingDateBrand]: true };

export class DateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DateError';
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function accountingDate(value: string): AccountingDate {
  const m = ISO_DATE.exec(value);
  if (!m) throw new DateError(`not a YYYY-MM-DD calendar date: ${JSON.stringify(value)}`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    throw new DateError(`not a real calendar date: ${value}`);
  }
  return value as AccountingDate;
}

export function isAccountingDate(value: string): boolean {
  try {
    accountingDate(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Today" for an entity, in the entity's timezone.
 *
 * A user in Auckland posting at 09:00 local is on the next calendar day from a
 * server in UTC. The entity's timezone decides, not the server's.
 */
export function todayIn(timeZone: string, now: Date = new Date()): AccountingDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return accountingDate(parts);
}

function toUtc(d: AccountingDate): Date {
  const m = ISO_DATE.exec(d) as RegExpExecArray;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function fromUtc(d: Date): AccountingDate {
  return accountingDate(d.toISOString().slice(0, 10));
}

export function compareDates(a: AccountingDate, b: AccountingDate): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function addDays(d: AccountingDate, days: number): AccountingDate {
  const u = toUtc(d);
  u.setUTCDate(u.getUTCDate() + days);
  return fromUtc(u);
}

/** Clamps to the last day of the target month: 31 Jan + 1 month is 28/29 Feb. */
export function addMonths(d: AccountingDate, months: number): AccountingDate {
  const u = toUtc(d);
  const day = u.getUTCDate();
  u.setUTCDate(1);
  u.setUTCMonth(u.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(u.getUTCFullYear(), u.getUTCMonth() + 1, 0)).getUTCDate();
  u.setUTCDate(Math.min(day, lastDay));
  return fromUtc(u);
}

export function endOfMonth(d: AccountingDate): AccountingDate {
  const u = toUtc(d);
  return fromUtc(new Date(Date.UTC(u.getUTCFullYear(), u.getUTCMonth() + 1, 0)));
}

export function startOfMonth(d: AccountingDate): AccountingDate {
  const u = toUtc(d);
  return fromUtc(new Date(Date.UTC(u.getUTCFullYear(), u.getUTCMonth(), 1)));
}

export function daysBetween(from: AccountingDate, to: AccountingDate): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000);
}

/**
 * Half-open interval `[from, to)` — the same convention as the `daterange(from, to, '[)')`
 * exclusion constraints on fiscal years, periods, rates and rule versions. Keeping
 * one convention on both sides means a boundary that PostgreSQL accepts is a
 * boundary the application accepts.
 */
export interface DateRange {
  readonly from: AccountingDate;
  /** Exclusive. `null` means open-ended, matching a NULL `valid_to`. */
  readonly to: AccountingDate | null;
}

export function rangeContains(range: DateRange, d: AccountingDate): boolean {
  if (compareDates(d, range.from) < 0) return false;
  return range.to === null || compareDates(d, range.to) < 0;
}

export function rangesOverlap(a: DateRange, b: DateRange): boolean {
  const aEndsBefore = a.to !== null && compareDates(a.to, b.from) <= 0;
  const bEndsBefore = b.to !== null && compareDates(b.to, a.from) <= 0;
  return !aEndsBefore && !bEndsBefore;
}

/** For an inclusive `valid_to` presented to a user, over a half-open stored range. */
export function inclusiveEnd(range: DateRange): AccountingDate | null {
  return range.to === null ? null : addDays(range.to, -1);
}
