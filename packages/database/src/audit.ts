import { createHash } from 'node:crypto';
import { PoolClient, Pool } from 'pg';
import { RequestContext } from '@acct/domain';

/**
 * Audit helper — doc 21 Phase 0, and F-043: doc 16 calls the audit log
 * "immutable" and the schema blueprint had no mechanism for it.
 *
 * Two mechanisms now, and they catch different attacks:
 *
 *   - A `BEFORE UPDATE OR DELETE` trigger rejects modification. That stops the
 *     application, and anyone with application-level access.
 *   - A hash chain — each row's `row_hash` covers the previous row's — makes a
 *     deletion or edit performed *below* the application detectable, because the
 *     chain no longer verifies. Doc 12's exportable audit trail needs this to mean
 *     anything: an audit export nobody can verify is a document, not evidence.
 *
 * Cheap to add now and impossible to backfill, which is why it is in Phase 0.
 */

export interface AuditEntry {
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId?: string | null;
  readonly tenantId: string;
  readonly organizationId?: string | null;
  readonly legalEntityId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly reason?: string | null;
  readonly metadata?: Record<string, unknown>;
}

/** Fields that must never be written to an audit row, whatever the caller passes. */
const REDACTED = new Set([
  'password',
  'password_hash',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'api_key',
  'private_key',
  'client_secret',
  'card_number',
  'cvv',
  // Connectors never receive database credentials; only secret-manager references
  // are stored (doc 14). This keeps an accidental one out of the permanent record.
  'connection_string',
]);

export function redact(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACTED.has(k.toLowerCase()) ? '[redacted]' : redact(v);
  }
  return out;
}

function rowHash(prev: string | null, canonical: string): string {
  return createHash('sha256')
    .update(prev ?? '', 'utf8')
    .update('\n')
    .update(canonical, 'utf8')
    .digest('hex');
}

/**
 * Appends one audit row inside the caller's transaction.
 *
 * Takes an advisory lock on the tenant so the chain cannot fork: two concurrent
 * appends that both read the same `prev_hash` would produce two rows claiming the
 * same predecessor, and verification could not tell which was authentic. The lock
 * is per tenant, so tenants never contend with each other.
 */
export async function recordAudit(
  client: PoolClient,
  ctx: RequestContext,
  entry: AuditEntry,
): Promise<{ id: string; rowHash: string }> {
  // The single-bigint form: the two-argument overload takes int4 pairs, and
  // hashtextextended returns bigint. Namespacing by prefix rather than by a
  // separate key argument keeps it to one 64-bit space with no truncation.
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('audit:' || $1, 0))`, [
    entry.tenantId,
  ]);

  const { rows: prevRows } = await client.query<{ row_hash: string | null }>(
    `SELECT row_hash FROM audit_events WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1`,
    [entry.tenantId],
  );
  const prevHash = prevRows[0]?.row_hash ?? null;

  const before = entry.before === undefined ? null : redact(entry.before);
  const after = entry.after === undefined ? null : redact(entry.after);

  const canonical = JSON.stringify({
    tenant_id: entry.tenantId,
    organization_id: entry.organizationId ?? null,
    legal_entity_id: entry.legalEntityId ?? null,
    actor_kind: ctx.actorKind ?? 'SYSTEM',
    actor_id: ctx.actorId ?? null,
    impersonated_by: ctx.impersonatedBy ?? null,
    action: entry.action,
    resource_type: entry.resourceType,
    resource_id: entry.resourceId ?? null,
    before,
    after,
    reason: entry.reason ?? null,
    correlation_id: ctx.correlationId,
  });

  const hash = rowHash(prevHash, canonical);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO audit_events (
       tenant_id, organization_id, legal_entity_id,
       actor_kind, actor_id, impersonated_by,
       action, resource_type, resource_id,
       correlation_id, ip_address, user_agent,
       before_data, after_data, reason, metadata,
       prev_hash, row_hash
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     RETURNING id::text AS id`,
    [
      entry.tenantId,
      entry.organizationId ?? ctx.organizationId ?? null,
      entry.legalEntityId ?? ctx.legalEntityId ?? null,
      ctx.actorKind ?? 'SYSTEM',
      ctx.actorId ?? null,
      ctx.impersonatedBy ?? null,
      entry.action,
      entry.resourceType,
      entry.resourceId ?? null,
      ctx.correlationId,
      ctx.ipAddress ?? null,
      ctx.userAgent ?? null,
      before === null ? null : JSON.stringify(before),
      after === null ? null : JSON.stringify(after),
      entry.reason ?? null,
      JSON.stringify(entry.metadata ?? {}),
      prevHash,
      hash,
    ],
  );

  return { id: rows[0]!.id, rowHash: hash };
}

export interface ChainVerification {
  readonly tenantId: string;
  readonly rowsChecked: number;
  readonly valid: boolean;
  readonly firstBreakAt: string | null;
}

/**
 * Walks a tenant's chain and recomputes every hash.
 *
 * This is what makes the audit trail evidence: doc 12 requires an exportable
 * audit trail, and an export is only worth exporting if the recipient can check
 * it. Runs in the Gate D suite and on demand from the audit workspace.
 */
export async function verifyChain(pool: Pool, tenantId: string): Promise<ChainVerification> {
  const { rows } = await pool.query<{
    id: string;
    prev_hash: string | null;
    row_hash: string;
    canonical: string;
  }>(
    `SELECT id::text AS id, prev_hash, row_hash,
            jsonb_build_object(
              'tenant_id', tenant_id,
              'organization_id', organization_id,
              'legal_entity_id', legal_entity_id,
              'actor_kind', actor_kind,
              'actor_id', actor_id,
              'impersonated_by', impersonated_by,
              'action', action,
              'resource_type', resource_type,
              'resource_id', resource_id,
              'before', before_data,
              'after', after_data,
              'reason', reason,
              'correlation_id', correlation_id
            )::text AS canonical
       FROM audit_events
      WHERE tenant_id = $1
      ORDER BY id`,
    [tenantId],
  );

  let prev: string | null = null;
  for (const row of rows) {
    // jsonb reorders keys, so recompute from the same shape the writer used.
    const parsed = JSON.parse(row.canonical) as Record<string, unknown>;
    const canonical = JSON.stringify({
      tenant_id: parsed.tenant_id,
      organization_id: parsed.organization_id ?? null,
      legal_entity_id: parsed.legal_entity_id ?? null,
      actor_kind: parsed.actor_kind,
      actor_id: parsed.actor_id ?? null,
      impersonated_by: parsed.impersonated_by ?? null,
      action: parsed.action,
      resource_type: parsed.resource_type,
      resource_id: parsed.resource_id ?? null,
      before: parsed.before ?? null,
      after: parsed.after ?? null,
      reason: parsed.reason ?? null,
      correlation_id: parsed.correlation_id,
    });
    if (row.prev_hash !== prev || row.row_hash !== rowHash(prev, canonical)) {
      return { tenantId, rowsChecked: rows.length, valid: false, firstBreakAt: row.id };
    }
    prev = row.row_hash;
  }

  return { tenantId, rowsChecked: rows.length, valid: true, firstBreakAt: null };
}
