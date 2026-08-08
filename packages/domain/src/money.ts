import { Decimal, D, MONEY_SCALE, RoundingMode } from './decimal';
import { CurrencyMismatchError, assertCurrencyCode } from './currency';

/**
 * A monetary amount in one currency, carried at the full storage precision of
 * `numeric(24,8)`. Rounding is never implicit: it happens only where ADR-0006 §3
 * says it happens, through the functions in `rounding.ts`.
 */
export class Money {
  private constructor(
    readonly amount: Decimal,
    readonly currency: string,
  ) {}

  static of(value: string | number | bigint | Decimal, currency: string): Money {
    const code = currency.toUpperCase();
    assertCurrencyCode(code);
    return new Money(D(value, MONEY_SCALE), code);
  }

  static zero(currency: string): Money {
    return Money.of(Decimal.zero(MONEY_SCALE), currency);
  }

  private sameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  add(other: Money): Money {
    this.sameCurrency(other);
    return new Money(this.amount.add(other.amount).rescale(MONEY_SCALE), this.currency);
  }

  sub(other: Money): Money {
    this.sameCurrency(other);
    return new Money(this.amount.sub(other.amount).rescale(MONEY_SCALE), this.currency);
  }

  /**
   * Scales by a dimensionless factor (quantity, percentage, allocation share).
   * The result keeps full precision — round it at a boundary, not here.
   */
  times(factor: Decimal | string | number): Money {
    const f = D(factor);
    return new Money(this.amount.mul(f).rescale(MONEY_SCALE, 'DOWN'), this.currency);
  }

  negate(): Money {
    return new Money(this.amount.negate(), this.currency);
  }

  abs(): Money {
    return new Money(this.amount.abs(), this.currency);
  }

  compare(other: Money): -1 | 0 | 1 {
    this.sameCurrency(other);
    return this.amount.compare(other.amount);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.amount.equals(other.amount);
  }
  lt(other: Money): boolean {
    return this.compare(other) < 0;
  }
  lte(other: Money): boolean {
    return this.compare(other) <= 0;
  }
  gt(other: Money): boolean {
    return this.compare(other) > 0;
  }
  gte(other: Money): boolean {
    return this.compare(other) >= 0;
  }
  isZero(): boolean {
    return this.amount.isZero();
  }
  isNegative(): boolean {
    return this.amount.isNegative();
  }
  isPositive(): boolean {
    return this.amount.isPositive();
  }

  /** Storage form — exactly what goes into a `numeric(24,8)` column. */
  toStorageString(): string {
    return this.amount.toFixed(MONEY_SCALE);
  }

  /** Wire form — a decimal string, never a JSON number (ADR-0006 consequences). */
  toString(): string {
    return this.amount.toString();
  }

  toJSON(): string {
    return this.toString();
  }

  static sum(values: readonly Money[], currency: string): Money {
    return values.reduce<Money>((acc, v) => acc.add(v), Money.zero(currency));
  }
}

/**
 * A `Money` that has passed a rounding boundary from ADR-0006 §3.
 *
 * The brand exists to make step 3 and step 4 of the chain structurally impossible
 * to get wrong: `sumRounded` accepts only `RoundedMoney`, and it does not round its
 * result. The ADR calls out re-rounding a sum of rounded parts as "the ones most
 * often got wrong"; here the compiler is the one enforcing it, not a code review.
 */
declare const roundedAtBoundary: unique symbol;
export type RoundedMoney = Money & { readonly [roundedAtBoundary]: true };

/** Internal — only `rounding.ts` may mint the brand. */
export function brandRounded(m: Money): RoundedMoney {
  return m as RoundedMoney;
}

export interface MoneyRoundingOptions {
  readonly mode?: RoundingMode;
}
