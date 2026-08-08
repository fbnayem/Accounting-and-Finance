/**
 * Document number allocation — ADR-0004 §1.
 *
 * Lives in the ledger package because the posting path allocates the journal entry
 * number and the worker posts scheduled reversals without going through the API.
 * Re-exported from apps/api/src/organization/configuration.service.ts, which is
 * where Phase 1 put it and where the number-sequence routes still live.
 */
import { PoolClient } from 'pg';
import { AppError, notFound } from '@acct/domain';
import { lockSequenceForUpdate } from '@acct/database';

export interface AllocatedNumber {
  readonly sequenceId: string;
  readonly number: number;
  readonly formatted: string;
}

/**
 * Allocates the next document number, inside the caller's transaction.
 *
 * ADR-0004 §1: `SELECT ... FOR UPDATE` on the sequence row, taken as late as
 * possible in the transaction and released at commit. PostgreSQL sequences are
 * explicitly unusable here — they are gap-tolerant by design, and a statutory
 * document series with holes in it is a finding in an audit, not a curiosity.
 *
 * The cost is that concurrent allocations on the same sequence serialise. That is
 * the requirement, not a limitation: "concurrency-safe" and "no gaps" together mean
 * exactly one allocator at a time.
 */
export async function allocateNumber(
  client: PoolClient,
  params: {
    readonly sequenceId: string;
    readonly resourceType: string;
    readonly resourceId: string;
    readonly on?: Date;
  },
): Promise<AllocatedNumber> {
  const sequence = await lockSequenceForUpdate<{
    id: string;
    prefix: string | null;
    suffix: string | null;
    padding: number;
    next_number: string;
    reset_rule: string;
    status: string;
  }>(client, params.sequenceId);
  if (!sequence) throw notFound('Number sequence', params.sequenceId);
  if (sequence.status !== 'ACTIVE') {
    throw new AppError('VALIDATION_FAILED', 'This number sequence is not active.');
  }

  const next = Number(sequence.next_number);
  const formatted = formatNumber(sequence, next, params.on ?? new Date());

  await client.query(`UPDATE number_sequences SET next_number = next_number + 1 WHERE id = $1`, [
    sequence.id,
  ]);
  // doc 02: "Voided/cancelled numbers remain visible in the audit sequence."
  // The allocation row is the audit sequence, so it is written even for documents
  // that are later voided — the number is spent either way.
  await client.query(
    `INSERT INTO number_allocations (number_sequence_id, allocated_number, formatted_number,
                                     resource_type, resource_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [sequence.id, next, formatted, params.resourceType, params.resourceId],
  );

  return { sequenceId: sequence.id, number: next, formatted };
}

/** doc 02: "Configurable pattern: prefix, year/month tokens, branch, counter, padding". */
export function formatNumber(
  sequence: { prefix: string | null; suffix: string | null; padding: number },
  value: number,
  on: Date,
): string {
  const tokens: Record<string, string> = {
    YYYY: String(on.getUTCFullYear()),
    YY: String(on.getUTCFullYear()).slice(-2),
    MM: String(on.getUTCMonth() + 1).padStart(2, '0'),
    DD: String(on.getUTCDate()).padStart(2, '0'),
  };
  const expand = (text: string | null): string =>
    (text ?? '').replace(/\{(YYYY|YY|MM|DD)\}/g, (_, token: string) => tokens[token] ?? '');

  return `${expand(sequence.prefix)}${String(value).padStart(sequence.padding, '0')}${expand(
    sequence.suffix,
  )}`;
}
