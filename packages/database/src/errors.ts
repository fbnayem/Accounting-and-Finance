import { AppError, ErrorCode, internal } from '@acct/domain';

/**
 * Translates PostgreSQL errors into the contract's error taxonomy.
 *
 * This is where the database guards written in Deliverable 2 become API
 * behaviour. `reject_mutation_of_posted()` raises with SQLSTATE `restrict_violation`
 * and a message beginning `POSTED_IMMUTABLE:`; the deferred balance trigger raises
 * `UNBALANCED_JOURNAL:`. Without this mapping those guards would surface as
 * opaque 500s, and doc 15's "never a stack trace or SQL" would be violated by the
 * default error handler leaking the constraint name and query text.
 */

interface PgError {
  code?: string;
  severity?: string;
  constraint?: string;
  detail?: string;
  message: string;
  table?: string;
  column?: string;
}

function isPgError(e: unknown): e is PgError {
  return typeof e === 'object' && e !== null && 'message' in e;
}

/**
 * True only for an error that actually came from PostgreSQL.
 *
 * The distinction matters: a business rule thrown inside a transaction callback
 * must reach the caller as itself. Wrapping it as "Database operation failed"
 * would replace a specific, actionable message with a misleading one — and would
 * turn a 422 into a 500.
 */
export function isDatabaseError(e: unknown): e is PgError {
  if (!isPgError(e)) return false;
  const candidate = e as PgError & { routine?: string };
  return typeof candidate.code === 'string' && typeof candidate.severity === 'string';
}

/**
 * Guard functions in contracts/schema/0000_extensions_and_types.sql raise with a
 * stable prefix. Parsing it is deliberate: the code the API returns is chosen by
 * the same statement that enforced the rule, so the two cannot drift.
 */
const GUARD_PREFIXES: ReadonlyArray<readonly [string, ErrorCode]> = [
  ['POSTED_IMMUTABLE:', 'POSTED_IMMUTABLE'],
  ['UNBALANCED_JOURNAL:', 'UNBALANCED_JOURNAL'],
  ['PERIOD_CLOSED:', 'PERIOD_CLOSED'],
  ['OVER_ALLOCATION:', 'OVER_ALLOCATION'],
  ['CROSS_ENTITY_REFERENCE:', 'CROSS_ENTITY_REFERENCE'],
  ['INSUFFICIENT_STOCK:', 'INSUFFICIENT_STOCK'],
  ['ROUNDING_IMBALANCE:', 'ROUNDING_IMBALANCE'],
  // Phase 4 banking (F-809). Two of these — OVER_MATCH and RECONCILIATION_LOCKED
  // — have raised correctly since Deliverable 2's 0011 and were never mapped, so
  // a working control reported itself as "an unexpected error occurred". doc 15
  // forbids leaking internals, and this list is what keeps a guard's refusal
  // actionable rather than merely loud.
  ['OVER_MATCH:', 'OVER_ALLOCATION'],
  ['RECONCILIATION_LOCKED:', 'POSTED_IMMUTABLE'],
  ['RECONCILIATION_UNBALANCED:', 'VALIDATION_FAILED'],
  ['SPLIT_UNBALANCED:', 'VALIDATION_FAILED'],
  ['SPLIT_PARENT_NOT_MATCHABLE:', 'VALIDATION_FAILED'],
  // Phase 5 (0043). BUDGET_IMMUTABLE is the same shape as POSTED_IMMUTABLE — an
  // approved amount is corrected by revising to a new version, never by an edit
  // — and the caller's remedy is identical, so it maps to the same code rather
  // than earning one the contract would have to grow for it.
  ['BUDGET_IMMUTABLE:', 'POSTED_IMMUTABLE'],
  ['TRANSFER_UNBALANCED:', 'VALIDATION_FAILED'],
  // Phase 6 groundwork (0049). Without this the guard falls through to the
  // SQLSTATE map — 23001 reads as POSTED_IMMUTABLE — and answers 409 with the
  // generic "The operation could not be completed." The refusal's whole value is
  // that it names the amount and the threshold it exceeded, and a caller who
  // must get the journal approved learns nothing from the generic form.
  ['APPROVAL_REQUIRED:', 'APPROVAL_REQUIRED'],
];

