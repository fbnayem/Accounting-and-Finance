import { describe, it, expect } from 'vitest';
import { PROFILES, resolveProfile } from './profiles';
import { DeterministicRandom } from './random';
import { CHART_OF_ACCOUNTS, POSTABLE_PAIRS, ACCOUNT_GROUPS } from './seed/chart-of-accounts';
import { WORKLOADS } from './bench/workloads';

describe('seed profiles', () => {
  it('matches the volumes ratified in ADR-0009 §1', () => {
    expect(PROFILES.small.journalLines).toBe(20_000);
    expect(PROFILES.reference.journalLines).toBe(500_000);
    expect(PROFILES.large.journalLines).toBe(5_000_000);
    expect(PROFILES.reference.fiscalYears).toBe(3);
    expect(PROFILES.large.legalEntities).toBe(5);
  });

  it('names the three profiles and nothing else', () => {
    expect(Object.keys(PROFILES)).toEqual(['small', 'reference', 'large']);
    expect(() => resolveProfile('medium')).toThrow(/ADR-0009 defines exactly three/);
  });
});

describe('determinism', () => {
  it('produces an identical stream for the same seed', () => {
    const a = new DeterministicRandom(42);
    const b = new DeterministicRandom(42);
    const left = Array.from({ length: 200 }, () => a.next());
    const right = Array.from({ length: 200 }, () => b.next());
    expect(left).toEqual(right);
  });

  it('produces different streams for different seeds', () => {
    const a = new DeterministicRandom(1);
    const b = new DeterministicRandom(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('builds money from integer minor units, never from a float', () => {
    const rng = new DeterministicRandom(7);
    for (let i = 0; i < 500; i++) {
      const amount = rng.amount(1, 10_000);
      expect(amount).toMatch(/^\d+\.\d{2}$/);
    }
  });

  it('embeds the supplied clock in generated identifiers', () => {
    const rng = new DeterministicRandom(9);
    const id = rng.uuidv7(1_700_000_000_000);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(1_700_000_000_000);
  });
});

describe('chart of accounts', () => {
  it('has unique codes and valid groups', () => {
    const codes = CHART_OF_ACCOUNTS.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    const groups = new Set(ACCOUNT_GROUPS.map((g) => g.code));
    expect(CHART_OF_ACCOUNTS.every((a) => groups.has(a.group))).toBe(true);
  });

  it('includes contra accounts, so reporting cannot assume type implies normal balance', () => {
    const contra = CHART_OF_ACCOUNTS.filter(
      (a) => a.type === 'ASSET' && a.normalBalance === 'CREDIT',
    );
    expect(contra.map((a) => a.code)).toContain('1510'); // accumulated depreciation
    const contraRevenue = CHART_OF_ACCOUNTS.filter(
      (a) => a.type === 'REVENUE' && a.normalBalance === 'DEBIT',
    );
    expect(contraRevenue.map((a) => a.code)).toContain('4090'); // sales returns
  });

  it('fills every accounting_policies account role exactly once', () => {
    const roles = CHART_OF_ACCOUNTS.map((a) => a.policyRole).filter(Boolean) as string[];
    expect(new Set(roles).size).toBe(roles.length);
    // The S1 finding F-203 was that posting rules resolved accounts through a
    // table that did not exist. Every role the schema declares must be seeded.
    for (const required of [
      'ar_control_account_id',
      'ap_control_account_id',
      'retained_earnings_account_id',
      'current_year_earnings_account_id',
      'rounding_account_id',
      'suspense_account_id',
      'grni_account_id',
    ]) {
      expect(roles).toContain(required);
    }
  });

  it('only posts to accounts that exist and are not system accounts', () => {
    const byCode = new Map(CHART_OF_ACCOUNTS.map((a) => [a.code, a]));
    for (const [debit, credit] of POSTABLE_PAIRS) {
      expect(byCode.has(debit)).toBe(true);
      expect(byCode.has(credit)).toBe(true);
      expect(byCode.get(debit)?.isSystem ?? false).toBe(false);
      expect(byCode.get(credit)?.isSystem ?? false).toBe(false);
    }
  });
});

describe('Gate H workloads', () => {
  it('carries the ADR-0009 §2 targets', () => {
    const target = (name: string) => WORKLOADS.find((w) => w.name === name)?.targetMs;
    expect(target('trial-balance-one-period')).toBe(1_500);
    expect(target('profit-and-loss-with-comparatives')).toBe(3_000);
    expect(target('balance-sheet-one-period')).toBe(1_500);
    expect(target('api-list-cursor-page-50')).toBe(300);
    expect(target('single-journal-post-10-lines')).toBe(150);
    expect(target('consolidation-run-5-entities')).toBe(60_000);
  });

  it('gives every workload a target — a gate with no number cannot be failed', () => {
    expect(WORKLOADS.every((w) => w.targetMs > 0)).toBe(true);
    expect(new Set(WORKLOADS.map((w) => w.name)).size).toBe(WORKLOADS.length);
  });

  it('declares the phase each workload becomes measurable in', () => {
    expect(WORKLOADS.every((w) => w.availableFromPhase >= 2)).toBe(true);
  });
});
