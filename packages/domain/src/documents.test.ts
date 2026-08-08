import { describe, it, expect } from 'vitest';
import {
  calculateDocument,
  agingBucket,
  realizedFx,
  toBase,
  type TaxCodeInput,
  type DocumentLineInput,
} from './documents';
import { D } from './decimal';

/**
 * doc 04's acceptance criterion is "taxable invoice posting balances and matches
 * invoice total". The arithmetic below is what makes that true or not, so these
 * assert exact strings rather than approximate equality — a penny is the unit a
 * customer notices and an auditor asks about.
 */

const vat = (rate: string, over: Partial<TaxCodeInput> = {}): TaxCodeInput => ({
  id: 'tax-1',
  code: 'VAT',
  treatment: 'STANDARD',
  inclusive: false,
  components: [
    {
      id: 'comp-1',
      code: 'VAT',
      sequence: 1,
      rate,
      compoundOnPrevious: false,
      recoverablePercent: '1',
    },
  ],
  ...over,
});

const line = (over: Partial<DocumentLineInput> = {}): DocumentLineInput => ({
  lineNo: 1,
  description: 'Consulting',
  quantity: '1',
  unitPrice: '100.00',
  ...over,
});

describe('exclusive tax', () => {
  it('adds tax to the stated price', () => {
    const doc = calculateDocument([line({ taxCode: vat('0.20') })], { currency: 'GBP' });

    expect(doc.subtotal).toBe('100.00000000');
    expect(doc.taxTotal).toBe('20.00000000');
    expect(doc.total).toBe('120.00000000');
    expect(doc.lines[0]?.grossAmount).toBe('120.00000000');
  });

  it('applies a line discount before tax', () => {
    // The order matters and is not arbitrary: taxing before the discount charges
    // the customer tax on money they never paid.
    const doc = calculateDocument(
      [line({ quantity: '2', unitPrice: '50.00', discountAmount: '10.00', taxCode: vat('0.20') })],
      { currency: 'GBP' },
    );

    expect(doc.subtotal).toBe('90.00000000');
    expect(doc.taxTotal).toBe('18.00000000');
    expect(doc.total).toBe('108.00000000');
  });

  it('leaves an exempt line untaxed but still on the document', () => {
    // Exempt is not the same as absent. The line contributes to the subtotal and
    // to the tax return's exempt box; dropping it loses both.
    const doc = calculateDocument([line({ taxCode: vat('0.20', { treatment: 'EXEMPT' }) })], {
      currency: 'GBP',
    });

    expect(doc.subtotal).toBe('100.00000000');
    expect(doc.taxTotal).toBe('0.00000000');
    expect(doc.lines[0]?.components).toEqual([]);
  });

  it('carries no tax on a reverse-charge line', () => {
    // doc 07: reverse charge moves the liability to the buyer, so the seller's
    // document shows none. Both sides still reach the tax subledger, which is the
    // posting rule's job rather than this function's.
    const doc = calculateDocument(
      [line({ taxCode: vat('0.20', { treatment: 'REVERSE_CHARGE' }) })],
      { currency: 'GBP' },
    );
    expect(doc.taxTotal).toBe('0.00000000');
  });
});

