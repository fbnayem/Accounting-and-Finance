/**
 * Accounting policies and document number sequences.
 *
 * Both are versioned or serialised for the same underlying reason: a historical
 * document must be explainable later. doc 01 rule 7 — "Accounting-affecting settings
 * are versioned. Historical documents retain the effective version used." — and
 * doc 02 — "Posted numbers are never reused."
 */
import { Inject, Injectable } from '@nestjs/common';
import { Pool } from 'pg';
import { AppError, notFound, uuidv7 } from '@acct/domain';
import { publish, recordAudit } from '@acct/database';
import { DATABASE_POOL } from '../common/database.module';
import { readInTenant, writeInTenant } from '../common/db';
import { assertEntityPermission, entityScope, type TenantPrincipal } from '../common/principal';

/** The account-mapping columns a policy version carries (0003_organization.sql). */
const ACCOUNT_COLUMNS = [
  'ar_control_account_id',
  'ap_control_account_id',
  'cash_clearing_account_id',
  'payment_clearing_account_id',
  'retained_earnings_account_id',
  'current_year_earnings_account_id',
  'rounding_account_id',
  'realized_fx_gain_account_id',
  'realized_fx_loss_account_id',
  'unrealized_fx_gain_account_id',
  'unrealized_fx_loss_account_id',
  'bad_debt_account_id',
  'customer_advance_account_id',
  'vendor_advance_account_id',
  'grni_account_id',
  'suspense_account_id',
] as const;

const SCALAR_COLUMNS = [
  'retained_earnings_method',
  'rounding_mode',
  'rounding_tolerance',
  'capitalization_threshold',
  'write_off_approval_threshold',
  'payment_dual_approval_threshold',
  'journal_approval_threshold',
  'three_way_match_tolerance_pct',
  'three_way_match_tolerance_abs',
  'bank_reconciliation_tolerance',
  'ar_aging_buckets',
  'ap_aging_buckets',
  'default_inventory_valuation',
  'allow_negative_stock',
  'closed_period_behaviour',
  'ai_automation_enabled',
] as const;

export type PolicyInput = Partial<
  Record<(typeof ACCOUNT_COLUMNS)[number] | (typeof SCALAR_COLUMNS)[number], unknown>
>;

