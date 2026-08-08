import { AppError } from './errors';

/**
 * Optimistic concurrency for the PATCH routes the contract gives an `If-Match`
 * parameter.
 *
 * Required rather than optional. An optional precondition is one that the client
 * which most needs it — a retrying script — is least likely to send, and the
 * failure is a silent lost update rather than an error.
 */
export function assertVersion(
  current: string,
  ifMatch: string,
  resource: string,
  id: string,
): void {
  const supplied = ifMatch.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  if (supplied === current) return;
  throw new AppError(
    'PRECONDITION_FAILED',
    `${resource} ${id} has changed since you read it (If-Match ${supplied || '(absent)'}, ` +
      `current ${current}). Re-read it and reapply your change.`,
    { details: { resource, id, expected: current, supplied } },
  );
}

/** The `ETag` value a caller should send back in `If-Match`. */
export const etag = (version: string | number): string => `"${version}"`;
