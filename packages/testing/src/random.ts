/**
 * Deterministic pseudo-randomness.
 *
 * ADR-0009 §1: "Fixed random seed, so a baseline from one run is comparable with
 * the next — which F-303 noted was impossible without a defined dataset."
 *
 * `Math.random()` is therefore not used anywhere in the seeder. A benchmark whose
 * dataset changes between runs cannot detect a regression; it can only detect that
 * something is different.
 */

export class DeterministicRandom {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    // Any non-zero start; mixed so that adjacent seeds do not produce
    // correlated streams.
    this.state = (seed ^ 0x6d2b79f5) >>> 0;
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  /** mulberry32 — small, fast, and good enough for shaped test data. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('cannot pick from an empty list');
    return items[this.int(0, items.length - 1)] as T;
  }

  bool(probabilityTrue = 0.5): boolean {
    return this.next() < probabilityTrue;
  }

  /**
   * A money amount as an exact decimal string with two places.
   *
   * Built from integer minor units rather than by rounding a float — ADR-0006 §1
   * applies to test data too, or the fixtures encode float error as expected
   * behaviour.
   */
  amount(minMajor: number, maxMajor: number): string {
    const units = this.int(minMajor * 100, maxMajor * 100);
    return `${Math.floor(units / 100)}.${String(units % 100).padStart(2, '0')}`;
  }

  /** UUID v7 with a caller-supplied clock, so identifiers are reproducible too. */
  uuidv7(atMillis: number): string {
    const hex: string[] = [];
    for (let i = 0; i < 16; i++) hex.push(this.int(0, 255).toString(16).padStart(2, '0'));

    const ts = BigInt(atMillis);
    for (let i = 0; i < 6; i++) {
      hex[i] = Number((ts >> BigInt(40 - i * 8)) & 0xffn)
        .toString(16)
        .padStart(2, '0');
    }
    hex[6] = ((parseInt(hex[6] as string, 16) & 0x0f) | 0x70).toString(16).padStart(2, '0');
    hex[8] = ((parseInt(hex[8] as string, 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');

    const s = hex.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
}
