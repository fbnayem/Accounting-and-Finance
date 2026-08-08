import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * Identifiers.
 *
 * `journal_lines` is the highest-volume table in the platform — ADR-0009's
 * `large` profile puts 5 M rows in it — and it is keyed by uuid. Random v4 keys
 * scatter inserts across the whole B-tree; v7 keys are time-ordered, so inserts
 * stay in the rightmost pages. That is the difference between an index that fits
 * its working set in cache and one that does not.
 *
 * v7 is used for high-volume append-only rows. v4 remains correct for anything
 * where the creation time must not be inferable from the identifier.
 */

/** UUID v7 — RFC 9562. 48-bit millisecond timestamp, 74 bits of randomness. */
export function uuidv7(now: number = Date.now()): string {
  const bytes = randomBytes(16);
  const ts = BigInt(now);

  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x70; // version 7
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // variant 10

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** UUID v4 — use where the identifier must not leak a creation time. */
export const uuidv4 = (): string => randomUUID();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function uuidVersion(value: string): number | null {
  if (!isUuid(value)) return null;
  return Number.parseInt(value[14] as string, 16);
}

/** Extracts the embedded timestamp from a v7 identifier; null for other versions. */
export function uuidv7Timestamp(value: string): Date | null {
  if (uuidVersion(value) !== 7) return null;
  const hex = value.replace(/-/g, '').slice(0, 12);
  return new Date(Number(BigInt(`0x${hex}`)));
}

/**
 * The namespace for accounting-event identifiers. Fixed, and never regenerated:
 * changing it would make every historical `source_event_id` unreachable, and the
 * whole point of the column is that a replay finds the entry it already made.
 */
const ACCOUNTING_EVENT_NAMESPACE = 'b21b0f1a-6e8e-4a2f-9a2b-1f6a3c5d7e90';

/**
 * A deterministic identifier for an accounting event — RFC 9562 v5 (name-based,
 * SHA-1).
 *
 * `journal_entries.source_event_id` is a **uuid**, and the subledger names its
 * events readably: `invoice.posted:<id>`, `vendor_payment.allocated:<id>:<id>`.
 * Those names are the right thing to write in the code — they say what the event
 * is at every call site — but they are not uuids, and passing one straight to the
 * column is how Phase 3 discovered that not one subledger document could post
 * (F-725).
 *
 * Hashing rather than widening the column keeps the partial unique index, and
 * keeps the property the index exists for: the same event name always produces
 * the same uuid, so a retry lands on the entry that already exists instead of
 * writing a second one.
 */
export function accountingEventId(name: string): string {
  const namespace = Buffer.from(ACCOUNTING_EVENT_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1')
    .update(Buffer.concat([namespace, Buffer.from(name, 'utf8')]))
    .digest();

  const bytes = hash.subarray(0, 16);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // variant 10

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Correlation ID — traverses API, queue and worker so one request is one trace.
 * Phase 0 exit criterion 5. Kept short and URL-safe because it travels in headers,
 * log lines and queue payloads.
 */
export function newCorrelationId(): string {
  return randomBytes(12).toString('base64url');
}

/** Idempotency keys are client-supplied; this is the bound the contract states. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export function isValidIdempotencyKey(key: string): boolean {
  return key.length > 0 && key.length <= IDEMPOTENCY_KEY_MAX_LENGTH && !/[\p{C}]/u.test(key);
}
