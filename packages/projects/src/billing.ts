import { AppError, D, MONEY_SCALE, sumExact, type Decimal } from '@acct/domain';

/**
 * The arithmetic of a billing proposal, computed pure.
 *
 * doc 10: "Billing proposal gathers approved billable facts ... then creates a
 * normal AR invoice draft." Which rows count as billable facts is a SQL
 * question; what they are worth is a decimal question, and it lives here so the
 * proposal's `proposed_amount` and the invoice draft's lines cannot be computed
 * two different ways by the same method.
 */

export interface BillableTimeRow {
  readonly id: string;
  /** numeric(12,4) from pg — a string, never a JS number (ADR-0006). */
  readonly hours: string;
  readonly billing_rate: string | null;
  readonly currency: string | null;
  readonly entry_date: string;
}

export interface BillingLine {
  /** Normalised to MONEY_SCALE so '100' and '100.00' are one line, not two. */
  readonly billingRate: string;
  readonly hours: string;
  readonly amount: string;
  /** Every entry this line prices, so each can be linked to its invoice line. */
  readonly entryIds: readonly string[];
}

export interface GatheredBilling {
  readonly currency: string;
  readonly totalAmount: string;
  readonly lines: readonly BillingLine[];
}

/**
 * Groups approved billable time by rate and prices it exactly.
 *
 * Refusals rather than guesses, in both directions:
 *
 * - An entry without a billing rate cannot be priced, and silently skipping it
 *   would understate the proposal by exactly the amount nobody is looking at.
 *   The refusal names the entries so the fix is a rate, not a search.
 * - Mixed currencies cannot share one AR invoice, and converting here would
 *   invent an FX decision the project never made.
 */
export function gatherBillableTime(
  rows: readonly BillableTimeRow[],
  fallbackCurrency: string | null,
): GatheredBilling {
  if (rows.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      'There is no approved, billable, unbilled time to gather (doc 10: a billing proposal ' +
        'gathers approved billable facts).',
    );
  }

  const unpriced = rows.filter((r) => r.billing_rate === null);
  if (unpriced.length > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `${unpriced.length} approved time ${unpriced.length === 1 ? 'entry has' : 'entries have'} ` +
        'no billing rate and cannot be priced. Set a rate or mark them non-billable.',
      { details: { time_entry_ids: unpriced.map((r) => r.id) } },
    );
  }

  const currencies = new Set(rows.map((r) => r.currency ?? fallbackCurrency));
  if (currencies.has(null)) {
    throw new AppError(
      'VALIDATION_FAILED',
      'Some time entries carry no currency and the project has none to inherit; a priced ' +
        'amount without a currency is not money.',
      {
        details: {
          time_entry_ids: rows.filter((r) => !(r.currency ?? fallbackCurrency)).map((r) => r.id),
        },
      },
    );
  }
  if (currencies.size > 1) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Time entries span ${currencies.size} currencies (${[...currencies].join(', ')}); one AR ` +
        'invoice carries one currency, and converting here would invent an FX decision. Propose ' +
        'per currency using the period filter.',
      { details: { currencies: [...currencies] } },
    );
  }
  const currency = [...currencies][0] as string;

  const byRate = new Map<string, { hours: Decimal[]; entryIds: string[] }>();
  for (const row of rows) {
    const rate = D(row.billing_rate as string).toFixed(MONEY_SCALE);
    const bucket = byRate.get(rate) ?? { hours: [], entryIds: [] };
    bucket.hours.push(D(row.hours));
    bucket.entryIds.push(row.id);
    byRate.set(rate, bucket);
  }

  const lines: BillingLine[] = [...byRate.entries()].map(([rate, bucket]) => {
    const hours = sumExact(bucket.hours);
    return {
      billingRate: rate,
      hours: hours.toFixed(MONEY_SCALE),
      amount: hours.mul(D(rate)).rescale(MONEY_SCALE).toFixed(MONEY_SCALE),
      entryIds: bucket.entryIds,
    };
  });

  return {
    currency,
    totalAmount: sumExact(lines.map((l) => D(l.amount))).toFixed(MONEY_SCALE),
    lines,
  };
}
