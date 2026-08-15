/**
 * Financial statement snapshots — Gate E: "statement snapshot is unchanged by
 * future transactions."
 *
 * Two controls already stood on this table before this service existed, and
 * neither may be weakened to make a route work:
 *
 *   - 0016's `financial_snapshots_immutable` trigger refuses every UPDATE and
 *     DELETE unconditionally;
 *   - 0050's Gate C revocation takes UPDATE and DELETE away from `app_runtime`
 *     as a second, independent reason.
 *
 * The audit's finding follows directly: `approved_by` and `approved_at` are
 * columns on a row that can never be updated, so recording an approval AFTER issue
 * is structurally unreachable — not merely unbuilt. Both routes out of that are
 * implemented here, and neither touches the two controls:
 *
 *   1. **Approval recorded before issue.** `create` accepts an `approval` block and
 *      writes `approved_by`/`approved_at` in the INSERT, which the trigger does not
 *      police. A statement issued already approved is one row, one hash, no
 *      mutation. The segregation rule is enforced NULL-safely: nothing in the
 *      schema stops `approved_by = created_by`, and a comparison against a null
 *      creator is null, so both cases are refused by name.
 *   2. **A separate append-only approval fact.** `recordApproval` writes the
 *      approval to `audit_events` — append-only by trigger, hash-chained, and
 *      DELETE-revoked for `app_runtime` — and emits `financial_statements.approved`.
 *      The snapshot row, its payload and its content hash are byte-for-byte
 *      unchanged; `list` reads the approval from either source, so a snapshot
 *      approved after issue reads as approved without ever having been rewritten.
 *
 * `approveFinancialSnapshot` (F-1003) is not one of this task's operations; the
 * route owner binds it to `recordApproval`.
 */
import { Pool, PoolClient } from 'pg';
import {
  AppError,
  assertEntityPermission,
  assertPermission,
  entityScope,
  notFound,
  uuidv7,
  type TenantPrincipal,
} from '@acct/domain';
import { publish, readInTenant, recordAudit, writeInTenant } from '@acct/database';
import { assertSameEntity, assertSameTenant, loadBook, loadPeriod } from './internals';

/** The audit action that IS the post-issue approval fact. Read by `list`. */
export const SNAPSHOT_APPROVED_ACTION = 'financial_snapshot.approved';

export interface CreateSnapshotInput {
  readonly legalEntityId?: string | undefined;
  readonly consolidationGroupId?: string | undefined;
  readonly accountingBookId?: string | undefined;
  readonly accountingPeriodId: string;
  readonly reportDefinitionId?: string | undefined;
  readonly snapshotType: string;
  readonly parameters?: Record<string, unknown> | undefined;
  /** The statement itself. Hashed by the database; never recomputed in TypeScript. */
  readonly payload: Record<string, unknown>;
  readonly outputFileId?: string | undefined;
  /** Approval recorded at issue — the one moment the immutability trigger permits it. */
  readonly approval?: { readonly approvedBy: string; readonly reason?: string | undefined };
}

export interface ListSnapshotsQuery {
  readonly legalEntityId?: string | undefined;
  readonly accountingPeriodId?: string | undefined;
  readonly snapshotType?: string | undefined;
  readonly includePayload?: boolean | undefined;
}

export class FinancialSnapshotService {
  constructor(private readonly pool: Pool) {}

  /** `createFinancialSnapshot` — POST /financial-statement-snapshots. */
  async create(principal: TenantPrincipal, input: CreateSnapshotInput) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      if (!input.legalEntityId && !input.consolidationGroupId) {
        throw new AppError(
          'VALIDATION_FAILED',
          'A snapshot belongs to a legal entity or to a consolidation group; give one of them.',
          {
            fieldErrors: [
              {
                field: 'legal_entity_id',
                code: 'REQUIRED',
                message: 'legal_entity_id or consolidation_group_id is required',
              },
            ],
          },
        );
      }
      if (input.legalEntityId) {
        assertEntityPermission(principal, 'report.snapshot', input.legalEntityId);
      } else {
        assertPermission(principal, 'report.snapshot');
      }
      if (!input.legalEntityId) {
        // Refused rather than half-issued: `financial_snapshot.created` is a
        // book-scope event, so `publish` requires a legal_entity_id on the
        // envelope (F-041), and a consolidated snapshot has a consolidation group
        // instead. Issuing the row and failing on the event would be worse than
        // refusing — the statement would exist with nothing announcing it. The
        // envelope is a contracts change and consolidation is Phase 7; see
        // INTEGRATION NOTES.
        throw new AppError(
          'NOT_IMPLEMENTED',
          'A consolidated statement snapshot cannot be issued yet: the event envelope carries a ' +
            'legal entity and not a consolidation group (contracts/events.yaml, F-041), and ' +
            'consolidation is Phase 7. Issue the statutory snapshot per legal entity.',
          { safeToExpose: true },
        );
      }