@Injectable()
export class ConfigurationService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // Accounting policies
  // -------------------------------------------------------------------------

  async listAccountingPolicies(
    principal: TenantPrincipal,
    filters: { legalEntityId?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const scope = entityScope(principal);
      const where = ['p.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];

      if (filters.legalEntityId) {
        assertEntityPermission(principal, 'accounting_policy.view', filters.legalEntityId);
        params.push(filters.legalEntityId);
        where.push(`p.legal_entity_id = $${params.length}`);
      } else if (scope.kind === 'ENTITIES') {
        params.push(scope.legalEntityIds);
        where.push(`p.legal_entity_id = ANY($${params.length}::uuid[])`);
      }

      const { rows } = await client.query(
        `SELECT p.*, p.valid_from::text AS valid_from, p.valid_to::text AS valid_to
           FROM accounting_policies p
          WHERE ${where.join(' AND ')}
          ORDER BY p.legal_entity_id, p.version DESC
          LIMIT 500`,
        params,
      );
      return { data: rows };
    });
  }

  /**
   * doc 01 rule 7: a new version, never an edit.
   *
   * The previous version is closed at the new one's `valid_from`, and the
   * `EXCLUDE USING gist` constraint on `accounting_policies` rejects any overlap
   * the application gets wrong — which is the point of having put it there: this
   * code could have a bug and the database still would not hold two policies
   * effective on the same day.
   */
  async createPolicyVersion(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      accountingBookId?: string | undefined;
      validFrom: string;
      policy: PolicyInput;
    },
  ) {
    assertEntityPermission(principal, 'accounting_policy.configure', input.legalEntityId);

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const entity = await client.query<{ id: string; organization_id: string }>(
        `SELECT id, organization_id FROM legal_entities WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [input.legalEntityId, principal.tenantId],
      );
      if (!entity.rows[0]) throw notFound('Legal entity', input.legalEntityId);

      const { rows: previousRows } = await client.query<Record<string, unknown>>(
        `SELECT * FROM accounting_policies
          WHERE legal_entity_id = $1
            AND accounting_book_id IS NOT DISTINCT FROM $2
          ORDER BY version DESC LIMIT 1
          FOR UPDATE`,
        [input.legalEntityId, input.accountingBookId ?? null],
      );
      const previous = previousRows[0];

      if (previous && String(previous.valid_from) >= input.validFrom) {
        throw new AppError(
          'VALIDATION_FAILED',
          `valid_from must be after the current version's ${String(previous.valid_from)}. ` +
            'A policy version cannot be back-dated over one that documents already used.',
          {
            fieldErrors: [
              {
                field: 'valid_from',
                code: 'OUT_OF_ORDER',
                message: 'must follow the current version',
              },
            ],
          },
        );
      }

      // ADR-0001 §2: the retained-earnings method is immutable once the book has a
      // closed year, because the two methods produce different equity movements and
      // switching mid-history makes the comparatives incomparable.
      if (
        previous &&
        input.policy.retained_earnings_method &&
        input.policy.retained_earnings_method !== previous.retained_earnings_method
      ) {
        const closed = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM accounting_periods
              WHERE legal_entity_id = $1 AND status = 'HARD_CLOSED' LIMIT 1
           ) AS exists`,
          [input.legalEntityId],
        );
        if (closed.rows[0]?.exists) {
          throw new AppError(
            'VALIDATION_FAILED',
            'The retained-earnings method cannot be changed once a period has been hard-closed ' +
              '(ADR-0001 §2). The two methods produce different equity movements, so switching ' +
              'would make the comparatives disagree with the closed year.',
          );
        }
      }

      if (previous) {
        await client.query(`UPDATE accounting_policies SET valid_to = $2::date WHERE id = $1`, [
          previous.id,
          input.validFrom,
        ]);
      }

      const version = previous ? Number(previous.version) + 1 : 1;
      const columns = [...ACCOUNT_COLUMNS, ...SCALAR_COLUMNS].filter(
        (c) => input.policy[c] !== undefined,
      );
      const values = columns.map((c) => input.policy[c]);

      const id = uuidv7();
      const { rows } = await client.query<Record<string, unknown>>(
        `INSERT INTO accounting_policies
           (id, tenant_id, legal_entity_id, accounting_book_id, version, valid_from, created_by
            ${columns.length ? `, ${columns.join(', ')}` : ''})
         VALUES ($1, $2, $3, $4, $5, $6::date, $7
            ${columns.map((_, i) => `, $${i + 8}`).join('')})
         RETURNING *, valid_from::text AS valid_from, valid_to::text AS valid_to`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          input.accountingBookId ?? null,
          version,
          input.validFrom,
          principal.userId,
          ...values,
        ],
      );

      await publish(client, context, {
        eventType: 'accounting_policy.version_created',
        aggregateType: 'accounting_policy',
        aggregateId: id,
        tenantId: principal.tenantId,
        organizationId: entity.rows[0].organization_id,
        legalEntityId: input.legalEntityId,
        payload: { version, valid_from: input.validFrom },
      });
      await recordAudit(client, context, {
        action: 'accounting_policy.version_created',
        resourceType: 'accounting_policy',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        before: previous ?? null,
        after: rows[0]!,
      });

      return rows[0]!;
    });
  }

  // -------------------------------------------------------------------------
  // Number sequences
  // -------------------------------------------------------------------------

  async listNumberSequences(
    principal: TenantPrincipal,
    filters: { legalEntityId?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const scope = entityScope(principal);
      const where = ['s.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];
      if (filters.legalEntityId) {
        assertEntityPermission(principal, 'number_sequence.view', filters.legalEntityId);
        params.push(filters.legalEntityId);
        where.push(`s.legal_entity_id = $${params.length}`);
      } else if (scope.kind === 'ENTITIES') {
        params.push(scope.legalEntityIds);
        where.push(`s.legal_entity_id = ANY($${params.length}::uuid[])`);
      }

      const { rows } = await client.query(
        `SELECT s.id, s.legal_entity_id, s.document_type, s.branch_id, s.fiscal_year_id,
                s.prefix, s.suffix, s.padding, s.next_number::text AS next_number,
                s.reset_rule, s.status,
                (SELECT count(*) FROM number_allocations a WHERE a.number_sequence_id = s.id)::text
                  AS allocated_count
           FROM number_sequences s
          WHERE ${where.join(' AND ')}
          ORDER BY s.document_type
          LIMIT 500`,
        params,
      );
      return { data: rows };
    });
  }

  async createNumberSequence(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      documentType: string;
      branchId?: string | undefined;
      fiscalYearId?: string | undefined;
      prefix?: string | undefined;
      suffix?: string | undefined;
      padding?: number | undefined;
      nextNumber?: number | undefined;
      resetRule?: 'NEVER' | 'ANNUAL' | 'MONTHLY' | undefined;
    },
  ) {
    assertEntityPermission(principal, 'number_sequence.configure', input.legalEntityId);

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO number_sequences (id, tenant_id, legal_entity_id, document_type, branch_id,
                                       fiscal_year_id, prefix, suffix, padding, next_number, reset_rule)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, legal_entity_id, document_type, branch_id, fiscal_year_id, prefix, suffix,
                   padding, next_number::text AS next_number, reset_rule, status`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          input.documentType,
          input.branchId ?? null,
          input.fiscalYearId ?? null,
          input.prefix ?? null,
          input.suffix ?? null,
          input.padding ?? 0,
          input.nextNumber ?? 1,
          input.resetRule ?? 'NEVER',
        ],
      );

      await recordAudit(client, context, {
        action: 'number_sequence.created',
        resourceType: 'number_sequence',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        after: rows[0]!,
      });
      return rows[0]!;
    });
  }
}

// Allocation moved to @acct/ledger in Phase 2 — the posting path needs it and the
// kernel is a package now. Re-exported so the Phase 1 import sites are unaffected.
export { allocateNumber, formatNumber, type AllocatedNumber } from '@acct/ledger';
