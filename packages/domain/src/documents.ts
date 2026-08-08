import { Decimal, D, type RoundingMode } from './decimal';
import { Money, brandRounded, type RoundedMoney } from './money';
import {
  roundLineNet,
  roundTaxComponent,
  sumRounded,
  deriveInclusive,
  allocateProportionally,
  RoundingError,
} from './rounding';
import { ProblemList } from './posting';

/**
 * Document calculation — the server-side arithmetic behind every invoice, bill,
 * credit note and quote.
 *
 * doc 04 states the rule this file exists to enforce: "Server calculates
 * subtotal, line discount, document discount where allowed, shipping/fees,
 * taxable base, tax components, rounding and total. UI may preview but server
 * result is authoritative."
 *
 * Two things follow from "authoritative" that are easy to skip. The first is that
 * the client's numbers are never trusted, only its inputs — quantity, price,
 * discount and tax code. The second is that the result must be reproducible: doc
 * 04 requires a per-line calculation snapshot and doc 07 requires the tax
 * snapshot to survive a rule upgrade unchanged, so every line carries the rate
 * and rule version it was computed with rather than a pointer to today's.
 *
 * The rounding order is ADR-0006 §3, which is normative and not negotiable per
 * document type. Steps 3 and 4 in particular — never re-round a sum of rounded
 * parts — are what stop an invoice disagreeing with its own lines by a penny.
 */

export type TaxTreatment =
  'STANDARD' | 'ZERO_RATED' | 'EXEMPT' | 'OUTSIDE_SCOPE' | 'REVERSE_CHARGE';

export interface TaxComponentInput {
  readonly id: string;
  readonly code: string;
  readonly sequence: number;
  /** Decimal string. 0.20 is twenty percent. */
  readonly rate: string;
  /** doc 07: compound tax applies to the base plus the components before it. */
  readonly compoundOnPrevious: boolean;
  /** doc 07: 0–1. Input tax below 1 capitalises the remainder into the cost. */
  readonly recoverablePercent: string;
  /** ADR-0006 §4: some jurisdictions mandate a different mode for tax alone. */
  readonly roundingMode?: RoundingMode | undefined;
}

export interface TaxCodeInput {
  readonly id: string;
  readonly code: string;
  readonly treatment: TaxTreatment;
  /** doc 07: whether the stated unit price already contains the tax. */
  readonly inclusive: boolean;
  readonly components: readonly TaxComponentInput[];
}

export interface DocumentLineInput {
  readonly lineNo: number;
  readonly description: string;
  /** Decimal strings throughout. ADR-0006: money is never a JSON number. */
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discountAmount?: string | undefined;
  readonly taxCode?: TaxCodeInput | undefined;
}

export interface CalculatedTaxComponent {
  readonly componentId: string;
  readonly code: string;
  readonly rate: string;
  readonly taxableAmount: string;
  readonly taxAmount: string;
  readonly recoverableAmount: string;
  readonly nonrecoverableAmount: string;
}

export interface CalculatedLine {
  readonly lineNo: number;
  readonly quantity: string;
  readonly unitPrice: string;
  readonly discountAmount: string;
  readonly netAmount: string;
  readonly taxAmount: string;
  readonly grossAmount: string;
  readonly taxCodeId: string | null;
  readonly components: readonly CalculatedTaxComponent[];
  /** doc 04: "Store line-level calculation snapshots." */
  readonly snapshot: Record<string, unknown>;
}

export interface CalculatedDocument {
  readonly currency: string;
  readonly lines: readonly CalculatedLine[];
  readonly subtotal: string;
  readonly discountTotal: string;
  readonly taxTotal: string;
  readonly roundingAdjustment: string;
  readonly total: string;
  readonly taxByComponent: readonly CalculatedTaxComponent[];
}

export interface CalculateOptions {
  readonly currency: string;
  /** ADR-0006 §4 default; a component may still override it. */
  readonly roundingMode?: RoundingMode | undefined;
  /**
   * doc 04: "document discount where allowed". Applied across lines in
   * proportion to their net, so the parts sum exactly to the whole and no line
   * absorbs the remainder twice.
   */
  readonly documentDiscount?: string | undefined;
}

const ZERO_TAX_TREATMENTS: readonly TaxTreatment[] = [
  'ZERO_RATED',
  'EXEMPT',
  'OUTSIDE_SCOPE',
  // doc 07: reverse charge shifts the liability to the buyer, so the document
  // itself carries no tax. The tax subledger still records both sides — that is
  // the posting rule's job, not this function's.
  'REVERSE_CHARGE',
];

