'use client';

import type { ReactNode } from 'react';
import { formatAmount } from '@acct/ui';
import { api } from '../lib/api';
import { useResource } from './ui';

/**
 * The pieces the Phase 5 screens share.
 *
 * The important one is money. `packages/ui`'s `formatAmount` is string-in,
 * string-out for exactly the reason ADR-0006 §1 gives — "passing the value
 * through `Number` to reach `Intl.NumberFormat` would reintroduce binary
 * floating point at the last step" — and it is what these screens format with.
 * A cost layer's unit cost is stored at eight decimals; rounding it to two
 * through a float to display it is how a valuation total that reconciles in the
 * database stops reconciling on the screen.
 *
 * Negative amounts are parenthesised, never coloured alone (ADR-0010 §3), and
 * `Money` adds a visually-hidden "negative" because a screen reader renders
 * "(40.00)" as punctuation rather than as a sign.
 */

/** An amount at its currency's minor unit — 1,234.56, or (1,234.56) if negative. */
export function money(value: string | null | undefined, minorUnit = 2): string {
  if (value == null || value === '') return '—';
  return formatAmount(value, { minorUnit });
}

/**
 * An amount at whatever precision the server actually stored.
 *
 * `formatAmount` truncates to the minor unit, which is right for a total and
 * wrong for a unit cost: a FIFO layer received at 3.33333333 shown as 3.33 is a
 * number nobody can multiply back into the total it produced, and exit
 * criterion 3 is precisely that COGS be reproducible from these figures.
 */
export function precise(value: string | null | undefined): string {
  if (value == null || value === '') return '—';
  return formatAmount(value, { minorUnit: Math.max(2, significantDecimals(value)) });
}

/**
 * A quantity. Signed rather than parenthesised — on a movement the sign is the
 * direction (out of a location, into one), not a loss.
 */
export function quantity(value: string | null | undefined): string {
  if (value == null || value === '') return '—';
  return formatAmount(value, { minorUnit: significantDecimals(value), negative: 'sign' });
}

function significantDecimals(value: string): number {
  const [, fraction = ''] = value.trim().replace(/^[+-]/, '').split('.');
  return fraction.replace(/0+$/, '').length;
}

/**
 * Exactly zero, decided on the digits.
 *
 * Whether a reconciliation agrees is the whole question on the valuation
 * screen, and `Number(difference) === 0` would answer it by float. '0',
 * '-0.00000000' and '+0.0' are all zero; '0.00000001' is not.
 */
export function isZeroDecimal(value: string | null | undefined): boolean {
  if (value == null || value === '') return false;
  return /^[+-]?0*(?:\.0*)?$/.test(value.trim());
}

export function isNegativeDecimal(value: string | null | undefined): boolean {
  return value != null && value.trimStart().startsWith('-') && !isZeroDecimal(value);
}

/** A date column: the server sends `YYYY-MM-DD`, or a timestamp that starts with one. */
export function day(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : '—';
}

/** A word for a decimal's sign, so nothing depends on colour (WCAG 1.4.1). */
export function agreementWord(difference: string | null | undefined): string {
  if (difference == null) return 'not computed';
  if (isZeroDecimal(difference)) return 'agrees';
  return isNegativeDecimal(difference) ? 'short' : 'over';
}

/**
 * An amount, formatted and announced.
 *
 * The parentheses are the sighted convention; the visually-hidden word is what
 * makes the sign survive a screen reader (ADR-0010 §3, WCAG 1.3.1).
 */
export function Money({
  value,
  minorUnit = 2,
}: {
  value: string | null | undefined;
  minorUnit?: number;
}) {
  if (value == null || value === '') return <>—</>;
  return (
    <>
      {isNegativeDecimal(value) ? <span className="visually-hidden">negative </span> : null}
      {money(value, minorUnit)}
    </>
  );
}

export interface SummaryItem {
  readonly term: string;
  readonly value: ReactNode;
  /** Where the number comes from, when that is the point of showing it. */
  readonly hint?: string;
}

/** The `dl.summary-list` block the Phase 4 screens use, with room for a source note. */
export function SummaryList({ items }: { items: readonly SummaryItem[] }) {
  return (
    <dl className="summary-list">
      {items.map((item) => (
        <div key={item.term}>
          <dt>{item.term}</dt>
          <dd>{item.value}</dd>
          {item.hint ? <dd className="field-hint">{item.hint}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/**
 * Minor units per currency — ADR-0006's consequence that "the presentation
 * layer formats using `currencies.minor_unit`".
 *
 * Fails soft to 2: a caller without `currency.view` must still be able to read
 * an inventory valuation, and a missing lookup is a formatting question, not an
 * error banner. JPY is the case that makes this worth a request — 1,000 yen
 * displayed as 1,000.00 is a number that does not exist.
 */
export function useMinorUnits(): (currency: string | null | undefined) => number {
  const currencies = useResource(() =>
    api<{ data: { code: string; minor_unit: number }[] }>('/currencies').catch(() => ({
      data: [] as { code: string; minor_unit: number }[],
    })),
  );
  const byCode = new Map((currencies.data?.data ?? []).map((c) => [c.code, c.minor_unit]));
  return (currency) => (currency ? (byCode.get(currency) ?? 2) : 2);
}

/** Options for a `Field` select, from a fixed list of enum values. */
export function enumOptions(values: readonly string[]): { value: string; label: string }[] {
  return values.map((value) => ({ value, label: value.replace(/_/g, ' ').toLowerCase() }));
}

/** Today, as `YYYY-MM-DD`, without constructing a formatted date string. */
export function today(): string {
  const d = new Date();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${dayOfMonth}`;
}
