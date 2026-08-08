import { Decimal, D } from './decimal';

/**
 * ADR-0006 §2: the `currencies` table is reference data and `minor_unit` drives
 * every rounding boundary. This is the in-process shape of one of those rows.
 *
 * `minorUnit` is not always 2. Getting JPY (0) or KWD (3) wrong is not a display
 * bug — it changes the posted amount.
 */
export interface CurrencyPrecision {
  readonly code: string;
  readonly minorUnit: number;
  /**
   * Physical cash rounds to a coarser increment than the minor unit in some
   * currencies (CHF 0.05, SEK 1.00). Applies to cash settlement only; the
   * receivable itself is never cash-rounded.
   */
  readonly cashRoundingIncrement?: Decimal;
}

export class UnknownCurrencyError extends Error {
  constructor(readonly code: string) {
    super(`Unknown currency: ${code}. Currencies are reference data (ADR-0006 §2).`);
    this.name = 'UnknownCurrencyError';
  }
}

export class CurrencyMismatchError extends Error {
  constructor(
    readonly left: string,
    readonly right: string,
  ) {
    super(`Currency mismatch: ${left} and ${right} cannot be combined without a conversion.`);
    this.name = 'CurrencyMismatchError';
  }
}

/**
 * Bootstrap set for Phase 0 seeding and tests. The authoritative list lives in the
 * `currencies` table; this exists so a unit test does not need a database, and so
 * the seed has something to insert.
 *
 * Chosen to cover every rounding shape the golden fixtures need: 2 decimals, 0
 * decimals, 3 decimals, and cash rounding.
 */
export const BOOTSTRAP_CURRENCIES: readonly CurrencyPrecision[] = [
  { code: 'USD', minorUnit: 2 },
  { code: 'EUR', minorUnit: 2 },
  { code: 'GBP', minorUnit: 2 },
  { code: 'JPY', minorUnit: 0 }, // no minor unit at all
  { code: 'KWD', minorUnit: 3 }, // three
  { code: 'BHD', minorUnit: 3 },
  { code: 'CHF', minorUnit: 2, cashRoundingIncrement: D('0.05', 2) }, // cash rounding
  { code: 'SEK', minorUnit: 2, cashRoundingIncrement: D('1.00', 2) },
  { code: 'AUD', minorUnit: 2 },
  { code: 'CAD', minorUnit: 2 },
  { code: 'INR', minorUnit: 2 },
  { code: 'SGD', minorUnit: 2 },
  { code: 'AED', minorUnit: 2 },
  { code: 'BDT', minorUnit: 2 },
];

const REGISTRY = new Map(BOOTSTRAP_CURRENCIES.map((c) => [c.code, c]));

export function currencyPrecision(code: string): CurrencyPrecision {
  const found = REGISTRY.get(code.toUpperCase());
  if (!found) throw new UnknownCurrencyError(code);
  return found;
}

export function isKnownCurrency(code: string): boolean {
  return REGISTRY.has(code.toUpperCase());
}

/** ISO 4217 shape check only — membership is a database concern. */
export function assertCurrencyCode(code: string): void {
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new UnknownCurrencyError(code);
  }
}
