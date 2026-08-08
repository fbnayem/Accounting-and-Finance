import { describe, it, expect } from 'vitest';
import {
  accountingDate,
  addDays,
  addMonths,
  endOfMonth,
  daysBetween,
  rangesOverlap,
  rangeContains,
  todayIn,
  DateError,
} from './dates';
import { encodeCursor, decodeCursor, resolvePage, buildPage } from './pagination';
import { uuidv7, uuidVersion, uuidv7Timestamp, isUuid } from './ids';

describe('accounting dates', () => {
  it('rejects anything that is not a real calendar day', () => {
    expect(() => accountingDate('2026-02-30')).toThrow(DateError);
    expect(() => accountingDate('2026-13-01')).toThrow(DateError);
    expect(() => accountingDate('2026-1-1')).toThrow(DateError);
    expect(() => accountingDate('2026-01-01T00:00:00Z')).toThrow(DateError);
    expect(accountingDate('2024-02-29')).toBe('2024-02-29');
  });

  it('clamps month arithmetic to the last day of the target month', () => {
    expect(addMonths(accountingDate('2026-01-31'), 1)).toBe('2026-02-28');
    expect(addMonths(accountingDate('2024-01-31'), 1)).toBe('2024-02-29');
    expect(addMonths(accountingDate('2026-03-31'), -1)).toBe('2026-02-28');
  });

  it('crosses year boundaries', () => {
    expect(addDays(accountingDate('2025-12-31'), 1)).toBe('2026-01-01');
    expect(daysBetween(accountingDate('2025-12-31'), accountingDate('2026-01-01'))).toBe(1);
    expect(endOfMonth(accountingDate('2026-12-05'))).toBe('2026-12-31');
  });

  it('resolves the local calendar day, not the server day', () => {
    // 2026-01-01T10:00Z is still 2025-12-31 in Los Angeles. Posting on the wrong
    // side of this boundary puts a journal in the wrong fiscal year.
    const instant = new Date('2026-01-01T02:00:00Z');
    expect(todayIn('UTC', instant)).toBe('2026-01-01');
    expect(todayIn('America/Los_Angeles', instant)).toBe('2025-12-31');
    expect(todayIn('Pacific/Auckland', instant)).toBe('2026-01-01');
  });
});

describe('half-open date ranges (matching the daterange [) exclusion constraints)', () => {
  const jan = { from: accountingDate('2026-01-01'), to: accountingDate('2026-02-01') };
  const feb = { from: accountingDate('2026-02-01'), to: accountingDate('2026-03-01') };
  const open = { from: accountingDate('2026-01-01'), to: null };

  it('treats adjoining periods as non-overlapping', () => {
    expect(rangesOverlap(jan, feb)).toBe(false);
  });

  it('treats an open-ended range as overlapping everything after its start', () => {
    expect(rangesOverlap(open, feb)).toBe(true);
  });

  it('excludes the end boundary', () => {
    expect(rangeContains(jan, accountingDate('2026-01-31'))).toBe(true);
    expect(rangeContains(jan, accountingDate('2026-02-01'))).toBe(false);
  });
});

describe('cursor pagination', () => {
  it('round-trips', () => {
    const c = encodeCursor({ k: '2026-01-01', id: 'abc', d: 'desc' });
    expect(decodeCursor(c)).toEqual({ k: '2026-01-01', id: 'abc', d: 'desc' });
  });

  it('rejects a tampered cursor with a stable code', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrowError(
      expect.objectContaining({ code: 'MALFORMED_CURSOR' }),
    );
  });

  it('enforces the contract limit bounds', () => {
    expect(resolvePage({}).limit).toBe(50);
    expect(resolvePage({ limit: 200 }).limit).toBe(200);
    expect(() => resolvePage({ limit: 201 })).toThrow();
    expect(() => resolvePage({ limit: 0 })).toThrow();
  });

  it('reports has_more from the extra row, not a count query', () => {
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: `id-${i}`, k: `k-${i}` }));
    const page = buildPage(rows, 3, 'asc', (r) => ({ k: r.k, id: r.id }));
    expect(page.data).toHaveLength(3);
    expect(page.meta.has_more).toBe(true);
    expect(decodeCursor(page.meta.next_cursor!).id).toBe('id-2');

    const last = buildPage(rows.slice(0, 2), 3, 'asc', (r) => ({ k: r.k, id: r.id }));
    expect(last.meta.has_more).toBe(false);
    expect(last.meta.next_cursor).toBeNull();
  });
});

describe('identifiers', () => {
  it('generates well-formed, time-ordered v7 uuids', () => {
    const a = uuidv7(1_700_000_000_000);
    const b = uuidv7(1_700_000_001_000);
    expect(isUuid(a)).toBe(true);
    expect(uuidVersion(a)).toBe(7);
    expect(a < b).toBe(true); // lexical order matches time order — the point of v7
    expect(uuidv7Timestamp(a)?.getTime()).toBe(1_700_000_000_000);
  });

  it('keeps ordering across a batch generated in one millisecond', () => {
    const ids = Array.from({ length: 500 }, () => uuidv7(1_700_000_000_000));
    expect(new Set(ids).size).toBe(500);
    expect(ids.every((id) => id.slice(0, 13) === ids[0]!.slice(0, 13))).toBe(true);
  });
});
