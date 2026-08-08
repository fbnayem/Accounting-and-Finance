import type { PoolClient } from 'pg';
import { buildPage, resolvePage, type Page, type PageRequest } from '@acct/domain';

/**
 * Cursor pagination, assembled once.
 *
 * contracts/openapi.yaml specifies cursor pagination for every large collection and
 * offers no offset alternative. The reason is in `@acct/domain/pagination`: an
 * OFFSET scan degrades linearly and, worse, skips or repeats rows when data changes
 * underneath the reader — which on a journal-line list means a report that silently
 * omits a transaction.
 *
 * Every list route here goes through this helper so the tie-breaking, the
 * `limit + 1` probe and the direction handling are written once rather than
 * approximated eleven times.
 */
export interface ListSpec {
  /** The SELECT list and FROM/JOIN clauses, without WHERE, ORDER BY or LIMIT. */
  readonly select: string;
  /** Conditions that always apply, already parameterised. */
  readonly where: readonly string[];
  readonly params: readonly unknown[];
  /** The sort column, qualified. Must be unique-per-row when paired with `idColumn`. */
  readonly sortColumn: string;
  readonly idColumn: string;
  readonly direction?: 'asc' | 'desc';
}

export async function listWithCursor<T extends Record<string, unknown>>(
  client: PoolClient,
  spec: ListSpec,
  request: PageRequest,
): Promise<Page<T>> {
  const { limit, after } = resolvePage(request);
  const direction = spec.direction ?? 'asc';
  const params = [...spec.params];
  const where = [...spec.where];

  if (after) {
    if (after.d !== direction) {
      // The cursor was issued for the other sort order. Continuing would silently
      // skip or repeat a page, so it is refused rather than reinterpreted.
      const { AppError } = await import('@acct/domain');
      throw new AppError(
        'MALFORMED_CURSOR',
        'This cursor was issued for a different sort order. Start from the first page.',
      );
    }
    // Row-value comparison, so the tiebreaker is applied by the database rather
    // than by an OR chain that no index can serve.
    const comparison = direction === 'asc' ? '>' : '<';
    params.push(after.k, after.id);
    where.push(
      `(${spec.sortColumn}, ${spec.idColumn}) ${comparison} ($${params.length - 1}, $${params.length})`,
    );
  }

  params.push(limit + 1);
  const sql = `${spec.select}
     WHERE ${where.join(' AND ')}
     ORDER BY ${spec.sortColumn} ${direction.toUpperCase()}, ${spec.idColumn} ${direction.toUpperCase()}
     LIMIT $${params.length}`;

  const { rows } = await client.query<T>(sql, params);
  return buildPage<T>(rows, limit, direction, (row) => ({
    k: String(row['cursor_key'] ?? ''),
    id: String(row['id'] ?? ''),
  }));
}

/** The response envelope every list route returns. */
export function pageResponse<T extends Record<string, unknown>>(
  page: Page<T>,
  map: (row: T) => Record<string, unknown>,
): Record<string, unknown> {
  return {
    data: page.data.map(map),
    meta: { next_cursor: page.meta.next_cursor, has_more: page.meta.has_more },
  };
}
