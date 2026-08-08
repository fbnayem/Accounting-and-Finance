/**
 * doc 01's configuration precedence chain, resolved once.
 *
 *   Platform default -> Localization default -> Organization -> Legal entity
 *   -> Branch -> Transaction override (only where allowed)
 *
 * Written here rather than in each consumer because the chain is the contract: a
 * module that resolves its own settings will get the order subtly wrong on the day
 * a branch override matters, and the symptom will be an invoice numbered wrongly in
 * one location.
 *
 * Merged shallowly, by key. A deep merge would let a partially-specified nested
 * object at one level silently combine with a different one above it, and "which
 * half of this object came from where" is not a question anyone should have to
 * answer while reconciling a tax return.
 */

export type SettingsRecord = Readonly<Record<string, unknown>>;

export const SETTING_LEVELS = [
  'platform',
  'localization',
  'organization',
  'legal_entity',
  'branch',
  'transaction',
] as const;

export type SettingLevel = (typeof SETTING_LEVELS)[number];

/**
 * Shipped defaults.
 *
 * F-310 found that the specification named several thresholds without values, so a
 * new tenant had undefined behaviour and Gate F had no boundaries to test. The
 * accounting ones live on `accounting_policies` where they are versioned and
 * effective-dated; these are the presentation and workflow ones that are not
 * accounting facts and therefore do not need a version history.
 */
export const PLATFORM_DEFAULTS: SettingsRecord = {
  locale: 'en',
  date_format: 'yyyy-MM-dd',
  number_format: '1,234.56',
  week_starts_on: 'monday',
  // doc 02: "Posting remains disabled until required setup validation passes."
  require_setup_validation_before_posting: true,
  document_numbering_reset: 'ANNUAL',
  session_idle_timeout_minutes: 60,
  // ADR-0010: the accessibility floor is a platform default, not a preference.
  accessibility_standard: 'WCAG-2.2-AA',
};

export interface SettingSource {
  readonly level: SettingLevel;
  readonly settings: SettingsRecord;
  /** Which row it came from, so the response can explain itself. */
  readonly sourceId?: string | null;
}

export interface ResolvedSetting {
  readonly value: unknown;
  readonly level: SettingLevel;
  readonly sourceId: string | null;
}

/**
 * Resolves the chain and reports, per key, which level won.
 *
 * The provenance is the point. "Why is this entity using a different date format"
 * is otherwise answered by reading four rows by hand, and the answer is needed
 * exactly when someone is already confused.
 */
export function resolveSettings(sources: readonly SettingSource[]): {
  effective: Record<string, unknown>;
  provenance: Record<string, ResolvedSetting>;
} {
  const ordered = SETTING_LEVELS.map((level) => sources.filter((s) => s.level === level)).flat();

  const effective: Record<string, unknown> = {};
  const provenance: Record<string, ResolvedSetting> = {};

  for (const source of ordered) {
    for (const [key, value] of Object.entries(source.settings ?? {})) {
      // `undefined` means "not set here"; `null` is a deliberate clearing and wins
      // like any other value. Conflating the two makes a null override impossible.
      if (value === undefined) continue;
      effective[key] = value;
      provenance[key] = { value, level: source.level, sourceId: source.sourceId ?? null };
    }
  }

  return { effective, provenance };
}
