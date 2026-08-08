/**
 * Fiscal calendar, accounting periods, books and exchange rates.
 *
 * The period lifecycle is the part that matters. Phase 1 exit criterion 3 is
 * "fiscal periods are generated and can be opened/soft-closed/hard-closed according
 * to permission", and doc 02's acceptance criterion is that "a closed period blocks
 * all posting modules consistently" — which is why the close takes the same row lock
 * the posting path takes, in the opposite strength (ADR-0004 §4).
 */
import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { AppError, notFound, uuidv7 } from '@acct/domain';
import { lockPeriodForClose, publish, recordAudit } from '@acct/database';
import { DATABASE_POOL } from '../common/database.module';
import { readInTenant, writeInTenant } from '../common/db';
import { assertEntityPermission, entityScope, type TenantPrincipal } from '../common/principal';

export type PeriodStatus = 'OPEN' | 'SOFT_CLOSED' | 'HARD_CLOSED';

export interface PeriodRow {
  id: string;
  tenant_id: string;
  legal_entity_id: string;
  fiscal_year_id: string;
  period_no: number;
  name: string;
  start_date: string;
  end_date: string;
  is_adjustment: boolean;
  status: PeriodStatus;
  version: string;
}

@Injectable()
export class FinanceSetupService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // Currencies and books
  // -------------------------------------------------------------------------

  async listCurrencies(principal: TenantPrincipal) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT code, name, minor_unit, cash_rounding_increment::text AS cash_rounding_increment,
                symbol, symbol_position, is_active
           FROM currencies WHERE is_active ORDER BY code`,
      );
      return { data: rows };
    });
  }

  async listAccountingBooks(
    principal: TenantPrincipal,
    filters: { legalEntityId?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const scope = entityScope(principal);
      const where = ['b.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];
      if (filters.legalEntityId) {
        assertEntityPermission(principal, 'accounting_book.view', filters.legalEntityId);
        params.push(filters.legalEntityId);
        where.push(`b.legal_entity_id = $${params.length}`);
      } else if (scope.kind === 'ENTITIES') {
        params.push(scope.legalEntityIds);
        where.push(`b.legal_entity_id = ANY($${params.length}::uuid[])`);
      }
      const { rows } = await client.query(
        `SELECT b.id, b.legal_entity_id, b.code, b.name, b.base_currency, b.kind, b.is_primary,
                b.status, b.settings
           FROM accounting_books b
          WHERE ${where.join(' AND ')}
          ORDER BY b.is_primary DESC, b.code
          LIMIT 500`,
        params,
      );
      return { data: rows };
    });
  }

  /**
   * Creates the primary book for an entity.
   *
   * Not an API route in Phase 1 — the setup wizard calls it — but it lives here
   * because `accounting_books.base_currency` is what ADR-0003 makes authoritative
   * for posting, and the rule that the primary book seeds from the entity's
   * functional currency belongs next to the rest of the fiscal setup.
   */
  async createPrimaryBook(
    client: PoolClient,
    principal: TenantPrincipal,
    input: { legalEntityId: string; code?: string; name?: string; baseCurrency?: string },
  ): Promise<{ id: string; base_currency: string }> {
    const { rows: entityRows } = await client.query<{
      functional_currency: string;
      legal_name: string;
    }>(
      `SELECT functional_currency, legal_name FROM legal_entities WHERE id = $1 AND tenant_id = $2`,
      [input.legalEntityId, principal.tenantId],
    );
    const entity = entityRows[0];
    if (!entity) throw notFound('Legal entity', input.legalEntityId);

    const id = uuidv7();
    const { rows } = await client.query<{ id: string; base_currency: string }>(
      `INSERT INTO accounting_books (id, tenant_id, legal_entity_id, code, name, base_currency,
                                     kind, is_primary)
       VALUES ($1, $2, $3, $4, $5, $6, 'PRIMARY', true)
       RETURNING id, base_currency`,
      [
        id,
        principal.tenantId,
        input.legalEntityId,
        input.code ?? 'PRIMARY',
        input.name ?? `${entity.legal_name} — primary book`,
        // F-014: the entity's functional currency is the statutory default that
        // seeds the book. The book's own base currency is what posting uses.
        input.baseCurrency ?? entity.functional_currency,
      ],
    );
    return rows[0]!;
  }

  // -------------------------------------------------------------------------
  // Fiscal years and period generation
  // -------------------------------------------------------------------------

  async listFiscalYears(
    principal: TenantPrincipal,
    filters: { legalEntityId?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const scope = entityScope(principal);
      const where = ['fy.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];
      if (filters.legalEntityId) {
        assertEntityPermission(principal, 'fiscal_year.view', filters.legalEntityId);
        params.push(filters.legalEntityId);
        where.push(`fy.legal_entity_id = $${params.length}`);
      } else if (scope.kind === 'ENTITIES') {
        params.push(scope.legalEntityIds);
        where.push(`fy.legal_entity_id = ANY($${params.length}::uuid[])`);
      }
      const { rows } = await client.query(
        `SELECT fy.id, fy.legal_entity_id, fy.name, fy.start_date::text AS start_date,
                fy.end_date::text AS end_date, fy.status,
                (SELECT count(*) FROM accounting_periods p WHERE p.fiscal_year_id = fy.id)::int
                  AS period_count
           FROM fiscal_years fy
          WHERE ${where.join(' AND ')}
          ORDER BY fy.start_date DESC
          LIMIT 200`,
        params,
      );
      return { data: rows };
    });
  }

  async createFiscalYear(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      name: string;
      startDate: string;
      endDate: string;
      periodLength?: 'MONTHLY' | 'QUARTERLY';
      adjustmentPeriods?: number;
    },
  ) {
    assertEntityPermission(principal, 'fiscal_year.create', input.legalEntityId);

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: entityRows } = await client.query<{ organization_id: string }>(
        `SELECT organization_id FROM legal_entities WHERE id = $1 AND tenant_id = $2`,
        [input.legalEntityId, principal.tenantId],
      );
      if (!entityRows[0]) throw notFound('Legal entity', input.legalEntityId);

      const periods = generatePeriods(input.startDate, input.endDate, {
        length: input.periodLength ?? 'MONTHLY',
        adjustmentPeriods: input.adjustmentPeriods ?? 0,
      });

      const fiscalYearId = uuidv7();
      // F-015's exclusion constraint rejects an overlapping year; this turns the
      // 23P01 into a message that says which year it collided with.
      const overlapping = await client.query<{ name: string }>(
        `SELECT name FROM fiscal_years
          WHERE legal_entity_id = $1 AND daterange(start_date, end_date, '[]') && daterange($2::date, $3::date, '[]')`,
        [input.legalEntityId, input.startDate, input.endDate],
      );
      if (overlapping.rows[0]) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This fiscal year overlaps "${overlapping.rows[0].name}". Fiscal years cannot overlap.`,
          { fieldErrors: [{ field: 'start_date', code: 'OVERLAP', message: 'overlapping year' }] },
        );
      }

      await client.query(
        `INSERT INTO fiscal_years (id, tenant_id, legal_entity_id, name, start_date, end_date)
         VALUES ($1, $2, $3, $4, $5::date, $6::date)`,
        [
          fiscalYearId,
          principal.tenantId,
          input.legalEntityId,
          input.name,
          input.startDate,
          input.endDate,
        ],
      );

      const created: PeriodRow[] = [];
      for (const period of periods) {
        const { rows } = await client.query<PeriodRow>(
          `INSERT INTO accounting_periods (id, tenant_id, legal_entity_id, fiscal_year_id,
                                           period_no, name, start_date, end_date, is_adjustment)
           VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8::date,$9)
           RETURNING id, tenant_id, legal_entity_id, fiscal_year_id, period_no, name,
                     start_date::text AS start_date, end_date::text AS end_date,
                     is_adjustment, status, version::text AS version`,
          [
            uuidv7(),
            principal.tenantId,
            input.legalEntityId,
            fiscalYearId,
            period.periodNo,
            period.name,
            period.startDate,
            period.endDate,
            period.isAdjustment,
          ],
        );
        created.push(rows[0]!);
      }

      // One event per period rather than one for the year. A consumer that reacts
      // to a period opening — a close checklist, a reporting cache — needs the
      // period, and reconstructing twelve from one is work every consumer repeats.
      for (const period of created) {
        await publish(client, context, {
          eventType: 'accounting_period.opened',
          aggregateType: 'accounting_period',
          aggregateId: period.id,
          tenantId: principal.tenantId,
          organizationId: entityRows[0].organization_id,
          legalEntityId: input.legalEntityId,
          payload: {
            fiscal_year_id: fiscalYearId,
            period_no: period.period_no,
            start_date: period.start_date,
            end_date: period.end_date,
            is_adjustment: period.is_adjustment,
          },
        });
      }
      await recordAudit(client, context, {
        action: 'fiscal_year.created',
        resourceType: 'fiscal_year',
        resourceId: fiscalYearId,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        after: {
          name: input.name,
          start_date: input.startDate,
          end_date: input.endDate,
          periods: created.length,
        },
      });

      return {
        id: fiscalYearId,
        legal_entity_id: input.legalEntityId,
        name: input.name,
        start_date: input.startDate,
        end_date: input.endDate,
        periods: created,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Period lifecycle
  // -------------------------------------------------------------------------

  async listPeriods(
    principal: TenantPrincipal,
    filters: { legalEntityId?: string | undefined; fiscalYearId?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const scope = entityScope(principal);
      const where = ['p.tenant_id = $1'];
      const params: unknown[] = [principal.tenantId];
      if (filters.legalEntityId) {
        assertEntityPermission(principal, 'accounting_period.view', filters.legalEntityId);
        params.push(filters.legalEntityId);
        where.push(`p.legal_entity_id = $${params.length}`);
      } else if (scope.kind === 'ENTITIES') {
        params.push(scope.legalEntityIds);
        where.push(`p.legal_entity_id = ANY($${params.length}::uuid[])`);
      }
      if (filters.fiscalYearId) {
        params.push(filters.fiscalYearId);
        where.push(`p.fiscal_year_id = $${params.length}`);
      }
      const { rows } = await client.query(
        `SELECT p.id, p.legal_entity_id, p.fiscal_year_id, p.period_no, p.name,
                p.start_date::text AS start_date, p.end_date::text AS end_date,
                p.is_adjustment, p.status, p.version::text AS version,
                p.closed_at, p.closed_by, p.closed_reason,
                p.reopened_at, p.reopened_by, p.reopened_reason
           FROM accounting_periods p
          WHERE ${where.join(' AND ')}
          ORDER BY p.start_date, p.is_adjustment, p.period_no
          LIMIT 500`,
        params,
      );
      return { data: rows };
    });
  }

  /**
   * The one transition method. soft-close, hard-close and reopen differ in which
   * statuses they accept and which permission they need, and in nothing else —
   * writing them as three copies is how the audit trail ends up inconsistent
   * between them.
   */
  async transitionPeriod(
    principal: TenantPrincipal,
    periodId: string,
    to: PeriodStatus,
    input: { reason?: string | undefined },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      // ADR-0004 §4: FOR UPDATE here, FOR SHARE on the posting path. A post in
      // flight holds the share lock, so the close waits for it rather than closing
      // underneath it — and once the close holds the row, the next post blocks and
      // then sees the closed status. That is doc 02's "closed period blocks all
      // posting modules consistently", enforced by lock strength rather than by
      // each module remembering to check.
      const period = await lockPeriodForClose<PeriodRow & { tenant_id: string }>(client, periodId);
      if (!period || period.tenant_id !== principal.tenantId) {
        throw notFound('Accounting period', periodId);
      }

      const rule = TRANSITIONS[to];
      assertEntityPermission(principal, rule.permission, period.legal_entity_id);

      if (!rule.from.includes(period.status)) {
        throw new AppError(
          'PERIOD_NOT_OPEN',
          `Period ${period.name} is ${period.status}; ${rule.label} requires it to be ` +
            `${rule.from.join(' or ')}.`,
          { details: { period_id: periodId, status: period.status, requested: to } },
        );
      }
      if (rule.requiresReason && !input.reason) {
        // doc 02: "Close/reopen requires permission, reason and audit." All three,
        // not two of them.
        throw new AppError('VALIDATION_FAILED', `${rule.label} requires a reason.`, {
          fieldErrors: [{ field: 'reason', code: 'REQUIRED', message: 'a reason is required' }],
        });
      }

      if (to === 'HARD_CLOSED') await assertEarlierPeriodsClosed(client, period);

      const closing = to !== 'OPEN';
      const { rows } = await client.query<PeriodRow>(
        `UPDATE accounting_periods
            SET status = $2::period_status,
                closed_at   = CASE WHEN $3::boolean THEN now()  ELSE closed_at   END,
                closed_by   = CASE WHEN $3::boolean THEN $4     ELSE closed_by   END,
                closed_reason = CASE WHEN $3::boolean THEN $5   ELSE closed_reason END,
                reopened_at = CASE WHEN $3::boolean THEN reopened_at ELSE now()  END,
                reopened_by = CASE WHEN $3::boolean THEN reopened_by ELSE $4     END,
                reopened_reason = CASE WHEN $3::boolean THEN reopened_reason ELSE $5 END,
                version = version + 1
          WHERE id = $1
          RETURNING id, tenant_id, legal_entity_id, fiscal_year_id, period_no, name,
                    start_date::text AS start_date, end_date::text AS end_date,
                    is_adjustment, status, version::text AS version`,
        [periodId, to, closing, principal.userId, input.reason ?? null],
      );
      const updated = rows[0]!;

      await publish(client, context, {
        eventType: rule.event,
        aggregateType: 'accounting_period',
        aggregateId: periodId,
        tenantId: principal.tenantId,
        legalEntityId: period.legal_entity_id,
        payload: {
          period_no: period.period_no,
          from: period.status,
          to,
          reason: input.reason ?? null,
        },
      });
      await recordAudit(client, context, {
        action: rule.event,
        resourceType: 'accounting_period',
        resourceId: periodId,
        tenantId: principal.tenantId,
        legalEntityId: period.legal_entity_id,
        reason: input.reason ?? null,
        before: { status: period.status },
        after: { status: to },
      });

      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Exchange rates
  // -------------------------------------------------------------------------

  async listExchangeRates(
    principal: TenantPrincipal,
    filters: { from?: string | undefined; to?: string | undefined; on?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const where = ['(r.tenant_id = $1 OR r.tenant_id IS NULL)'];
      const params: unknown[] = [principal.tenantId];
      if (filters.from) {
        params.push(filters.from);
        where.push(`r.from_currency = $${params.length}`);
      }
      if (filters.to) {
        params.push(filters.to);
        where.push(`r.to_currency = $${params.length}`);
      }
      if (filters.on) {
        params.push(filters.on);
        where.push(`r.rate_date <= $${params.length}::date`);
      }
      const { rows } = await client.query(
        `SELECT r.id, r.rate_date::text AS rate_date, r.from_currency, r.to_currency, r.rate_type,
                r.rate::text AS rate, r.source, r.is_manual_override, r.override_reason,
                r.tenant_id IS NULL AS is_platform_rate
           FROM exchange_rates r
          WHERE ${where.join(' AND ')}
          ORDER BY r.rate_date DESC, r.from_currency, r.to_currency
          LIMIT 500`,
        params,
      );
      return { data: rows };
    });
  }

  /**
   * doc 11: "Never update historical rate row in place. Manual override requires
   * permission and audit reason."
   *
   * Both halves are enforced: the insert is always an insert, and the override path
   * demands `exchange_rate.override` on top of `exchange_rate.manage`. The database
   * backs the second half up — `fx_override_has_reason` is a CHECK constraint, so a
   * reasonless override fails even if this code is wrong.
   */
  async createExchangeRate(
    principal: TenantPrincipal,
    input: {
      rateDate: string;
      fromCurrency: string;
      toCurrency: string;
      rateType: 'SPOT' | 'AVERAGE' | 'CLOSING' | 'HISTORICAL';
      rate: string;
      source: string;
      isManualOverride?: boolean;
      overrideReason?: string | undefined;
    },
  ) {
    if (input.isManualOverride) {
      // An x-additional-permissions code (F-503). The route permission answers
      // "may you record rates"; this one answers "may you overrule the provider".
      const holds = principal.grants.some((g) => g.permissions.has('exchange_rate.override'));
      if (!holds) {
        throw new AppError(
          'FORBIDDEN',
          'Overriding a provider rate requires the exchange_rate.override permission (doc 11).',
          { details: { permission: 'exchange_rate.override' } },
        );
      }
    }

    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO exchange_rates (id, tenant_id, rate_date, from_currency, to_currency,
                                     rate_type, rate, source, is_manual_override, override_reason,
                                     created_by)
         VALUES ($1,$2,$3::date,$4,$5,$6,$7::numeric,$8,$9,$10,$11)
         RETURNING id, rate_date::text AS rate_date, from_currency, to_currency, rate_type,
                   rate::text AS rate, source, is_manual_override, override_reason`,
        [
          id,
          principal.tenantId,
          input.rateDate,
          input.fromCurrency,
          input.toCurrency,
          input.rateType,
          input.rate,
          input.source,
          input.isManualOverride ?? false,
          input.overrideReason ?? null,
          principal.userId,
        ],
      );

      await recordAudit(client, context, {
        action: 'exchange_rate.created',
        resourceType: 'exchange_rate',
        resourceId: id,
        tenantId: principal.tenantId,
        reason: input.overrideReason ?? null,
        after: rows[0]!,
      });
      return rows[0]!;
    });
  }
}

// ---------------------------------------------------------------------------
// Period transition rules
// ---------------------------------------------------------------------------

const TRANSITIONS: Record<
  PeriodStatus,
  {
    from: PeriodStatus[];
    permission: string;
    event:
      | 'accounting_period.soft_closed'
      | 'accounting_period.hard_closed'
      | 'accounting_period.reopened';
    label: string;
    requiresReason: boolean;
  }
> = {
  SOFT_CLOSED: {
    from: ['OPEN'],
    permission: 'accounting_period.soft_close',
    event: 'accounting_period.soft_closed',
    label: 'soft close',
    // doc 01: SOFT_CLOSED still admits privileged posting, so it is reversible and
    // a reason is courteous rather than required.
    requiresReason: false,
  },
  HARD_CLOSED: {
    from: ['OPEN', 'SOFT_CLOSED'],
    permission: 'accounting_period.hard_close',
    event: 'accounting_period.hard_closed',
    label: 'hard close',
    requiresReason: true,
  },
  OPEN: {
    from: ['SOFT_CLOSED', 'HARD_CLOSED'],
    permission: 'accounting_period.reopen',
    event: 'accounting_period.reopened',
    label: 'reopen',
    requiresReason: true,
  },
};

/**
 * A period cannot be hard-closed while an earlier one in the same year still
 * accepts postings.
 *
 * "Still accepts postings" means anything short of HARD_CLOSED, and SOFT_CLOSED
 * counts: doc 01 defines it as "only privileged/approved posting", which is fewer
 * postings, not none. Checking only for OPEN would leave the rule's own
 * justification unmet — a privileged posting into a soft-closed January would still
 * move the opening balances of a February that had been declared final.
 *
 * Regular periods only. Adjustment periods overlap the last regular period by
 * design (F-011) and are closed alongside it.
 */
async function assertEarlierPeriodsClosed(client: PoolClient, period: PeriodRow): Promise<void> {
  if (period.is_adjustment) return;
  const { rows } = await client.query<{ name: string; status: string }>(
    `SELECT name, status FROM accounting_periods
      WHERE legal_entity_id = $1
        AND fiscal_year_id = $2
        AND NOT is_adjustment
        AND period_no < $3
        AND status <> 'HARD_CLOSED'
      ORDER BY period_no
      LIMIT 1`,
    [period.legal_entity_id, period.fiscal_year_id, period.period_no],
  );
  if (rows[0]) {
    throw new AppError(
      'PERIOD_NOT_OPEN',
      `${rows[0].name} is ${rows[0].status} and can still receive postings. Periods are ` +
        `hard-closed in order, because a posting into an earlier one would move the opening ` +
        `balances ${period.name} was signed off against.`,
      { details: { blocking_period: rows[0].name, blocking_status: rows[0].status } },
    );
  }
}

// ---------------------------------------------------------------------------
// Period generation
// ---------------------------------------------------------------------------

export interface GeneratedPeriod {
  readonly periodNo: number;
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly isAdjustment: boolean;
}

/**
 * doc 02: "Create monthly standard periods and optional adjustment periods."
 *
 * Calendar arithmetic on `YYYY-MM-DD` strings via UTC, never on local `Date`s: a
 * period boundary computed in a zone behind UTC lands on the previous day, and a
 * period boundary that is one day out silently reassigns every transaction on it.
 * Adjustment periods share period 12's end date, which is why the exclusion
 * constraint in 0004 covers regular periods only.
 */
export function generatePeriods(
  startDate: string,
  endDate: string,
  options: { length: 'MONTHLY' | 'QUARTERLY'; adjustmentPeriods: number },
): GeneratedPeriod[] {
  const start = Date.UTC(
    Number(startDate.slice(0, 4)),
    Number(startDate.slice(5, 7)) - 1,
    Number(startDate.slice(8, 10)),
  );
  const end = Date.UTC(
    Number(endDate.slice(0, 4)),
    Number(endDate.slice(5, 7)) - 1,
    Number(endDate.slice(8, 10)),
  );
  if (!(end > start)) {
    throw new AppError('VALIDATION_FAILED', 'end_date must be after start_date.', {
      fieldErrors: [
        { field: 'end_date', code: 'OUT_OF_ORDER', message: 'must be after start_date' },
      ],
    });
  }

  const step = options.length === 'QUARTERLY' ? 3 : 1;
  const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
  const dayBefore = (ms: number): number => ms - 86_400_000;

  const periods: GeneratedPeriod[] = [];
  let cursor = start;
  let periodNo = 1;

  while (cursor <= end && periodNo <= 24) {
    const date = new Date(cursor);
    const nextStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + step, date.getUTCDate());
    // The final period ends on the fiscal year's end date even when that is not a
    // whole month — a 53-week or short first year is normal and must not spill.
    const periodEnd = Math.min(dayBefore(nextStart), end);
    periods.push({
      periodNo,
      name: monthName(cursor, options.length, step),
      startDate: iso(cursor),
      endDate: iso(periodEnd),
      isAdjustment: false,
    });
    cursor = nextStart;
    periodNo++;
  }

  // F-011: adjustment periods deliberately overlap the last regular period. They
  // carry audit and year-end entries that must not move the trading months.
  for (let i = 1; i <= options.adjustmentPeriods; i++) {
    const last = periods[periods.length - 1]!;
    periods.push({
      periodNo: periods.filter((p) => !p.isAdjustment).length + i,
      name: `Adjustment ${i}`,
      startDate: last.endDate,
      endDate: last.endDate,
      isAdjustment: true,
    });
  }

  return periods;
}

function monthName(ms: number, length: 'MONTHLY' | 'QUARTERLY', step: number): string {
  const date = new Date(ms);
  const month = date.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const year = date.getUTCFullYear();
  if (length === 'MONTHLY') return `${month} ${year}`;
  return `Q${Math.floor(date.getUTCMonth() / step) + 1} ${year}`;
}
