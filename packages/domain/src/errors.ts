/**
 * Error taxonomy — doc 21 Phase 0, and the `Error` schema in contracts/openapi.yaml:
 *
 *   required: [code, message, correlation_id]
 *   code: "Stable machine-readable code. Never a stack trace or SQL (doc 15)."
 *
 * Two rules follow from that description and are enforced here rather than by
 * convention:
 *
 *   1. `code` is drawn from a closed set. A new code is a contract change.
 *   2. An error whose message is not safe to show a caller never has its message
 *      serialised. `toResponse()` substitutes a generic one and keeps the detail
 *      for the log, so a leaked SQL fragment is not one careless `throw` away.
 */

export const ERROR_CODES = {
  // --- request ---
  VALIDATION_FAILED: 422,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  MALFORMED_CURSOR: 400,

  // --- identity and authorization (ADR-0005) ---
  UNAUTHENTICATED: 401,
  SESSION_EXPIRED: 401,
  MFA_REQUIRED: 401,
  FORBIDDEN: 403,
  APPROVAL_REQUIRED: 403,
  SEGREGATION_OF_DUTIES: 403,
  TENANT_MISMATCH: 403,
  ENTITY_ACCESS_DENIED: 403,
  ENTITLEMENT_REQUIRED: 403,

  // --- concurrency and idempotency (F-044, ADR-0004) ---
  IN_PROGRESS: 409,
  IDEMPOTENCY_KEY_REUSE: 422,
  PRECONDITION_FAILED: 412,
  VERSION_CONFLICT: 409,
  LOCK_TIMEOUT: 409,
  DEADLOCK_DETECTED: 409,

  // --- accounting invariants ---
  POSTED_IMMUTABLE: 409,
  UNBALANCED_JOURNAL: 422,
  PERIOD_CLOSED: 422,
  PERIOD_NOT_OPEN: 422,
  NO_PERIOD_FOR_DATE: 422,
  CROSS_ENTITY_REFERENCE: 422,
  BOOK_MISMATCH: 422,
  ROUNDING_IMBALANCE: 422,
  POSTING_RULE_MISSING: 422,
  ACCOUNT_NOT_POSTABLE: 422,

  // --- subledger ---
  OVER_ALLOCATION: 422,
  DUPLICATE_SUSPECTED: 409,
  INSUFFICIENT_STOCK: 422,
  NEGATIVE_STOCK_NOT_PERMITTED: 422,
  EXCHANGE_RATE_MISSING: 422,
  TAX_DETERMINATION_FAILED: 422,

  // --- platform ---
  RATE_LIMITED: 429,
  DEPENDENCY_UNAVAILABLE: 503,
  FEATURE_DISABLED: 403,
  NOT_IMPLEMENTED: 501,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export interface FieldError {
  readonly field: string;
  readonly code: string;
  readonly message: string;
}

export interface ErrorResponseBody {
  code: ErrorCode;
  message: string;
  field_errors?: FieldError[];
  correlation_id: string;
}

const GENERIC_MESSAGE: Partial<Record<ErrorCode, string>> = {
  INTERNAL: 'An unexpected error occurred. Quote the correlation ID when reporting it.',
  DEPENDENCY_UNAVAILABLE: 'A dependency is temporarily unavailable. Retry shortly.',
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly fieldErrors: readonly FieldError[];
  readonly details: Readonly<Record<string, unknown>>;
  /** False when the message may contain internals; `toResponse` then substitutes. */
  readonly safeToExpose: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      fieldErrors?: readonly FieldError[];
      details?: Record<string, unknown>;
      cause?: unknown;
      safeToExpose?: boolean;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = ERROR_CODES[code];
    this.fieldErrors = options.fieldErrors ?? [];
    this.details = options.details ?? {};
    this.safeToExpose = options.safeToExpose ?? this.httpStatus < 500;
  }

  toResponse(correlationId: string): ErrorResponseBody {
    const body: ErrorResponseBody = {
      code: this.code,
      message: this.safeToExpose
        ? this.message
        : (GENERIC_MESSAGE[this.code] ?? GENERIC_MESSAGE.INTERNAL!),
      correlation_id: correlationId,
    };
    if (this.fieldErrors.length > 0) body.field_errors = [...this.fieldErrors];
    return body;
  }

  static isAppError(e: unknown): e is AppError {
    return e instanceof AppError;
  }
}

// --- constructors for the cases the contract names explicitly ------------------

export const validationFailed = (
  fieldErrors: readonly FieldError[],
  message = 'Validation failed',
) => new AppError('VALIDATION_FAILED', message, { fieldErrors });

export const notFound = (resource: string, id?: string) =>
  new AppError(
    'NOT_FOUND',
    id ? `${resource} ${id} was not found.` : `${resource} was not found.`,
    {
      details: { resource, id },
    },
  );

export const forbidden = (permission: string) =>
  new AppError('FORBIDDEN', `This action requires the ${permission} permission.`, {
    details: { permission },
  });

export const periodClosed = (periodCode: string, status: string) =>
  new AppError(
    'PERIOD_CLOSED',
    `Accounting period ${periodCode} is ${status}; postings to it are not permitted.`,
    { details: { periodCode, status } },
  );

export const postedImmutable = (resource: string, id: string) =>
  new AppError(
    'POSTED_IMMUTABLE',
    `${resource} ${id} is POSTED and cannot be modified. Correct posted history by ` +
      `reversal, credit note or adjustment.`,
    { details: { resource, id } },
  );

export const unbalancedJournal = (debit: string, credit: string, currency: string) =>
  new AppError(
    'UNBALANCED_JOURNAL',
    `Journal is unbalanced: debits ${debit} ${currency}, credits ${credit} ${currency}.`,
    { details: { debit, credit, currency } },
  );

export const overAllocation = (documentId: string, attempted: string, available: string) =>
  new AppError(
    'OVER_ALLOCATION',
    `Allocation of ${attempted} exceeds the ${available} available on ${documentId}.`,
    { details: { documentId, attempted, available } },
  );

export const duplicateSuspected = (details: Record<string, unknown>) =>
  new AppError(
    'DUPLICATE_SUSPECTED',
    'A document with the same vendor, number, date and amount already exists. ' +
      'Override requires the duplicate-override permission and a reason.',
    { details },
  );

export const idempotencyInProgress = (key: string) =>
  new AppError(
    'IN_PROGRESS',
    `A request with idempotency key ${key} is still in flight. Retry after it completes.`,
    { details: { key } },
  );

export const idempotencyKeyReuse = (key: string) =>
  new AppError(
    'IDEMPOTENCY_KEY_REUSE',
    `Idempotency key ${key} was already used with a different request payload.`,
    { details: { key } },
  );

export const insufficientStock = (itemId: string, requested: string, available: string) =>
  new AppError(
    'INSUFFICIENT_STOCK',
    `Requested ${requested} of item ${itemId}; ${available} is available and the policy ` +
      `does not permit negative stock.`,
    { details: { itemId, requested, available } },
  );

export const internal = (message: string, cause?: unknown) =>
  new AppError('INTERNAL', message, { cause, safeToExpose: false });
