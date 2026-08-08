/**
 * Seed profiles — ADR-0009 §1, exactly as ratified.
 *
 * | Profile     | Entities | Fiscal years | Journal lines | Invoices | Bank txns | Items | Users |
 * |-------------|---------:|-------------:|--------------:|---------:|----------:|------:|------:|
 * | `small`     |        1 |            1 |          20 k |     2 k  |     5 k   |  200  |     2 |
 * | `reference` |        1 |            3 |         500 k |    50 k  |   100 k   |   5 k |    10 |
 * | `large`     |        5 |            5 |           5 M |   500 k  |     1 M   |  50 k |    50 |
 *
 * Gate H measures against `reference`; CI regression checks run against `small`.
 *
 * Volumes beyond the ledger are declared here but only seeded once the phase that
 * owns those tables exists. The declaration lives here from the start so the
 * profile is one number set rather than a moving target per phase.
 *
 * | Volume            | Seeded from |
 * | ----------------- | ----------- |
 * | Journal lines     | Phase 0     |
 * | Invoices          | Phase 3 — and the same count of vendor bills, so AP aging has a subject too |
 * | Bank transactions | Phase 4     |
 * | Items             | Phase 5     |
 *
 * `invoices` covers both sides deliberately. ADR-0009 named one number because
 * doc 04's aging report was the workload in view; doc 05's AP aging is the same
 * query against the other table, and seeding one side would have left half of
 * Gate H's Phase 3 measurement reading an empty table (F-730).
 */

export type ProfileName = 'small' | 'reference' | 'large';

export interface SeedProfile {
  readonly name: ProfileName;
  readonly legalEntities: number;
  readonly fiscalYears: number;
  readonly journalLines: number;
  readonly invoices: number;
  readonly bankTransactions: number;
  readonly items: number;
  readonly concurrentUsers: number;
  /** Fixed, so two runs of the same profile produce byte-identical data. */
  readonly seed: number;
  /** The first fiscal year starts here; seeding never depends on today's date. */
  readonly firstFiscalYearStart: string;
}

export const PROFILES: Readonly<Record<ProfileName, SeedProfile>> = {
  small: {
    name: 'small',
    legalEntities: 1,
    fiscalYears: 1,
    journalLines: 20_000,
    invoices: 2_000,
    bankTransactions: 5_000,
    items: 200,
    concurrentUsers: 2,
    seed: 20_000,
    firstFiscalYearStart: '2024-01-01',
  },
  reference: {
    name: 'reference',
    legalEntities: 1,
    fiscalYears: 3,
    journalLines: 500_000,
    invoices: 50_000,
    bankTransactions: 100_000,
    items: 5_000,
    concurrentUsers: 10,
    seed: 500_000,
    firstFiscalYearStart: '2022-01-01',
  },
  large: {
    name: 'large',
    legalEntities: 5,
    fiscalYears: 5,
    journalLines: 5_000_000,
    invoices: 500_000,
    bankTransactions: 1_000_000,
    items: 50_000,
    concurrentUsers: 50,
    seed: 5_000_000,
    firstFiscalYearStart: '2020-01-01',
  },
};

export function resolveProfile(name: string): SeedProfile {
  const profile = PROFILES[name as ProfileName];
  if (!profile) {
    throw new Error(
      `Unknown seed profile "${name}". ADR-0009 defines exactly three: ${Object.keys(PROFILES).join(', ')}.`,
    );
  }
  return profile;
}
