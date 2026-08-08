/**
 * Fixed-point decimal arithmetic on `bigint`.
 *
 * ADR-0006 §1: "No binary floating point anywhere, for any monetary or rate value."
 * That rules out `number` for anything that reaches the ledger, so every money and
 * rate value in this codebase is an integer count of units at a declared scale —
 * exactly how PostgreSQL stores `numeric(24,8)`.
 *
 * Written rather than taken from a library because the rounding modes here are
 * normative: they are the thing every Gate C golden fixture asserts against, and
 * a dependency upgrade silently changing a half-way case is a defect class we
 * cannot detect from the outside.
 */

export type RoundingMode =
  | 'HALF_UP' // half away from zero — ADR-0006 §4 default
  | 'HALF_DOWN'
  | 'HALF_EVEN' // banker's rounding; some tax jurisdictions mandate it
  | 'UP' // away from zero
  | 'DOWN' // toward zero (truncation)
  | 'CEILING'
  | 'FLOOR';

export const DEFAULT_ROUNDING: RoundingMode = 'HALF_UP';

/** Money storage scale — matches `numeric(24,8)` throughout contracts/schema. */
export const MONEY_SCALE = 8;
/** Exchange rate scale — matches `numeric(28,12)`. */
export const RATE_SCALE = 12;
/** Tax rate scale — matches `numeric(18,10)`. */
export const TAX_RATE_SCALE = 10;
/** Percentage scale — matches `numeric(9,6)`. */
export const PERCENT_SCALE = 6;

export class DecimalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecimalError';
  }
}

const pow10Cache = new Map<number, bigint>();
function pow10(n: number): bigint {
  if (n < 0) throw new DecimalError(`negative scale: ${n}`);
  let v = pow10Cache.get(n);
  if (v === undefined) {
    v = 10n ** BigInt(n);
    pow10Cache.set(n, v);
  }
  return v;
}

const abs = (v: bigint) => (v < 0n ? -v : v);

/**
 * Divides and rounds in one step. Every rounding decision in the platform passes
 * through here, so the modes are defined in exactly one place.
 */
export function roundedDiv(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new DecimalError('division by zero');

  const negative = numerator < 0n !== denominator < 0n;
  const n = abs(numerator);
  const d = abs(denominator);
  const q = n / d;
  const r = n % d;
  if (r === 0n) return negative ? -q : q;

  const twice = r * 2n;
  let increment: boolean;
  switch (mode) {
    case 'HALF_UP':
      increment = twice >= d;
      break;
    case 'HALF_DOWN':
      increment = twice > d;
      break;
    case 'HALF_EVEN':
      increment = twice > d || (twice === d && q % 2n === 1n);
      break;
    case 'UP':
      increment = true;
      break;
    case 'DOWN':
      increment = false;
      break;
    case 'CEILING':
      increment = !negative;
      break;
    case 'FLOOR':
      increment = negative;
      break;
  }
  const result = increment ? q + 1n : q;
  return negative ? -result : result;
}

const DECIMAL_PATTERN = /^[+-]?(\d+)(\.(\d*))?$/;

export class Decimal {
  private constructor(
    readonly units: bigint,
    readonly scale: number,
  ) {}

  static fromUnits(units: bigint, scale: number): Decimal {
    if (!Number.isInteger(scale) || scale < 0 || scale > 38) {
      throw new DecimalError(`scale out of range: ${scale}`);
    }
    return new Decimal(units, scale);
  }

  /**
   * Parses a decimal string. Rejects exponent notation and anything else that is
   * not an exact decimal literal — an API that accepts `1e-7` for a money field
   * has already lost the argument about precision.
   */
  static parse(value: string, scale?: number): Decimal {
    const raw = value.trim();
    const m = DECIMAL_PATTERN.exec(raw);
    if (!m) throw new DecimalError(`not a decimal literal: ${JSON.stringify(value)}`);

    const negative = raw.startsWith('-');
    const intPart = m[1] ?? '0';
    const fracPart = m[3] ?? '';
    const naturalScale = fracPart.length;
    const units = BigInt(intPart + fracPart);
    const signed = negative ? -units : units;
    const self = new Decimal(signed, naturalScale);
    return scale === undefined ? self : self.rescale(scale);
  }