/**
 * The tax a component contributes, given the base and what came before it.
 *
 * Compounding is why this is sequential rather than a sum of independent rates:
 * a compound component is charged on the base plus the tax already added, which
 * is a different number from the same rate on the base alone.
 */
function componentTaxes(
  base: RoundedMoney,
  components: readonly TaxComponentInput[],
  currency: string,
  defaultMode: RoundingMode | undefined,
): Array<{ component: TaxComponentInput; taxable: RoundedMoney; tax: RoundedMoney }> {
  const ordered = [...components].sort((a, b) => a.sequence - b.sequence);
  const out: Array<{ component: TaxComponentInput; taxable: RoundedMoney; tax: RoundedMoney }> = [];
  let compoundedBase = base;

  for (const component of ordered) {
    const taxable = component.compoundOnPrevious ? compoundedBase : base;
    const raw = Money.of(taxable.amount.mul(D(component.rate)), currency);
    const tax = roundTaxComponent(raw, currency, component.roundingMode ?? defaultMode);
    out.push({ component, taxable, tax });
    compoundedBase = brandRounded(compoundedBase.add(tax));
  }
  return out;
}

/** The multiplier a set of components applies to a base of 1, compounding included. */
function effectiveRate(components: readonly TaxComponentInput[]): Decimal {
  const ordered = [...components].sort((a, b) => a.sequence - b.sequence);
  let total = D('0');
  let compounded = D('1');
  for (const component of ordered) {
    const taxable = component.compoundOnPrevious ? compounded : D('1');
    const tax = taxable.mul(D(component.rate));
    total = total.add(tax);
    compounded = compounded.add(tax);
  }
  return total;
}

function snapshotOf(
  line: DocumentLineInput,
  components: readonly CalculatedTaxComponent[],
  inclusive: boolean,
  mode: RoundingMode | undefined,
): Record<string, unknown> {
  return {
    // Everything needed to recompute the line without consulting anything that
    // can change. doc 07's acceptance criterion is that a posted transaction
    // keeps its tax snapshot after a rule upgrade, and a snapshot that stores
    // ids instead of values does not survive one.
    quantity: line.quantity,
    unit_price: line.unitPrice,
    discount_amount: line.discountAmount ?? '0',
    tax_code: line.taxCode ? { id: line.taxCode.id, code: line.taxCode.code } : null,
    treatment: line.taxCode?.treatment ?? null,
    inclusive,
    rounding_mode: mode ?? 'HALF_UP',
    components: components.map((c) => ({
      code: c.code,
      rate: c.rate,
      taxable_amount: c.taxableAmount,
      tax_amount: c.taxAmount,
      recoverable_amount: c.recoverableAmount,
    })),
    calculated_by: 'server',
  };
}

/**
 * Calculates a document from its inputs.
 *
 * Throws `ProblemList` rather than returning a partial result: a document whose
 * arithmetic is wrong must not reach the ledger, and a caller that has to check
 * a status field is a caller that will forget to.
 */