      const period = await loadPeriod(client, input.accountingPeriodId);
      assertSameTenant('Accounting period', principal.tenantId, period.tenant_id);
      if (input.legalEntityId) {
        assertSameEntity('Accounting period', input.legalEntityId, period.legal_entity_id);
      }
      if (input.accountingBookId) {
        const book = await loadBook(client, input.accountingBookId);
        assertSameTenant('Accounting book', principal.tenantId, book.tenant_id);
        if (input.legalEntityId) {
          assertSameEntity('Accounting book', input.legalEntityId, book.legal_entity_id);
        }
      }

      // Approval at issue. Checked before anything is written, so a refused
      // approval never leaves a statement behind that was issued unapproved.
      let approvedBy: string | null = null;
      if (input.approval) {
        approvedBy = assertSnapshotApprover({
          approverId: input.approval.approvedBy,
          creatorId: principal.userId,
          subject: 'this statement',
        });
        await assertUserOfTenant(client, principal.tenantId, approvedBy);
      }

      const payload = JSON.stringify(input.payload);
      const parameters = JSON.stringify(input.parameters ?? {});

      // The hash comes from the database function, not from TypeScript: 0050's
      // `financial_snapshots_content_hash` rejects any other value, because a
      // writer that canonicalises differently from the guard is a control that
      // refuses every legitimate write.
      const { rows: hashRows } = await client.query<{ content_hash: string }>(
        `SELECT financial_snapshot_content_hash($1::jsonb) AS content_hash`,
        [payload],
      );
      const contentHash = hashRows[0]!.content_hash;

      // `fs_identity_uq` is NULLS NOT DISTINCT over the identity tuple, so the next
      // version has to be found the same way — IS NOT DISTINCT FROM, not `=`.
      const { rows: versionRows } = await client.query<{ next_version: number }>(
        `SELECT coalesce(max(version), 0) + 1 AS next_version
           FROM financial_snapshots
          WHERE tenant_id = $1
            AND legal_entity_id IS NOT DISTINCT FROM $2::uuid
            AND consolidation_group_id IS NOT DISTINCT FROM $3::uuid
            AND accounting_book_id IS NOT DISTINCT FROM $4::uuid
            AND accounting_period_id = $5
            AND snapshot_type = $6`,
        [
          principal.tenantId,
          input.legalEntityId ?? null,
          input.consolidationGroupId ?? null,
          input.accountingBookId ?? null,
          input.accountingPeriodId,
          input.snapshotType,
        ],
      );
      const version = versionRows[0]!.next_version;

      const id = uuidv7();
      const { rows } = await client.query<{
        id: string;
        version: number;
        content_hash: string;
        ledger_cutoff_at: string;
        created_at: string;
        approved_by: string | null;
        approved_at: string | null;
      }>(
        `INSERT INTO financial_snapshots
           (id, tenant_id, legal_entity_id, consolidation_group_id, accounting_book_id,
            accounting_period_id, report_definition_id, snapshot_type, version, parameters,
            ledger_cutoff_at, payload, output_file_id, content_hash,
            approved_by, approved_at, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,now(),$11::jsonb,$12,$13,$14,
                 CASE WHEN $14::uuid IS NULL THEN NULL ELSE now() END,$15)
         RETURNING id, version, content_hash, ledger_cutoff_at, created_at, approved_by, approved_at`,
        [
          id,
          principal.tenantId,
          input.legalEntityId ?? null,
          input.consolidationGroupId ?? null,
          input.accountingBookId ?? null,
          input.accountingPeriodId,
          input.reportDefinitionId ?? null,
          input.snapshotType,
          version,
          parameters,
          payload,
          input.outputFileId ?? null,
          contentHash,
          approvedBy,
          principal.userId,
        ],
      );
      const snapshot = rows[0]!;

