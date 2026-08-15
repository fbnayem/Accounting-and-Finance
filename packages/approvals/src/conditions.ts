/**
 * Workflow conditions — doc 14: "conditions: amount, currency, vendor/customer,
 * account, category, project, department, risk flag, exception status", and doc
 * 21 Phase 6: "conditions based on amount, entity, account, vendor/customer,
 * department, risk and source type".
 *
 * -----------------------------------------------------------------------------
 * The money problem this file exists to close
 * -----------------------------------------------------------------------------
 * `approval_workflows.conditions` is jsonb, and a monetary bound stored in jsonb
 * is one `JSON.parse` away from being an IEEE 754 double. node-postgres parses a
 * jsonb column with `JSON.parse`, so `{"min_amount": 10000.55}` arrives in
 * JavaScript as a binary float — and `pnpm dod:check` cannot see it, because its
 * money rule is a lexical check for a `Number` or `parseFloat` call around a
 * *word-bounded* name, and `min_amount` contains no word boundary before
 * `amount`. Nothing converts anything; the conversion already happened inside
 * the JSON parser. ADR-0006 §1 is violated with no offending line to find.
 * (The check is also strict enough to fire on the two names written out in full
 * with a bracket after them, which is why they are not written that way here —
 * enforcement code and the prose explaining it share one grep.)
 *
 * Three things close it, and each is independently sufficient for a different
 * attack:
 *
 *   1. **The writer refuses a JSON number.** `parseConditions` rejects any
 *      monetary key that is not a decimal *string*, naming ADR-0006. So a
 *      condition written through this package is a string in the database and
 *      `JSON.parse` has nothing to round.
 *   2. **The reader never lets a number through the parser.** The services
 *      extract monetary keys with `conditions ->> 'min_amount'` — PostgreSQL
 *      renders jsonb numbers from `numeric`, which is exact — so even a row
 *      written by hand in psql, by a migration or by a future module arrives as
 *      the text that was stored. `parseStoredConditions` is the entry point that
 *      takes those texts.
 *   3. **A number that reaches the parser anyway is an error, not a coercion.**
 *      If a caller hands this module a parsed object with a numeric bound, it
 *      throws rather than calling `String(...)` on it — by then the damage is
 *      already done and stringifying it would launder a rounded value into
 *      something that looks exact.
 *
 * `conditions.test.ts` proves the round trip on a value a double cannot hold, and
 * proves the naive path loses it, because a control whose failure mode is never
 * demonstrated is a control nobody can tell is working.
 */
import { AppError, D } from '@acct/domain';

/** The keys whose values are money and must therefore never be JSON numbers. */
export const MONETARY_CONDITION_KEYS = ['min_amount', 'max_amount'] as const;
export type MonetaryConditionKey = (typeof MONETARY_CONDITION_KEYS)[number];

const LIST_KEYS = [
  'currencies',
  'legal_entity_ids',
  'branch_ids',
  'account_ids',
  'counterparty_ids',
  'department_ids',
  'project_ids',
  'source_types',
  'risk_flags',
  'exception_states',
] as const;

const KNOWN_KEYS: readonly string[] = [...MONETARY_CONDITION_KEYS, ...LIST_KEYS];

export interface WorkflowConditions {
  /** Inclusive lower bound: the workflow applies at exactly this value. */
  readonly minAmount: string | null;
  /** Exclusive upper bound, so adjacent bands tile without overlapping. */
  readonly maxAmount: string | null;
  readonly currencies: readonly string[] | null;
  readonly legalEntityIds: readonly string[] | null;
  readonly branchIds: readonly string[] | null;
  readonly accountIds: readonly string[] | null;
  readonly counterpartyIds: readonly string[] | null;
  readonly departmentIds: readonly string[] | null;
  readonly projectIds: readonly string[] | null;
  readonly sourceTypes: readonly string[] | null;
  readonly riskFlags: readonly string[] | null;
  readonly exceptionStates: readonly string[] | null;
}

export const NO_CONDITIONS: WorkflowConditions = {
  minAmount: null,
  maxAmount: null,
  currencies: null,
  legalEntityIds: null,
  branchIds: null,
  accountIds: null,
  counterpartyIds: null,
  departmentIds: null,
  projectIds: null,
  sourceTypes: null,
  riskFlags: null,
  exceptionStates: null,
};

/** The facts a document presents to a workflow's conditions. */
export interface ConditionFacts {
  /** Exact decimal string. Never a number, at any point in its journey here. */
  readonly amount: string;
  readonly currency: string;
  readonly legalEntityId: string;
  readonly branchId: string | null;
  readonly accountIds: readonly string[];
  readonly counterpartyId: string | null;
  readonly departmentId: string | null;
  readonly projectId: string | null;
  readonly sourceType: string;
  readonly riskFlags: readonly string[];
  readonly exceptionStates: readonly string[];
}