const SQLSTATE: Readonly<Record<string, ErrorCode>> = {
  '23505': 'VERSION_CONFLICT', // unique_violation — refined below by constraint name
  '23503': 'VALIDATION_FAILED', // foreign_key_violation
  '23514': 'VALIDATION_FAILED', // check_violation
  '23P01': 'VALIDATION_FAILED', // exclusion_violation — overlapping effective-dated rows
  '23001': 'POSTED_IMMUTABLE', // restrict_violation — the immutability guards
  '40001': 'VERSION_CONFLICT', // serialization_failure
  '40P01': 'DEADLOCK_DETECTED', // deadlock_detected
  '55P03': 'LOCK_TIMEOUT', // lock_not_available
  '57014': 'LOCK_TIMEOUT', // query_canceled (statement_timeout)
  '53300': 'DEPENDENCY_UNAVAILABLE', // too_many_connections
  '08006': 'DEPENDENCY_UNAVAILABLE', // connection_failure
  '08003': 'DEPENDENCY_UNAVAILABLE',
  '57P01': 'DEPENDENCY_UNAVAILABLE', // admin_shutdown
};

/** Constraint names whose violation has a more specific meaning than "conflict". */
const CONSTRAINT_CODES: ReadonlyArray<readonly [RegExp, ErrorCode]> = [
  [/_no_overlap$/, 'VALIDATION_FAILED'],
  [/^files_key_is_tenant_scoped$/, 'TENANT_MISMATCH'],
  [/_scope_fk$/, 'CROSS_ENTITY_REFERENCE'],
  [/^vendor_bills_exact_duplicate_idx$/, 'DUPLICATE_SUSPECTED'],
  [/^jl_.*_xor$/, 'VALIDATION_FAILED'],
  [/remaining_quantity/, 'INSUFFICIENT_STOCK'],
  // A maker/checker violation is a segregation-of-duties refusal, not a generic
  // validation failure: the caller is not holding the wrong data, they are the
  // wrong person, and only one of those is fixed by editing the request.
  [/_maker_checker$/, 'SEGREGATION_OF_DUTIES'],
];

export function mapDatabaseError(e: unknown): AppError {
  if (AppError.isAppError(e)) return e;
  if (!isPgError(e)) return internal('Unexpected database failure', e);

  for (const [prefix, code] of GUARD_PREFIXES) {
    if (e.message.startsWith(prefix)) {
      // The guard messages were written to be read by a developer *and* an
      // accountant — they name the rule and the remedy, so they are safe to expose.
      return new AppError(code, e.message.slice(prefix.length).trim(), {
        cause: e,
        safeToExpose: true,
        details: { constraint: e.constraint, table: e.table },
      });
    }
  }

  if (e.constraint) {
    for (const [pattern, code] of CONSTRAINT_CODES) {
      if (pattern.test(e.constraint)) {
        return new AppError(code, describeConstraint(e), {
          cause: e,
          safeToExpose: true,
          details: { constraint: e.constraint, table: e.table },
        });
      }
    }
  }

  const mapped = e.code ? SQLSTATE[e.code] : undefined;
  if (mapped) {
    return new AppError(mapped, describeConstraint(e), {
      cause: e,
      // Never echo `detail` — it contains the conflicting row's values.
      safeToExpose: true,
      details: { sqlstate: e.code, constraint: e.constraint, table: e.table },
    });
  }

  return internal('Database operation failed', e);
}

function describeConstraint(e: PgError): string {
  switch (e.code) {
    case '23505':
      return `A record with these values already exists${e.constraint ? ` (${e.constraint})` : ''}.`;
    case '23503':
      return 'A referenced record does not exist, or is still referenced by another record.';
    case '23514':
      return `A value violates the ${e.constraint ?? 'validity'} rule for this record.`;
    case '23P01':
      return `This period or effective-dated range overlaps an existing one (${e.constraint ?? ''}).`;
    case '40P01':
      return 'The operation deadlocked with a concurrent one and was rolled back. Retry it.';
    case '55P03':
    case '57014':
      return 'The record is locked by a concurrent operation. Retry shortly.';
    case '53300':
    case '08006':
    case '08003':
    case '57P01':
      return 'The database is temporarily unavailable.';
    default:
      return 'The operation could not be completed.';
  }
}

export function isRetryable(e: unknown): boolean {
  if (!isPgError(e) || !e.code) return false;
  return e.code === '40001' || e.code === '40P01';
}