describe('inclusive tax', () => {
  it('derives the net from a tax-inclusive price', () => {
    // ADR-0006 §6. 120 at 20% inclusive is 100 + 20, and the two must re-sum to
    // exactly the price quoted.
    const doc = calculateDocument(
      [line({ unitPrice: '120.00', taxCode: vat('0.20', { inclusive: true }) })],
      { currency: 'GBP' },
    );

    expect(doc.subtotal).toBe('100.00000000');
    expect(doc.taxTotal).toBe('20.00000000');
    expect(doc.total).toBe('120.00000000');
  });

  it('never loses a penny on a price that does not divide evenly', () => {
    // 9.99 inclusive at 20%: the net is 8.325, which is not a currency amount.
    // Whatever the split, net + tax must be 9.99 — deriving the tax as the
    // remainder is what guarantees it, and rounding both independently is what
    // breaks it.
    const doc = calculateDocument(
      [line({ unitPrice: '9.99', taxCode: vat('0.20', { inclusive: true }) })],
      { currency: 'GBP' },
    );

    const net = D(doc.subtotal);
    const tax = D(doc.taxTotal);
    expect(net.add(tax).toString()).toBe('9.99000000');
    expect(doc.total).toBe('9.99000000');
  });

  it('splits inclusive tax across components so the parts sum to the whole', () => {
    const twoComponents: TaxCodeInput = {
      id: 'tax-2',
      code: 'GST+PST',
      treatment: 'STANDARD',
      inclusive: true,
      components: [
        {
          id: 'c1',
          code: 'GST',
          sequence: 1,
          rate: '0.05',
          compoundOnPrevious: false,
          recoverablePercent: '1',
        },
        {
          id: 'c2',
          code: 'PST',
          sequence: 2,
          rate: '0.07',
          compoundOnPrevious: false,
          recoverablePercent: '1',
        },
      ],
    };
    const doc = calculateDocument([line({ unitPrice: '19.99', taxCode: twoComponents })], {
      currency: 'CAD',
    });

    const components = doc.lines[0]?.components ?? [];
    expect(components).toHaveLength(2);
    const summed = components.reduce((a, c) => a.add(D(c.taxAmount)), D('0'));
    expect(summed.toString()).toBe(D(doc.taxTotal).toString());
    expect(D(doc.subtotal).add(D(doc.taxTotal)).toString()).toBe('19.99000000');
  });
});

describe('compound tax', () => {
  it('charges a compound component on the base plus the tax before it', () => {
    // 100 base. GST 5% = 5. PST 8% compounded = 8% of 105 = 8.40, not 8.00.
    // The difference is the entire point of the flag.
    const compound: TaxCodeInput = {
      id: 'tax-3',
      code: 'COMPOUND',
      treatment: 'STANDARD',
      inclusive: false,
      components: [
        {
          id: 'c1',
          code: 'GST',
          sequence: 1,
          rate: '0.05',
          compoundOnPrevious: false,
          recoverablePercent: '1',
        },
        {
          id: 'c2',
          code: 'PST',
          sequence: 2,
          rate: '0.08',
          compoundOnPrevious: true,
          recoverablePercent: '1',
        },
      ],
    };
    const doc = calculateDocument([line({ taxCode: compound })], { currency: 'CAD' });

    const components = doc.lines[0]?.components ?? [];
    expect(components[0]?.taxAmount).toBe('5.00000000');
    expect(components[1]?.taxAmount).toBe('8.40000000');
    expect(doc.total).toBe('113.40000000');
  });

  it('applies components in sequence order, not array order', () => {
    const outOfOrder: TaxCodeInput = {
      id: 'tax-4',
      code: 'COMPOUND',
      treatment: 'STANDARD',
      inclusive: false,
      components: [
        {
          id: 'c2',
          code: 'PST',
          sequence: 2,
          rate: '0.08',
          compoundOnPrevious: true,
          recoverablePercent: '1',
        },
        {
          id: 'c1',
          code: 'GST',
          sequence: 1,
          rate: '0.05',
          compoundOnPrevious: false,
          recoverablePercent: '1',
        },
      ],
    };
    const doc = calculateDocument([line({ taxCode: outOfOrder })], { currency: 'CAD' });
    expect(doc.total).toBe('113.40000000');
  });
});

describe('recoverability', () => {
  it('splits input tax and the two halves re-sum to the tax', () => {
    // doc 07: "Tax component can be 0-100% recoverable. Nonrecoverable tax
    // capitalizes into inventory/asset cost or expense." The split has to be
    // exact, because both halves post to different accounts.
    const partial = vat('0.20', {
      components: [
        {
          id: 'c1',
          code: 'VAT',
          sequence: 1,
          rate: '0.20',
          compoundOnPrevious: false,
          recoverablePercent: '0.5',
        },
      ],
    });
    const doc = calculateDocument([line({ taxCode: partial })], { currency: 'GBP' });

    const component = doc.lines[0]?.components[0];
    expect(component?.taxAmount).toBe('20.00000000');
    expect(component?.recoverableAmount).toBe('10.00000000');
    expect(component?.nonrecoverableAmount).toBe('10.00000000');
  });

  it('splits an odd amount without losing the odd penny', () => {
    const partial = vat('0.20', {
      components: [
        {
          id: 'c1',
          code: 'VAT',
          sequence: 1,
          rate: '0.20',
          compoundOnPrevious: false,
          recoverablePercent: '0.5',
        },
      ],
    });
    const doc = calculateDocument([line({ unitPrice: '50.05', taxCode: partial })], {
      currency: 'GBP',
    });

    const component = doc.lines[0]?.components[0];
    const recoverable = D(component?.recoverableAmount ?? '0');
    const nonrecoverable = D(component?.nonrecoverableAmount ?? '0');
    expect(recoverable.add(nonrecoverable).toString()).toBe(
      D(component?.taxAmount ?? '0').toString(),
    );
  });
});