function refuseNumber(key: string, value: unknown): never {
  throw new AppError(
    'VALIDATION_FAILED',
    `Workflow condition "${key}" is a JSON number (${String(value)}). Monetary bounds must be ` +
      `decimal strings — "10000.55", not 10000.55. A number in jsonb becomes a binary float the ` +
      `moment it is parsed in JavaScript, and an approval threshold that is off by a fraction of ` +
      `a unit is a control that admits the transaction it exists to stop (ADR-0006 §1).`,
    { details: { key, value: String(value) } },
  );
}

/**
 * Normalises one monetary bound.
 *
 * A string is validated as an exact decimal literal by `Decimal.parse` — which
 * also rejects exponent notation — and returned unchanged, so "10000.00" stays
 * "10000.00" rather than being renormalised to "10000". The stored text is what
 * a reviewer sees, and silently changing its scale would make the audit trail
 * disagree with what was typed.
 */
function normaliseMoney(key: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') refuseNumber(key, value);
  if (typeof value !== 'string') {
    throw new AppError(
      'VALIDATION_FAILED',
      `Workflow condition "${key}" must be a decimal string or null, not ${typeof value}.`,
      { details: { key } },
    );
  }
  const trimmed = value.trim();
  if (trimmed === '') return null;
  try {
    D(trimmed);
  } catch {
    throw new AppError(
      'VALIDATION_FAILED',
      `Workflow condition "${key}" is not an exact decimal literal: ${JSON.stringify(value)}.`,
      { details: { key } },
    );
  }
  return trimmed;
}

function normaliseList(key: string, value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new AppError('VALIDATION_FAILED', `Workflow condition "${key}" must be an array.`, {
      details: { key },
    });
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new AppError(
        'VALIDATION_FAILED',
        `Workflow condition "${key}" must contain non-empty strings.`,
        { details: { key } },
      );
    }
    out.push(item.trim());
  }
  // An empty list is not "no condition" — it is a condition nothing can satisfy,
  // which would make the workflow unreachable while looking configured. Refused.
  if (out.length === 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Workflow condition "${key}" is an empty list, which no document can satisfy. Omit the key ` +
        `to place no constraint on ${key}.`,
      { details: { key } },
    );
  }
  return out;
}

/**
 * Parses a conditions object supplied by a caller (an API body, a fixture).
 *
 * Refuses every unknown key. A workflow whose condition was typed `min_ammount`
 * would otherwise be a workflow with NO amount condition that reads as though it
 * has one — and it would apply to every document in the tenant.
 */
export function parseConditions(raw: unknown): WorkflowConditions {
  if (raw === null || raw === undefined) return NO_CONDITIONS;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('VALIDATION_FAILED', 'Workflow conditions must be an object.');
  }
  const input = raw as Record<string, unknown>;

  const unknown = Object.keys(input).filter((k) => !KNOWN_KEYS.includes(k));
  if (unknown.length > 0) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Unknown workflow condition(s): ${unknown.join(', ')}. Supported conditions are ` +
        `${KNOWN_KEYS.join(', ')}. An unrecognised key would leave the workflow matching every ` +
        `document while appearing to be restricted.`,
      { details: { unknown } },
    );
  }

  const conditions: WorkflowConditions = {
    minAmount: normaliseMoney('min_amount', input['min_amount']),
    maxAmount: normaliseMoney('max_amount', input['max_amount']),
    currencies: normaliseList('currencies', input['currencies']),
    legalEntityIds: normaliseList('legal_entity_ids', input['legal_entity_ids']),
    branchIds: normaliseList('branch_ids', input['branch_ids']),
    accountIds: normaliseList('account_ids', input['account_ids']),
    counterpartyIds: normaliseList('counterparty_ids', input['counterparty_ids']),
    departmentIds: normaliseList('department_ids', input['department_ids']),
    projectIds: normaliseList('project_ids', input['project_ids']),
    sourceTypes: normaliseList('source_types', input['source_types']),
    riskFlags: normaliseList('risk_flags', input['risk_flags']),
    exceptionStates: normaliseList('exception_states', input['exception_states']),
  };

  if (conditions.minAmount !== null && conditions.maxAmount !== null) {
    if (D(conditions.maxAmount).lte(D(conditions.minAmount))) {
      throw new AppError(
        'VALIDATION_FAILED',
        `Workflow condition max_amount (${conditions.maxAmount}) is not above min_amount ` +
          `(${conditions.minAmount}), so no amount can satisfy both.`,
      );
    }
  }
  return conditions;
}

/**
 * Parses conditions read back out of the database.
 *
 * The monetary bounds arrive SEPARATELY, as the text PostgreSQL produced from
 * `conditions ->> 'min_amount'`, precisely so that they never travelled through
 * `JSON.parse`. The rest of the object may come from the parsed jsonb, because
 * currency codes and identifiers are strings and a string survives the trip.
 */