      await publish(client, context, {
        eventType: 'financial_snapshot.created',
        aggregateType: 'financial_snapshot',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId ?? null,
        accountingBookId: input.accountingBookId ?? null,
        payload: {
          snapshot_type: input.snapshotType,
          accounting_period_id: input.accountingPeriodId,
          version,
          content_hash: contentHash,
          ledger_cutoff_at: snapshot.ledger_cutoff_at,
          approved_by: approvedBy,
        },
      });
      if (approvedBy) {
        await publish(client, context, {
          eventType: 'financial_statements.approved',
          aggregateType: 'financial_snapshot',
          aggregateId: id,
          tenantId: principal.tenantId,
          legalEntityId: input.legalEntityId ?? null,
          payload: {
            approved_by: approvedBy,
            approved_at: snapshot.approved_at,
            content_hash: contentHash,
            recorded: 'AT_ISSUE',
          },
        });
      }
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId ?? null,
        action: 'financial_snapshot.created',
        resourceType: 'financial_snapshot',
        resourceId: id,
        reason: input.approval?.reason ?? null,
        after: {
          snapshot_type: input.snapshotType,
          version,
          content_hash: contentHash,
          approved_by: approvedBy,
        },
      });

      return {
        id: snapshot.id,
        legal_entity_id: input.legalEntityId ?? null,
        consolidation_group_id: input.consolidationGroupId ?? null,
        accounting_book_id: input.accountingBookId ?? null,
        accounting_period_id: input.accountingPeriodId,
        report_definition_id: input.reportDefinitionId ?? null,
        snapshot_type: input.snapshotType,
        version: snapshot.version,
        content_hash: snapshot.content_hash,
        ledger_cutoff_at: snapshot.ledger_cutoff_at,
        created_by: principal.userId,
        created_at: snapshot.created_at,
        approved_by: snapshot.approved_by,
        approved_at: snapshot.approved_at,
        approval_recorded: snapshot.approved_by ? 'AT_ISSUE' : null,
      };
    });
  }

  /** `listFinancialSnapshots` — GET /financial-statement-snapshots. */
  async list(principal: TenantPrincipal, query: ListSnapshotsQuery = {}) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const where = ['s.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];

      if (query.legalEntityId) {
        assertEntityPermission(principal, 'report.view', query.legalEntityId);
        params.push(query.legalEntityId);
        where.push(`s.legal_entity_id = $${params.length}`);
      } else {
        const scope = entityScope(principal);
        if (scope.kind === 'ENTITIES') {
          params.push(scope.legalEntityIds);
          // A consolidated snapshot has no legal_entity_id; an entity-restricted
          // user must not see one, so NULL is excluded rather than passed through.
          where.push(`s.legal_entity_id = ANY($${params.length}::uuid[])`);
        }
      }
      if (query.accountingPeriodId) {
        params.push(query.accountingPeriodId);
        where.push(`s.accounting_period_id = $${params.length}`);
      }
      if (query.snapshotType) {
        params.push(query.snapshotType);
        where.push(`s.snapshot_type = $${params.length}`);
      }
      params.push(SNAPSHOT_APPROVED_ACTION);
      const approvalAction = `$${params.length}`;

      const { rows } = await client.query(
        `SELECT s.id, s.legal_entity_id, s.consolidation_group_id, s.accounting_book_id,
                s.accounting_period_id, p.name AS period_name, s.report_definition_id,
                s.snapshot_type, s.version, s.parameters, s.ledger_cutoff_at,
                s.output_file_id, s.content_hash, s.created_by, s.created_at,
                ${query.includePayload ? 's.payload,' : ''}
                coalesce(s.approved_by::text, fact.actor_id) AS approved_by,
                coalesce(s.approved_at, fact.occurred_at)    AS approved_at,
                CASE WHEN s.approved_by IS NOT NULL THEN 'AT_ISSUE'
                     WHEN fact.actor_id IS NOT NULL THEN 'APPROVAL_FACT'
                     ELSE NULL END AS approval_recorded
           FROM financial_snapshots s
           JOIN accounting_periods p ON p.id = s.accounting_period_id
           LEFT JOIN LATERAL (
             SELECT a.actor_id, a.occurred_at
               FROM audit_events a
              WHERE a.tenant_id = s.tenant_id
                AND a.resource_type = 'financial_snapshot'
                AND a.resource_id = s.id::text
                AND a.action = ${approvalAction}
              ORDER BY a.id DESC LIMIT 1
           ) fact ON true
          WHERE ${where.join(' AND ')}
          ORDER BY s.created_at DESC
          LIMIT 200`,
        params,
      );
      return { data: rows };
    });
  }

  /**
   * The approval of a statement already issued — `approveFinancialSnapshot`.
   *
   * Writes no UPDATE. The fact is the audit row and the emitted event; the
   * snapshot, its payload and its content hash are untouched, which is what keeps
   * Gate E's claim and Gate C's revocation both intact.
   */
  async recordApproval(
    principal: TenantPrincipal,
    snapshotId: string,
    input: { reason?: string | undefined } = {},
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<{
        id: string;
        tenant_id: string;
        legal_entity_id: string | null;
        accounting_book_id: string | null;
        snapshot_type: string;
        version: number;
        content_hash: string;
        created_by: string | null;
        approved_by: string | null;
      }>(
        `SELECT id, tenant_id, legal_entity_id, accounting_book_id, snapshot_type, version,
                content_hash, created_by, approved_by
           FROM financial_snapshots WHERE id = $1`,
        [snapshotId],
      );
      const snapshot = rows[0];
      if (!snapshot) throw notFound('Financial snapshot', snapshotId);
      assertSameTenant('Financial snapshot', principal.tenantId, snapshot.tenant_id);
      if (snapshot.legal_entity_id) {
        assertEntityPermission(principal, 'financial_statement.approve', snapshot.legal_entity_id);
      } else {
        assertPermission(principal, 'financial_statement.approve');
      }

      if (snapshot.approved_by !== null) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Statement ${snapshotId} was already approved when it was issued. A second approval would ` +
            `be a second sign-off on one statement.`,
        );
      }
      const existing = await approvalFactFor(client, principal.tenantId, snapshotId);
      if (existing) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Statement ${snapshotId} was already approved by ${existing.actorId} at ` +
            `${existing.occurredAt}.`,
        );
      }

      assertSnapshotApprover({
        approverId: principal.userId,
        creatorId: snapshot.created_by,
        subject: `statement ${snapshotId}`,
      });

      await publish(client, context, {
        eventType: 'financial_statements.approved',
        aggregateType: 'financial_snapshot',
        aggregateId: snapshotId,
        tenantId: principal.tenantId,
        legalEntityId: snapshot.legal_entity_id,
        accountingBookId: snapshot.accounting_book_id,
        payload: {
          approved_by: principal.userId,
          issued_by: snapshot.created_by,
          content_hash: snapshot.content_hash,
          snapshot_type: snapshot.snapshot_type,
          version: snapshot.version,
          recorded: 'APPROVAL_FACT',
        },
      });
      const audit = await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: snapshot.legal_entity_id,
        action: SNAPSHOT_APPROVED_ACTION,
        resourceType: 'financial_snapshot',
        resourceId: snapshotId,
        reason: input.reason ?? null,
        // No `before`/`after` pair: nothing changed. The fact is that a person
        // approved a hash, and the hash is what ties it to the bytes.
        after: {
          approved_by: principal.userId,
          issued_by: snapshot.created_by,
          content_hash: snapshot.content_hash,
        },
      });

      return {
        financial_snapshot_id: snapshotId,
        approved_by: principal.userId,
        content_hash: snapshot.content_hash,
        approval_recorded: 'APPROVAL_FACT',
        audit_event_id: audit.id,
        audit_row_hash: audit.rowHash,
      };
    });
  }
}