  static from(value: string | number | bigint | Decimal, scale?: number): Decimal {
    if (value instanceof Decimal) return scale === undefined ? value : value.rescale(scale);
    if (typeof value === 'bigint') return new Decimal(value, 0).rescale(scale ?? 0);
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) {
        // Accepting a float here is how binary rounding error enters an accounting
        // system. Callers with a fractional value have a string; they should pass it.
        throw new DecimalError(
          `refusing to build a Decimal from the non-integer number ${value} (ADR-0006 §1); pass a string`,
        );
      }
      return new Decimal(BigInt(value), 0).rescale(scale ?? 0);
    }
    return Decimal.parse(value, scale);
  }

  static zero(scale = 0): Decimal {
    return new Decimal(0n, scale);
  }

  /** Widening is exact; narrowing rounds with the given mode. */
  rescale(scale: number, mode: RoundingMode = DEFAULT_ROUNDING): Decimal {
    if (scale === this.scale) return this;
    if (!Number.isInteger(scale) || scale < 0 || scale > 38) {
      throw new DecimalError(`scale out of range: ${scale}`);
    }
    if (scale > this.scale) {
      return new Decimal(this.units * pow10(scale - this.scale), scale);
    }
    return new Decimal(roundedDiv(this.units, pow10(this.scale - scale), mode), scale);
  }

  private static align(a: Decimal, b: Decimal): [bigint, bigint, number] {
    const scale = Math.max(a.scale, b.scale);
    return [a.rescale(scale).units, b.rescale(scale).units, scale];
  }

  add(other: Decimal): Decimal {
    const [x, y, s] = Decimal.align(this, other);
    return new Decimal(x + y, s);
  }

  sub(other: Decimal): Decimal {
    const [x, y, s] = Decimal.align(this, other);
    return new Decimal(x - y, s);
  }

  /** Exact: the result scale is the sum of the operand scales. Round explicitly after. */
  mul(other: Decimal): Decimal {
    return new Decimal(this.units * other.units, this.scale + other.scale);
  }

  /** Division must be told its result scale — there is no exact answer to ask for. */
  div(other: Decimal, scale: number, mode: RoundingMode = DEFAULT_ROUNDING): Decimal {
    if (other.units === 0n) throw new DecimalError('division by zero');
    const numerator = this.units * pow10(scale + other.scale);
    const denominator = other.units * pow10(this.scale);
    return new Decimal(roundedDiv(numerator, denominator, mode), scale);
  }

  negate(): Decimal {
    return new Decimal(-this.units, this.scale);
  }

  abs(): Decimal {
    return this.units < 0n ? this.negate() : this;
  }

  compare(other: Decimal): -1 | 0 | 1 {
    const [x, y] = Decimal.align(this, other);
    return x < y ? -1 : x > y ? 1 : 0;
  }

  equals(other: Decimal): boolean {
    return this.compare(other) === 0;
  }
  lt(other: Decimal): boolean {
    return this.compare(other) < 0;
  }
  lte(other: Decimal): boolean {
    return this.compare(other) <= 0;
  }
  gt(other: Decimal): boolean {
    return this.compare(other) > 0;
  }
  gte(other: Decimal): boolean {
    return this.compare(other) >= 0;
  }
  isZero(): boolean {
    return this.units === 0n;
  }
  isNegative(): boolean {
    return this.units < 0n;
  }
  isPositive(): boolean {
    return this.units > 0n;
  }

  /** Canonical decimal string at the current scale — the wire format for money. */
  toString(): string {
    const negative = this.units < 0n;
    const digits = abs(this.units)
      .toString()
      .padStart(this.scale + 1, '0');
    const cut = digits.length - this.scale;
    const intPart = digits.slice(0, cut);
    const fracPart = this.scale > 0 ? `.${digits.slice(cut)}` : '';
    return `${negative ? '-' : ''}${intPart}${fracPart}`;
  }

  toFixed(dp: number, mode: RoundingMode = DEFAULT_ROUNDING): string {
    return this.rescale(dp, mode).toString();
  }

  toJSON(): string {
    return this.toString();
  }

  /**
   * Escape hatch for presentation and metrics only. Never use the result in a
   * calculation that reaches the ledger.
   */
  unsafeToNumber(): number {
    return Number(this.toString());
  }
}

export const D = (value: string | number | bigint | Decimal, scale?: number): Decimal =>
  Decimal.from(value, scale);

/** Sums exactly, with no intermediate rounding. */
export function sumExact(values: readonly Decimal[], scale = MONEY_SCALE): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.add(v), Decimal.zero(scale));
}