export function parseStoredConditions(
  json: unknown,
  money: { minAmount: string | null; maxAmount: string | null },
): WorkflowConditions {
  const base = typeof json === 'object' && json !== null ? { ...(json as object) } : {};
  const record = base as Record<string, unknown>;
  // Drop whatever the jsonb parse produced for the monetary keys — including a
  // number it has already rounded — and use the exact text instead.
  delete record['min_amount'];
  delete record['max_amount'];
  const parsed = parseConditions(record);
  return {
    ...parsed,
    minAmount: normaliseMoney('min_amount', money.minAmount),
    maxAmount: normaliseMoney('max_amount', money.maxAmount),
  };
}

/** The canonical jsonb form: monetary bounds as strings, absent keys omitted. */
export function serializeConditions(conditions: WorkflowConditions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (conditions.minAmount !== null) out['min_amount'] = conditions.minAmount;
  if (conditions.maxAmount !== null) out['max_amount'] = conditions.maxAmount;
  const lists: ReadonlyArray<readonly [string, readonly string[] | null]> = [
    ['currencies', conditions.currencies],
    ['legal_entity_ids', conditions.legalEntityIds],
    ['branch_ids', conditions.branchIds],
    ['account_ids', conditions.accountIds],
    ['counterparty_ids', conditions.counterpartyIds],
    ['department_ids', conditions.departmentIds],
    ['project_ids', conditions.projectIds],
    ['source_types', conditions.sourceTypes],
    ['risk_flags', conditions.riskFlags],
    ['exception_states', conditions.exceptionStates],
  ];
  for (const [key, value] of lists) if (value !== null) out[key] = [...value];
  return out;
}

export interface ConditionMatch {
  readonly matched: boolean;
  /** Why not, in the caller's words. Empty when matched. */
  readonly failed: readonly string[];
}

function intersects(list: readonly string[] | null, values: readonly (string | null)[]): boolean {
  if (list === null) return true;
  return values.some((v) => v !== null && list.includes(v));
}

/**
 * Does this document fall inside the workflow's conditions?
 *
 * Every stated condition must hold; an omitted condition constrains nothing. The
 * amount comparison is exact decimal throughout — `D()` on two strings — so a
 * boundary is a boundary and not a floating-point neighbourhood.
 *
 * Boundaries, stated so `conditions.test.ts` can hold them to it:
 *   - `min_amount` is INCLUSIVE. A tenant who writes 10000 means "ten thousand
 *     needs approving"; reading it exclusively puts the most common round number
 *     anyone will test with on the permissive side.
 *   - `max_amount` is EXCLUSIVE, so `[0, 10000)` and `[10000, ∞)` tile the line
 *     with no amount belonging to both bands and none belonging to neither.
 *   - The comparison is on the SIGNED amount, not its absolute value: callers
 *     pass the document's absolute value where that is the right question (a
 *     journal has no sign), and a credit note's negative total is a different
 *     question from a debit of the same size.
 */
export function matchesConditions(
  conditions: WorkflowConditions,
  facts: ConditionFacts,
): ConditionMatch {
  const failed: string[] = [];

  if (conditions.minAmount !== null && D(facts.amount).lt(D(conditions.minAmount))) {
    failed.push(`amount ${facts.amount} is below min_amount ${conditions.minAmount}`);
  }
  if (conditions.maxAmount !== null && D(facts.amount).gte(D(conditions.maxAmount))) {
    failed.push(`amount ${facts.amount} is at or above max_amount ${conditions.maxAmount}`);
  }
  if (!intersects(conditions.currencies, [facts.currency])) {
    failed.push(`currency ${facts.currency} is not in currencies`);
  }
  if (!intersects(conditions.legalEntityIds, [facts.legalEntityId])) {
    failed.push('legal entity is not in legal_entity_ids');
  }
  if (!intersects(conditions.branchIds, [facts.branchId])) {
    failed.push('branch is not in branch_ids');
  }
  if (!intersects(conditions.accountIds, facts.accountIds)) {
    failed.push('no line touches an account in account_ids');
  }
  if (!intersects(conditions.counterpartyIds, [facts.counterpartyId])) {
    failed.push('counterparty is not in counterparty_ids');
  }
  if (!intersects(conditions.departmentIds, [facts.departmentId])) {
    failed.push('department is not in department_ids');
  }
  if (!intersects(conditions.projectIds, [facts.projectId])) {
    failed.push('project is not in project_ids');
  }
  if (!intersects(conditions.sourceTypes, [facts.sourceType])) {
    failed.push(`source type ${facts.sourceType} is not in source_types`);
  }
  if (!intersects(conditions.riskFlags, facts.riskFlags)) {
    failed.push('no risk flag is in risk_flags');
  }
  if (!intersects(conditions.exceptionStates, facts.exceptionStates)) {
    failed.push('no exception state is in exception_states');
  }

  return { matched: failed.length === 0, failed };
}

/**
 * How specific a condition set is, used to break ties between two workflows that
 * both match.
 *
 * More stated conditions wins. The alternative — first row the query returns — is
 * a rule nobody can predict, and doc 14's acceptance criterion is that behaviour
 * is *deterministic*.
 */
export function conditionSpecificity(conditions: WorkflowConditions): number {
  return Object.values(conditions).filter((v) => v !== null).length;
}