describe('document totals', () => {
  it('never re-rounds a sum of rounded lines (ADR-0006 §3 steps 3 and 4)', () => {
    // Three lines whose individual taxes each round, chosen so a re-rounded total
    // would differ from the sum of the lines by a penny. The invoice a customer
    // receives shows the lines; a total that disagrees with them is the defect.
    const lines: DocumentLineInput[] = [
      { lineNo: 1, description: 'a', quantity: '1', unitPrice: '10.03', taxCode: vat('0.175') },
      { lineNo: 2, description: 'b', quantity: '1', unitPrice: '10.07', taxCode: vat('0.175') },
      { lineNo: 3, description: 'c', quantity: '1', unitPrice: '10.09', taxCode: vat('0.175') },
    ];
    const doc = calculateDocument(lines, { currency: 'GBP' });

    const lineTaxes = doc.lines.reduce((a, l) => a.add(D(l.taxAmount)), D('0'));
    const lineGross = doc.lines.reduce((a, l) => a.add(D(l.grossAmount)), D('0'));
    expect(doc.taxTotal).toBe(lineTaxes.toString());
    expect(doc.total).toBe(lineGross.toString());
  });

  it('aggregates tax per component across lines', () => {
    const lines: DocumentLineInput[] = [
      { lineNo: 1, description: 'a', quantity: '1', unitPrice: '100.00', taxCode: vat('0.20') },
      { lineNo: 2, description: 'b', quantity: '1', unitPrice: '200.00', taxCode: vat('0.20') },
    ];
    const doc = calculateDocument(lines, { currency: 'GBP' });

    expect(doc.taxByComponent).toHaveLength(1);
    expect(doc.taxByComponent[0]?.taxAmount).toBe('60.00000000');
    expect(doc.taxByComponent[0]?.taxableAmount).toBe('300.00000000');
  });

  it('applies a document discount after the lines', () => {
    const doc = calculateDocument([line({ taxCode: vat('0.20') })], {
      currency: 'GBP',
      documentDiscount: '20.00',
    });
    expect(doc.total).toBe('100.00000000');
    expect(doc.discountTotal).toBe('20.00000000');
  });

  it('refuses a document discount larger than the document', () => {
    expect(() =>
      calculateDocument([line()], { currency: 'GBP', documentDiscount: '500.00' }),
    ).toThrow(/exceeds the document total/);
  });

  it('produces no rounding residual of its own', () => {
    // The chain never re-rounds, so there is nothing to absorb. The field exists
    // for cash settlement (ADR-0006 §2), which is not the document's business.
    const doc = calculateDocument([line({ taxCode: vat('0.175') })], { currency: 'GBP' });
    expect(doc.roundingAdjustment).toBe('0');
  });
});

describe('rejections', () => {
  it('names the line and the amounts when a discount exceeds it', () => {
    expect(() =>
      calculateDocument([line({ unitPrice: '10.00', discountAmount: '25.00' })], {
        currency: 'GBP',
      }),
    ).toThrow(/discount of 25.*exceeds the line amount of 10/);
  });

  it('refuses a negative quantity and says what to do instead', () => {
    expect(() => calculateDocument([line({ quantity: '-1' })], { currency: 'GBP' })).toThrow(
      /credit note/,
    );
  });

  it('refuses two lines with the same number', () => {
    expect(() =>
      calculateDocument([line({ lineNo: 1 }), line({ lineNo: 1 })], { currency: 'GBP' }),
    ).toThrow(/appears more than once/);
  });

  it('refuses an empty document', () => {
    expect(() => calculateDocument([], { currency: 'GBP' })).toThrow(/at least one line/);
  });
});