export function calculateDocument(
  lines: readonly DocumentLineInput[],
  options: CalculateOptions,
): CalculatedDocument {
  const currency = options.currency;
  const mode = options.roundingMode;
  const problems = new ProblemList();

  if (lines.length === 0) {
    problems.add('lines', 'EMPTY_DOCUMENT', 'A document needs at least one line.');
  }

  const seen = new Set<number>();
  for (const line of lines) {
    if (seen.has(line.lineNo)) {
      problems.add(
        `lines.${line.lineNo}`,
        'DUPLICATE_LINE_NO',
        `Line number ${line.lineNo} appears more than once.`,
      );
    }
    seen.add(line.lineNo);
    if (D(line.quantity).isNegative()) {
      problems.add(
        `lines.${line.lineNo}.quantity`,
        'NEGATIVE_QUANTITY',
        `Line ${line.lineNo}: quantity cannot be negative. Return a credit note instead.`,
      );
    }
    const discount = D(line.discountAmount ?? '0');
    if (discount.isNegative()) {
      problems.add(
        `lines.${line.lineNo}.discount_amount`,
        'NEGATIVE_DISCOUNT',
        `Line ${line.lineNo}: a discount cannot be negative — that is a surcharge, and it belongs on its own line.`,
      );
    }
    const gross = D(line.quantity).mul(D(line.unitPrice));
    if (discount.gt(gross.abs())) {
      problems.add(
        `lines.${line.lineNo}.discount_amount`,
        'DISCOUNT_EXCEEDS_LINE',
        `Line ${line.lineNo}: a discount of ${discount.toString()} exceeds the line amount of ${gross.toString()}.`,
      );
    }
  }
  problems.throwIfAny('This document cannot be calculated.');

  // ------------------------------------------------------------------ lines --
  const calculated: CalculatedLine[] = [];
  for (const line of lines) {
    const listAmount = Money.of(D(line.quantity).mul(D(line.unitPrice)), currency);
    const discount = roundLineNet(
      Money.of(D(line.discountAmount ?? '0'), currency),
      currency,
      mode,
    );
    const afterDiscount = roundLineNet(listAmount, currency, mode).sub(discount);

    const taxCode = line.taxCode;
    const taxable =
      taxCode && !ZERO_TAX_TREATMENTS.includes(taxCode.treatment) ? taxCode.components : [];

    let net: RoundedMoney;
    let componentResults: Array<{
      component: TaxComponentInput;
      taxable: RoundedMoney;
      tax: RoundedMoney;
    }>;

    if (taxable.length === 0) {
      net = brandRounded(afterDiscount);
      componentResults = [];
    } else if (taxCode?.inclusive) {
      // ADR-0006 §6. The stated price already contains the tax, so the net is
      // derived from the gross and the tax is the remainder — never rounded
      // independently, or the components stop summing to the price quoted.
      const { net: derivedNet, tax } = deriveInclusive(
        afterDiscount,
        effectiveRate(taxable),
        currency,
        mode,
      );
      net = derivedNet;
      // The total is known; the split across components is proportional to what
      // each would have charged on the derived net. allocateProportionally hands
      // out the remainder a minor unit at a time, so the parts sum exactly.
      const nominal = componentTaxes(derivedNet, taxable, currency, mode);
      const weights = nominal.map((n) => n.tax.amount);
      const anyNonZero = weights.some((w) => !w.isZero());
      const shares = anyNonZero
        ? allocateProportionally(tax, weights, currency)
        : nominal.map(() => brandRounded(Money.zero(currency)));
      componentResults = nominal.map((n, i) => ({
        component: n.component,
        taxable: n.taxable,
        tax: shares[i] as RoundedMoney,
      }));
    } else {
      net = brandRounded(afterDiscount);
      componentResults = componentTaxes(net, taxable, currency, mode);
    }

    const components: CalculatedTaxComponent[] = componentResults.map((r) => {
      const recoverablePercent = D(r.component.recoverablePercent);
      const recoverable = roundTaxComponent(
        Money.of(r.tax.amount.mul(recoverablePercent), currency),
        currency,
        r.component.roundingMode ?? mode,
      );
      return {
        componentId: r.component.id,
        code: r.component.code,
        rate: r.component.rate,
        taxableAmount: r.taxable.toString(),
        taxAmount: r.tax.toString(),
        recoverableAmount: recoverable.toString(),
        // Derived, not rounded again: the two halves must re-sum to the tax.
        nonrecoverableAmount: r.tax.sub(recoverable).toString(),
      };
    });

    // ADR-0006 §3 step 2: sum the ROUNDED components. Never re-round the sum.
    const taxTotal = sumRounded(
      componentResults.map((r) => r.tax),
      currency,
    );
    const gross = brandRounded(net.add(taxTotal));

    calculated.push({
      lineNo: line.lineNo,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      discountAmount: discount.toString(),
      netAmount: net.toString(),
      taxAmount: taxTotal.toString(),
      grossAmount: gross.toString(),
      taxCodeId: taxCode?.id ?? null,
      components,
      snapshot: snapshotOf(line, components, taxCode?.inclusive ?? false, mode),
    });
  }

  // ------------------------------------------------------------- the totals --
  // Steps 3 and 4: sums of already-rounded parts, and that is the end of it.
  const subtotal = sumRounded(
    calculated.map((l) => brandRounded(Money.of(D(l.netAmount), currency))),
    currency,
  );
  const taxTotal = sumRounded(
    calculated.map((l) => brandRounded(Money.of(D(l.taxAmount), currency))),
    currency,
  );
  const lineDiscountTotal = sumRounded(
    calculated.map((l) => brandRounded(Money.of(D(l.discountAmount), currency))),
    currency,
  );
  const grossTotal = sumRounded(
    calculated.map((l) => brandRounded(Money.of(D(l.grossAmount), currency))),
    currency,
  );

  let documentDiscount = brandRounded(Money.zero(currency));
  if (options.documentDiscount && !D(options.documentDiscount).isZero()) {
    documentDiscount = roundLineNet(
      Money.of(D(options.documentDiscount), currency),
      currency,
      mode,
    );
    if (documentDiscount.gt(grossTotal)) {
      const excess = new ProblemList();
      excess.add(
        'document_discount',
        'DISCOUNT_EXCEEDS_DOCUMENT',
        `A document discount of ${documentDiscount.toString()} exceeds the document total of ${grossTotal.toString()}.`,
      );
      excess.throwIfAny('This document cannot be calculated.');
    }
  }

  const total = brandRounded(grossTotal.sub(documentDiscount));

  return {
    currency,
    lines: calculated,
    subtotal: subtotal.toString(),
    discountTotal: brandRounded(lineDiscountTotal.add(documentDiscount)).toString(),
    taxTotal: taxTotal.toString(),
    // Zero here by construction: nothing in this chain re-rounds, so there is no
    // residual to absorb. The field exists because cash settlement (ADR-0006 §2)
    // produces one, and it is the settlement that fills it in, not the document.
    roundingAdjustment: '0',
    total: total.toString(),
    taxByComponent: aggregateComponents(calculated, currency),
  };
}

