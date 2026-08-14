import { Pool } from 'pg';
import { AppError, uuidv7, D, assertEntityPermission, type TenantPrincipal } from '@acct/domain';
import { writeInTenant, readInTenant, recordAudit, publish } from '@acct/database';

/**
 * Forecasts — doc 10: "Forecast data can be used in reports but never changes
 * ledger."
 *
 * That sentence is enforced by shape, not by discipline: `forecast_versions`
 * has no accounting_entry_id column (0014, by design), nothing here imports a
 * posting service, and a forecast line's only consumer is a report. What this
 * service adds is versioning — a forecast is a snapshot of an expectation on a
 * date, and re-forecasting supersedes the old snapshot rather than editing it,
 * for the same reason budgets version: "what did we expect in March" must stay
 * answerable in December.
 */

/** Mirrors the CHECK on budgets.scenario, which forecasts share by convention. */
const SCENARIOS = new Set(['BASE', 'BEST', 'WORST', 'CUSTOM']);

export class ForecastsService {
  constructor(private readonly pool: Pool) {}

  async createForecast(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      accountingBookId: string;
      fiscalYearId: string;
      name: string;
      asOfDate: string;
      currency: string;
      scenario?: string | undefined;
      lines: readonly {
        accountingPeriodId: string;
        accountId: string;
        amount: string;
      }[];
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'forecast.manage', input.legalEntityId);

      const scenario = input.scenario ?? 'BASE';
      if (!SCENARIOS.has(scenario)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${scenario}" is not a forecast scenario: ${[...SCENARIOS].join(', ')}.`,
        );
      }
      if (input.lines.length === 0) {
        throw new AppError('VALIDATION_FAILED', 'A forecast needs at least one line.');
      }
      for (const line of input.lines) {
        // Parsed before the INSERT: a malformed amount is a 422 naming itself,
        // not a numeric-cast error surfacing as a 500 (F-810).
        D(line.amount);
      }

      // Same check budgets make, same reason: a line pointing at another fiscal
      // year's period would never meet the actuals it is compared against.
      const periodIds = [...new Set(input.lines.map((l) => l.accountingPeriodId))];
      const { rows: periods } = await client.query<{ id: string }>(
        `SELECT id FROM accounting_periods WHERE id = ANY($1::uuid[]) AND fiscal_year_id = $2`,
        [periodIds, input.fiscalYearId],
      );
      const valid = new Set(periods.map((p) => p.id));
      const stray = periodIds.filter((p) => !valid.has(p));
      if (stray.length > 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          `${stray.length} forecast line period(s) do not belong to the forecast's fiscal year.`,
          { details: { accounting_period_ids: stray } },
        );
      }

      // Superseding first, then publishing the new version immediately: the
      // contract routes creation only, and doc 10 says forecasts never change
      // the ledger — there is nothing an approval step here would protect, and
      // a DRAFT that no route can publish would be dead data.
      const { rows: superseded } = await client.query<{ id: string }>(
        `UPDATE forecast_versions SET status = 'SUPERSEDED'
          WHERE legal_entity_id = $1 AND accounting_book_id = $2 AND name = $3
            AND status = 'PUBLISHED'
        RETURNING id`,
        [input.legalEntityId, input.accountingBookId, input.name],
      );

      const { rows: versions } = await client.query<{ next: number }>(
        `SELECT coalesce(max(version), 0) + 1 AS next FROM forecast_versions
          WHERE legal_entity_id = $1 AND accounting_book_id = $2 AND name = $3`,
        [input.legalEntityId, input.accountingBookId, input.name],
      );
      const version = versions[0]!.next;

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO forecast_versions
           (id, tenant_id, legal_entity_id, accounting_book_id, fiscal_year_id, name, version,
            scenario, as_of_date, status, published_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,'PUBLISHED',now())
         RETURNING id, legal_entity_id, accounting_book_id, fiscal_year_id, name, version,
                   scenario, as_of_date::text AS as_of_date, status, published_at, created_at`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          input.accountingBookId,
          input.fiscalYearId,
          input.name,
          version,
          scenario,
          input.asOfDate,
        ],
      );

      for (const line of input.lines) {
        await client.query(
          `INSERT INTO forecast_lines
             (id, forecast_version_id, tenant_id, legal_entity_id, accounting_period_id,
              account_id, amount, currency)
           VALUES ($1,$2,$3,$4,$5,$6,$7::numeric,$8)`,
          [
            uuidv7(),
            id,
            principal.tenantId,
            input.legalEntityId,
            line.accountingPeriodId,
            line.accountId,
            D(line.amount).toString(),
            input.currency,
          ],
        );
      }

      await publish(client, context, {
        eventType: 'forecast.snapshot_created',
        aggregateType: 'forecast_version',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        accountingBookId: input.accountingBookId,
        payload: {
          name: input.name,
          version,
          as_of_date: input.asOfDate,
          superseded: superseded.map((s) => s.id),
        },
      });
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'forecast.snapshot_created',
        resourceType: 'forecast_version',
        resourceId: id,
        after: rows[0] as Record<string, unknown>,
      });

      return { ...rows[0], line_count: input.lines.length };
    });
  }

  /** F-814: `{ data }`, never a bare array — see BankAccountsService.listAccounts. */
  async listForecasts(
    principal: TenantPrincipal,
    query: {
      legalEntityId?: string | undefined;
      accountingBookId?: string | undefined;
      fiscalYearId?: string | undefined;
      name?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT f.id, f.legal_entity_id, f.accounting_book_id, f.fiscal_year_id, f.name,
                f.version, f.scenario, f.as_of_date::text AS as_of_date, f.status,
                f.published_at, f.created_at,
                (SELECT coalesce(sum(l.amount), 0)::text FROM forecast_lines l
                  WHERE l.forecast_version_id = f.id) AS total_amount,
                (SELECT count(*) FROM forecast_lines l
                  WHERE l.forecast_version_id = f.id)::int AS line_count
           FROM forecast_versions f
          WHERE ($1::uuid IS NULL OR f.legal_entity_id = $1)
            AND ($2::uuid IS NULL OR f.accounting_book_id = $2)
            AND ($3::uuid IS NULL OR f.fiscal_year_id = $3)
            AND ($4::text IS NULL OR f.name = $4)
          ORDER BY f.name, f.version DESC`,
        [
          query.legalEntityId ?? null,
          query.accountingBookId ?? null,
          query.fiscalYearId ?? null,
          query.name ?? null,
        ],
      );
      return { data: rows };
    });
  }
}