/**
 * The approver is a different person from the issuer, and both are known.
 *
 * Nothing in the schema enforces this — `financial_snapshots` has no maker/checker
 * CHECK at all, and if it had one in the `approved_by <> created_by` shape it would
 * be satisfied by a NULL creator, because that comparison is NULL. Refused
 * explicitly, in both directions, with the reason in the message.
 */
export function assertSnapshotApprover(input: {
  approverId: string | null;
  creatorId: string | null;
  subject: string;
}): string {
  if (input.approverId === null) {
    throw new AppError(
      'SEGREGATION_OF_DUTIES',
      `Approving ${input.subject} records no approving user, so the approval names nobody.`,
    );
  }
  if (input.creatorId === null) {
    throw new AppError(
      'SEGREGATION_OF_DUTIES',
      `${input.subject} records no issuer, so nothing can show that the approver and the person who ` +
        `issued it are different people. An approval against an unknown issuer is not a control.`,
    );
  }
  if (input.creatorId === input.approverId) {
    throw new AppError(
      'SEGREGATION_OF_DUTIES',
      `${input.subject} was issued and approved by the same person. doc 12 separates issuing a ` +
        `statement from approving it, which is why they are different permissions.`,
      { details: { user_id: input.approverId } },
    );
  }
  return input.approverId;
}

async function approvalFactFor(
  client: PoolClient,
  tenantId: string,
  snapshotId: string,
): Promise<{ actorId: string; occurredAt: string } | null> {
  const { rows } = await client.query<{ actor_id: string | null; occurred_at: string }>(
    `SELECT actor_id, occurred_at
       FROM audit_events
      WHERE tenant_id = $1 AND resource_type = 'financial_snapshot' AND resource_id = $2
        AND action = $3
      ORDER BY id DESC LIMIT 1`,
    [tenantId, snapshotId, SNAPSHOT_APPROVED_ACTION],
  );
  const row = rows[0];
  if (!row || row.actor_id === null) return null;
  return { actorId: row.actor_id, occurredAt: row.occurred_at };
}

async function assertUserOfTenant(
  client: PoolClient,
  tenantId: string,
  userId: string,
): Promise<void> {
  const { rows } = await client.query<{ ok: boolean }>(
    `SELECT true AS ok FROM memberships
      WHERE tenant_id = $1 AND user_id = $2 AND status = 'ACTIVE' AND suspended_at IS NULL
      LIMIT 1`,
    [tenantId, userId],
  );
  if (!rows[0]) {
    throw new AppError(
      'VALIDATION_FAILED',
      `The named approver has no active membership of this tenant, so the approval would name ` +
        `somebody who cannot approve anything here.`,
      { details: { user_id: userId } },
    );
  }
}