/**
 * Rolls the per-line components up per component code.
 *
 * This is what a tax return reads and what the tax subledger is written from, so
 * it aggregates the already-rounded line amounts rather than recomputing from
 * the document total — the two differ, and the line amounts are the ones the
 * customer was shown.
 */
function aggregateComponents(
  lines: readonly CalculatedLine[],
  currency: string,
): CalculatedTaxComponent[] {
  const byComponent = new Map<string, CalculatedTaxComponent>();
  for (const line of lines) {
    for (const component of line.components) {
      const existing = byComponent.get(component.componentId);
      if (!existing) {
        byComponent.set(component.componentId, { ...component });
        continue;
      }
      byComponent.set(component.componentId, {
        ...existing,
        taxableAmount: add(existing.taxableAmount, component.taxableAmount, currency),
        taxAmount: add(existing.taxAmount, component.taxAmount, currency),
        recoverableAmount: add(existing.recoverableAmount, component.recoverableAmount, currency),
        nonrecoverableAmount: add(
          existing.nonrecoverableAmount,
          component.nonrecoverableAmount,
          currency,
        ),
      });
    }
  }
  return [...byComponent.values()];
}

function add(a: string, b: string, currency: string): string {
  return Money.of(D(a), currency)
    .add(Money.of(D(b), currency))
    .toString();
}

/**
 * Converts a transaction amount to the book's base currency.
 *
 * ADR-0006 §3 step 5: round after multiplying, per line. Doing it once on the
 * document total and apportioning back would make the base amounts disagree with
 * the lines that produced them, which is the AR-to-GL reconciliation failing by
 * construction.
 */
export function toBase(
  amount: string,
  rate: string,
  transactionCurrency: string,
  baseCurrency: string,
  mode?: RoundingMode,
): string {
  if (transactionCurrency === baseCurrency) {
    return roundLineNet(Money.of(D(amount), baseCurrency), baseCurrency, mode).toString();
  }
  const converted = Money.of(D(amount).mul(D(rate)), baseCurrency);
  return roundLineNet(converted, baseCurrency, mode).toString();
}

/**
 * The realized FX gain or loss on settling one document with one payment.
 *
 * ADR-0007 puts this per allocation rather than per payment, because one receipt
 * may settle invoices booked at different rates and a single figure for the
 * receipt cannot be attributed to any of them.
 *
 * Positive is a gain for a receivable and a loss for a payable; the caller knows
 * which side it is on and the posting rule decides the account.
 */
export function realizedFx(input: {
  readonly allocatedAmount: string;
  readonly documentRate: string;
  readonly settlementRate: string;
  readonly baseCurrency: string;
  readonly mode?: RoundingMode | undefined;
}): string {
  const atDocument = Money.of(
    D(input.allocatedAmount).mul(D(input.documentRate)),
    input.baseCurrency,
  );
  const atSettlement = Money.of(
    D(input.allocatedAmount).mul(D(input.settlementRate)),
    input.baseCurrency,
  );
  const difference = roundLineNet(atSettlement, input.baseCurrency, input.mode).sub(
    roundLineNet(atDocument, input.baseCurrency, input.mode),
  );
  return difference.toString();
}

/**
 * doc 04's aging buckets. Configurable, defaulting to 0-30/31-60/61-90/91+.
 *
 * `asOf` and `dueDate` are plain ISO dates because an aging bucket is a calendar
 * question, not an instant one: an invoice due today is not overdue anywhere in
 * the world, whatever the server's clock says.
 */
export const DEFAULT_AGING_BUCKETS: readonly number[] = [30, 60, 90];

export function agingBucket(
  dueDate: string,
  asOf: string,
  buckets: readonly number[] = DEFAULT_AGING_BUCKETS,
): number {
  const days = Math.floor(
    (Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000,
  );
  if (days <= 0) return 0;
  for (let i = 0; i < buckets.length; i++) {
    if (days <= (buckets[i] as number)) return i + 1;
  }
  return buckets.length + 1;
}

export { RoundingError };