describe('the calculation snapshot', () => {
  it('records the values, not references to them', () => {
    // doc 07's acceptance criterion: "Historical posted transaction retains same
    // tax snapshot after rule upgrade." A snapshot holding a tax_code_id and
    // nothing else changes meaning the day the rate does.
    const doc = calculateDocument([line({ taxCode: vat('0.20') })], { currency: 'GBP' });
    const snapshot = doc.lines[0]?.snapshot as Record<string, unknown>;

    expect(snapshot.unit_price).toBe('100.00');
    expect(snapshot.treatment).toBe('STANDARD');
    expect(snapshot.inclusive).toBe(false);
    expect((snapshot.components as Array<{ rate: string }>)[0]?.rate).toBe('0.20');
  });
});

describe('property: the document always adds up', () => {
  it('subtotal + tax - document discount = total, over 20000 random documents', () => {
    // The invariant that makes doc 04's first acceptance criterion true. Random
    // rather than chosen, because the rounding cases that break an invoice are
    // never the ones anyone thinks to write down.
    let seed = 20260808;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const rate = () =>
      ['0', '0.05', '0.07', '0.175', '0.20', '0.235'][Math.floor(next() * 6)] as string;

    for (let i = 0; i < 20_000; i++) {
      const lineCount = 1 + Math.floor(next() * 4);
      const inclusive = next() < 0.5;
      const lines: DocumentLineInput[] = [];
      for (let n = 1; n <= lineCount; n++) {
        lines.push({
          lineNo: n,
          description: `line ${n}`,
          quantity: String(1 + Math.floor(next() * 9)),
          unitPrice: (next() * 999).toFixed(2),
          taxCode: vat(rate(), { inclusive }),
        });
      }
      const doc = calculateDocument(lines, { currency: 'GBP' });

      const fromLines = doc.lines.reduce((a, l) => a.add(D(l.grossAmount)), D('0'));
      expect(D(doc.total).toString(), `iteration ${i} total disagrees with its lines`).toBe(
        fromLines.toString(),
      );
      expect(
        D(doc.subtotal).add(D(doc.taxTotal)).toString(),
        `iteration ${i} subtotal + tax is not the total`,
      ).toBe(D(doc.total).toString());
    }
  });
});

describe('base currency conversion', () => {
  it('converts per line and rounds after multiplying (ADR-0006 §3 step 5)', () => {
    expect(toBase('100.00', '1.2345', 'EUR', 'GBP')).toBe('123.45000000');
  });

  it('returns the amount unchanged when the currencies match', () => {
    // Not multiplied by 1: a rate of 0.9999 supplied by mistake on a same-currency
    // document would otherwise silently reprice it.
    expect(toBase('100.00', '0.9999', 'GBP', 'GBP')).toBe('100.00000000');
  });
});

describe('realized FX', () => {
  it('is computed per allocation, not per payment (ADR-0007)', () => {
    // 100 EUR invoiced at 0.85, settled at 0.90: 5 GBP more received than booked.
    expect(
      realizedFx({
        allocatedAmount: '100.00',
        documentRate: '0.85',
        settlementRate: '0.90',
        baseCurrency: 'GBP',
      }),
    ).toBe('5.00000000');
  });

  it('is zero when the rate has not moved', () => {
    expect(
      realizedFx({
        allocatedAmount: '100.00',
        documentRate: '0.85',
        settlementRate: '0.85',
        baseCurrency: 'GBP',
      }),
    ).toBe('0.00000000');
  });
});

describe('aging buckets', () => {
  it('puts an invoice due today in the current bucket', () => {
    // Due today is not overdue. Off-by-one here moves money between columns on
    // every aging report in the system.
    expect(agingBucket('2026-08-08', '2026-08-08')).toBe(0);
  });

  it('puts an invoice due tomorrow in the current bucket', () => {
    expect(agingBucket('2026-08-09', '2026-08-08')).toBe(0);
  });

  it('walks the default 30/60/90 buckets by days overdue', () => {
    expect(agingBucket('2026-07-09', '2026-08-08')).toBe(1); // 30 days  -> 1-30
    expect(agingBucket('2026-07-08', '2026-08-08')).toBe(2); // 31 days  -> 31-60
    expect(agingBucket('2026-06-08', '2026-08-08')).toBe(3); // 61 days  -> 61-90
    expect(agingBucket('2026-04-08', '2026-08-08')).toBe(4); // 122 days -> 91+
  });

  it('accepts configured buckets', () => {
    expect(agingBucket('2026-08-01', '2026-08-08', [5, 10])).toBe(2);
  });
});
