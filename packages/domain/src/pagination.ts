import { AppError } from './errors';

/**
 * Cursor pagination.
 *
 * contracts/openapi.yaml: "Opaque cursor; cursor pagination for all large
 * collections", limit 1..200 default 50. Offset pagination is not offered — on a
 * 500 k-row journal-line list an OFFSET scan degrades linearly and, worse, skips
 * or repeats rows when data changes underneath the user.
 *
 * The cursor is opaque by contract, so its encoding can change; it is signed-free
 * base64url of the sort key plus tiebreaker id, and it is validated on the way in.
 */

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

export interface CursorPayload {
  /** The value of the sort column on the last row of the previous page. */
  readonly k: string;
  /** Tiebreaker — always the row id, so a non-unique sort key still totally orders. */
  readonly id: string;
  /** Sort direction the cursor was issued for; a flipped sort invalidates it. */
  readonly d: 'asc' | 'desc';
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new AppError('MALFORMED_CURSOR', 'The cursor is not valid. Start from the first page.');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as CursorPayload).k !== 'string' ||
    typeof (parsed as CursorPayload).id !== 'string' ||
    ((parsed as CursorPayload).d !== 'asc' && (parsed as CursorPayload).d !== 'desc')
  ) {
    throw new AppError('MALFORMED_CURSOR', 'The cursor is not valid. Start from the first page.');
  }
  return parsed as CursorPayload;
}

export interface PageRequest {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ResolvedPage {
  readonly limit: number;
  readonly after: CursorPayload | null;
}

export function resolvePage(req: PageRequest): ResolvedPage {
  const raw = req.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(raw) || raw < 1 || raw > MAX_PAGE_LIMIT) {
    throw new AppError(
      'VALIDATION_FAILED',
      `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`,
      { fieldErrors: [{ field: 'limit', code: 'OUT_OF_RANGE', message: `1..${MAX_PAGE_LIMIT}` }] },
    );
  }
  return { limit: raw, after: req.cursor ? decodeCursor(req.cursor) : null };
}

export interface PageMeta {
  readonly next_cursor: string | null;
  readonly has_more: boolean;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly meta: PageMeta;
}

/**
 * Builds a page from `limit + 1` rows. Fetching one extra row is what makes
 * `has_more` exact without a second COUNT query — the count would be both slower
 * and wrong by the time it returned.
 */
export function buildPage<T>(
  rows: readonly T[],
  limit: number,
  direction: 'asc' | 'desc',
  toCursorKey: (row: T) => { k: string; id: string },
): Page<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  return {
    data,
    meta: {
      has_more: hasMore,
      next_cursor: hasMore && last ? encodeCursor({ ...toCursorKey(last), d: direction }) : null,
    },
  };
}
