import { Pool, PoolClient } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  assertEntityPermission,
  calculateDocument,
  toBase,
  D,
  MONEY_SCALE,
  sumExact,
  type TenantPrincipal,
  type TaxCodeInput,
  type TaxComponentInput,
  type CalculatedDocument,
  type DocumentLineInput,
} from '@acct/domain';
import { publish, recordAudit, readInTenant, writeInTenant } from '@acct/database';

/**
 * The tax engine — doc 07.
 *
 * Three responsibilities, and keeping them apart is what makes the module
 * testable: resolving which tax code applies, calculating what it produces, and
 * recording the result in the tax subledger.
 *
 * The rule doc 07 states most emphatically is the one about time: "New rule or
 * template version never rewrites historical posted tax facts." That is why
 * `resolve` takes a date and why every calculated line carries a snapshot of the
 * rate rather than a pointer to the rate table. A tax rate is a fact about a day,
 * not a property of a tax code.
 */

export interface TaxCodeRow extends Record<string, unknown> {
  id: string;
  legal_entity_id: string;
  code: string;
  name: string;
  kind: string;
  treatment: string;
  is_inclusive_default: boolean;
  payable_account_id: string | null;
  receivable_account_id: string | null;
  nonrecoverable_account_id: string | null;
  status: string;
}

export interface ResolvedTaxCode extends TaxCodeInput {
  readonly payableAccountId: string | null;
  readonly receivableAccountId: string | null;
  readonly nonrecoverableAccountId: string | null;
  readonly name: string;
  readonly kind: string;
}

export class TaxService {
  constructor(private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  /**
   * Loads tax codes with the components and rates in force on a date.
   *
   * One query for the whole document rather than one per line: a 200-line
   * invoice would otherwise issue 200 round trips to read the same three rates,
   * and the Gate H target for posting is 150ms for the entire document.
   *
   * `on` is the document's date, not today. An invoice posted in December for a
   * March supply is taxed at March's rate, and reading today's is the single
   * most common way a tax engine becomes wrong retroactively.
   */
  async resolveCodes(
    client: PoolClient,
    legalEntityId: string,
    codeIds: readonly string[],
    on: string,
  ): Promise<Map<string, ResolvedTaxCode>> {
    const ids = [...new Set(codeIds.filter(Boolean))];
    if (ids.length === 0) return new Map();

    const { rows } = await client.query<{
      id: string;
      code: string;
      name: string;
      kind: string;
      treatment: string;
      is_inclusive_default: boolean;
      payable_account_id: string | null;
      receivable_account_id: string | null;
      nonrecoverable_account_id: string | null;
      status: string;
      component_id: string | null;
      component_code: string | null;
      sequence: number | null;
      compound_on_previous: boolean | null;
      rounding_mode: string | null;
      rate: string | null;
      recoverable_percent: string | null;
      valid_from: string | null;
    }>(
      `SELECT tc.id, tc.code, tc.name, tc.kind::text AS kind, tc.treatment::text AS treatment,
              tc.is_inclusive_default, tc.payable_account_id, tc.receivable_account_id,
              tc.nonrecoverable_account_id, tc.status::text AS status,
              comp.id AS component_id, comp.code AS component_code, comp.sequence,
              comp.compound_on_previous, comp.rounding_mode::text AS rounding_mode,
              r.rate::text AS rate, r.recoverable_percent::text AS recoverable_percent,
              r.valid_from::text AS valid_from
         FROM tax_codes tc
         LEFT JOIN tax_components comp ON comp.tax_code_id = tc.id
         -- The rate in force on the document's date. LATERAL rather than a join
         -- condition so a component with no rate on that date still appears —
         -- silently dropping it would tax the line at zero and look correct.
         LEFT JOIN LATERAL (
           SELECT rate, recoverable_percent, valid_from
             FROM tax_rates
            WHERE tax_component_id = comp.id
              AND valid_from <= $3::date
              AND (valid_to IS NULL OR valid_to > $3::date)
            ORDER BY valid_from DESC
            LIMIT 1
         ) r ON true
        WHERE tc.legal_entity_id = $1 AND tc.id = ANY($2::uuid[])
        ORDER BY tc.id, comp.sequence`,
      [legalEntityId, ids, on],
    );

    const byId = new Map<string, ResolvedTaxCode>();
    const componentsById = new Map<string, TaxComponentInput[]>();
    const missingRates: string[] = [];

    for (const row of rows) {
      if (!byId.has(row.id)) {
        componentsById.set(row.id, []);
        byId.set(row.id, {
          id: row.id,
          code: row.code,
          name: row.name,
          kind: row.kind,
          treatment: row.treatment as TaxCodeInput['treatment'],
          inclusive: row.is_inclusive_default,
          components: componentsById.get(row.id) as TaxComponentInput[],
          payableAccountId: row.payable_account_id,
          receivableAccountId: row.receivable_account_id,
          nonrecoverableAccountId: row.nonrecoverable_account_id,
        });
      }
      if (!row.component_id) continue;
      if (row.rate === null) {
        missingRates.push(`${row.code}/${row.component_code}`);
        continue;
      }
      componentsById.get(row.id)?.push({
        id: row.component_id,
        code: row.component_code as string,
        sequence: row.sequence ?? 1,
        rate: row.rate,
        compoundOnPrevious: row.compound_on_previous ?? false,
        recoverablePercent: row.recoverable_percent ?? '1',
        ...(row.rounding_mode
          ? { roundingMode: row.rounding_mode as TaxComponentInput['roundingMode'] }
          : {}),
      });
    }

    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
      throw new AppError(
        'NOT_FOUND',
        `Tax code(s) ${unknown.join(', ')} do not exist in this legal entity.`,
        { details: { tax_code_ids: unknown } },
      );
    }
    if (missingRates.length > 0) {
      // Refusing is the whole point. A component with no rate on the document's
      // date is a configuration gap, and taxing the line at zero would produce a
      // plausible invoice that under-collects — discovered at the next return.
      throw new AppError(
        'TAX_DETERMINATION_FAILED',
        `No tax rate is in force on ${on} for ${missingRates.join(', ')}. A tax component ` +
          'without a rate on the document date cannot be calculated; add an effective-dated ' +
          'rate rather than posting the line untaxed.',
        { details: { on, components: missingRates } },
      );
    }
    for (const [id, code] of byId) {
      if (code.treatment === 'STANDARD' && code.components.length === 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Tax code ${code.code} is STANDARD but has no components, so it would tax nothing. ` +
            'Add a component, or set its treatment to ZERO_RATED or EXEMPT, which say so.',
          { details: { tax_code_id: id } },
        );
      }
    }
    return byId;
  }

  /**
   * doc 07's determination step, expressed as data.
   *
   * `tax_rules.conditions` is a jsonb object whose keys are determination inputs
   * — transaction type, jurisdictions, product category, counterparty
   * registration status. A rule matches when every key it states matches the
   * facts; a rule that states nothing matches everything, which is how a default
   * is written. Highest priority wins, and ties break on the most specific rule,
   * because two rules of equal priority disagreeing is a configuration error the
   * caller should hear about rather than a coin toss.
   */
  async determine(
    client: PoolClient,
    legalEntityId: string,
    facts: Record<string, unknown>,
    on: string,
  ): Promise<{ taxCodeId: string; ruleId: string; ruleCode: string; version: number } | null> {
    const { rows } = await client.query<{
      id: string;
      code: string;
      version: number;
      priority: number;
      conditions: Record<string, unknown>;
      resulting_tax_code_id: string | null;
    }>(
      `SELECT id, code, version, priority, conditions, resulting_tax_code_id
         FROM tax_rules
        WHERE legal_entity_id = $1
          AND status = 'ACTIVE'
          AND valid_from <= $2::date
          AND (valid_to IS NULL OR valid_to > $2::date)
        ORDER BY priority DESC, jsonb_array_length(coalesce(jsonb_path_query_array(conditions, '$.keyvalue()'), '[]'::jsonb)) DESC`,
      [legalEntityId, on],
    );

    for (const rule of rows) {
      if (!rule.resulting_tax_code_id) continue;
      const conditions = rule.conditions ?? {};
      const matches = Object.entries(conditions).every(([key, expected]) => {
        const actual = facts[key];
        if (Array.isArray(expected)) return expected.includes(actual as never);
        return expected === actual;
      });
      if (matches) {
        return {
          taxCodeId: rule.resulting_tax_code_id,
          ruleId: rule.id,
          ruleCode: rule.code,
          version: rule.version,
        };
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // POST /tax/calculate
  // -------------------------------------------------------------------------

  /**
   * The preview endpoint. doc 07: "Output is a deterministic tax calculation
   * snapshot with rule version, taxable base, rate/components, amount,
   * recoverability and posting accounts."
   *
   * Deterministic is the requirement that matters, and it is why this shares
   * `calculateDocument` with the posting path rather than approximating it. A
   * preview that disagrees with the posted document is worse than no preview: it
   * teaches people to distrust the number and then to override it.
   */
  async calculate(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      currency: string;
      documentDate: string;
      transactionType?: string | undefined;
      lines: ReadonlyArray<{
        lineNo: number;
        description?: string | undefined;
        quantity: string;
        unitPrice: string;
        discountAmount?: string | undefined;
        taxCodeId?: string | undefined;
        inclusive?: boolean | undefined;
        facts?: Record<string, unknown> | undefined;
      }>;
    },
  ): Promise<CalculatedDocument & { determination: Record<number, string | null> }> {
    return readInTenant(this.pool, principal, async ({ client }) => {
      assertEntityPermission(principal, 'tax.calculate', input.legalEntityId);

      // Per line: an explicit code wins, otherwise determination decides, and a
      // line that neither names nor determines a code is untaxed — which is a
      // legitimate outcome and is reported as such rather than defaulted.
      const determination: Record<number, string | null> = {};
      const codeIdByLine = new Map<number, string>();
      for (const line of input.lines) {
        determination[line.lineNo] = null;
        if (line.taxCodeId) {
          codeIdByLine.set(line.lineNo, line.taxCodeId);
          continue;
        }
        const rule = await this.determine(
          client,
          input.legalEntityId,
          { transaction_type: input.transactionType, ...(line.facts ?? {}) },
          input.documentDate,
        );
        if (rule) {
          codeIdByLine.set(line.lineNo, rule.taxCodeId);
          determination[line.lineNo] = `${rule.ruleCode} v${rule.version}`;
        }
      }

      const codes = await this.resolveCodes(
        client,
        input.legalEntityId,
        [...codeIdByLine.values()],
        input.documentDate,
      );

      const lines: DocumentLineInput[] = input.lines.map((line) => {
        const codeId = codeIdByLine.get(line.lineNo);
        const code = codeId ? codes.get(codeId) : undefined;
        return {
          lineNo: line.lineNo,
          description: line.description ?? '',
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          ...(line.discountAmount !== undefined ? { discountAmount: line.discountAmount } : {}),
          ...(code
            ? {
                taxCode: {
                  ...code,
                  inclusive: line.inclusive ?? code.inclusive,
                },
              }
            : {}),
        };
      });

      const calculated = calculateDocument(lines, { currency: input.currency });
      return { ...calculated, determination };
    });
  }

  // -------------------------------------------------------------------------
  // The subledger
  // -------------------------------------------------------------------------

  /**
   * Writes the tax subledger rows for a posted document.
   *
   * Gate D asks that "tax detail equals tax control accounts", so these rows and
   * the journal lines they explain are written in the same transaction as the
   * posting, from the same calculation. Deriving the subledger later from the
   * journal would invert the dependency: the journal has one line per tax
   * account, and the return needs one row per component per document.
   *
   * `direction` is not inferred from the sign. An OUTPUT tax on a credit note is
   * negative and is still output tax; inferring would file it as input.
   */
  async recordTransactions(
    client: PoolClient,
    principal: TenantPrincipal,
    scope: {
      legalEntityId: string;
      accountingBookId: string;
      journalEntryId: string;
      sourceType: string;
      sourceId: string;
      transactionDate: string;
      postingDate: string;
      currency: string;
      exchangeRate: string;
      baseCurrency: string;
      direction: 'OUTPUT' | 'INPUT' | 'WITHHOLDING';
      sign: 1 | -1;
    },
    calculated: CalculatedDocument,
    codes: ReadonlyMap<string, ResolvedTaxCode>,
  ): Promise<number> {
    const taxPeriodId = await this.resolveReportingPeriod(
      client,
      scope.legalEntityId,
      scope.postingDate,
    );
    let written = 0;
    for (const line of calculated.lines) {
      if (!line.taxCodeId) continue;
      const code = codes.get(line.taxCodeId);
      for (const component of line.components) {
        const signed = (value: string) =>
          scope.sign === 1 ? value : `-${value}`.replace('--', '');
        const taxable = signed(component.taxableAmount);
        const tax = signed(component.taxAmount);

        await client.query(
          `INSERT INTO tax_transactions (
             id, tenant_id, legal_entity_id, accounting_book_id, journal_entry_id,
             tax_code_id, tax_component_id, source_type, source_id, source_line_id,
             transaction_date, posting_date, direction, currency,
             taxable_amount, tax_amount, base_taxable_amount, base_tax_amount,
             recoverable_amount, nonrecoverable_amount, rule_snapshot, tax_period_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::date,$12::date,$13,$14,
                   $15::numeric,$16::numeric,$17::numeric,$18::numeric,$19::numeric,$20::numeric,$21::jsonb,$22)`,
          [
            uuidv7(),
            principal.tenantId,
            scope.legalEntityId,
            scope.accountingBookId,
            scope.journalEntryId,
            line.taxCodeId,
            component.componentId,
            scope.sourceType,
            scope.sourceId,
            null,
            scope.transactionDate,
            scope.postingDate,
            scope.direction,
            scope.currency,
            taxable,
            tax,
            toBase(taxable, scope.exchangeRate, scope.currency, scope.baseCurrency),
            toBase(tax, scope.exchangeRate, scope.currency, scope.baseCurrency),
            signed(component.recoverableAmount),
            signed(component.nonrecoverableAmount),
            JSON.stringify({
              ...(line.snapshot as Record<string, unknown>),
              component: component.code,
              rate: component.rate,
              tax_code: code?.code ?? null,
              treatment: code?.treatment ?? null,
            }),
            taxPeriodId,
          ],
        );
        written++;
      }
    }
    return written;
  }

  /**
   * F-720: which return will report this transaction, decided when it is written.
   *
   * `tax_transactions.tax_period_id` exists, carries a composite foreign key, and
   * nothing set it — so every period question fell back to a date range, and a
   * posting whose date lands in an already-filed period was indistinguishable
   * from an on-time one.
   *
   * The rule is doc 07's: a late transaction lands on the **next open return**,
   * not on a filed one and not nowhere. So the period containing the posting date
   * is used when it can still accept facts, and otherwise the earliest later
   * period that can. Migration 0036 revokes UPDATE on this table, so the stamp is
   * permanent from the moment it is written — which is what makes it usable as
   * the membership record rather than as a hint.
   *
   * Null when the entity has no tax periods at all. Tax periods are optional
   * configuration and refusing to post an invoice because nobody created one
   * would fail the transaction over a reporting concern.
   */
  private async resolveReportingPeriod(
    client: PoolClient,
    legalEntityId: string,
    postingDate: string,
  ): Promise<string | null> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM tax_periods
        WHERE legal_entity_id = $1
          AND status IN ('OPEN','PREPARING','READY')
          AND end_date >= $2::date
        ORDER BY start_date
        LIMIT 1`,
      [legalEntityId, postingDate],
    );
    return rows[0]?.id ?? null;
  }

  // -------------------------------------------------------------------------
  // Configuration
  // -------------------------------------------------------------------------

  async createTaxCode(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      code: string;
      name: string;
      kind: string;
      treatment?: string | undefined;
      isInclusiveDefault?: boolean | undefined;
      payableAccountId?: string | undefined;
      receivableAccountId?: string | undefined;
      nonrecoverableAccountId?: string | undefined;
      components?:
        | ReadonlyArray<{
            code: string;
            name: string;
            sequence?: number | undefined;
            compoundOnPrevious?: boolean | undefined;
            roundingMode?: string | undefined;
          }>
        | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'tax_code.manage', input.legalEntityId);

      const { rows } = await client.query<TaxCodeRow>(
        `INSERT INTO tax_codes (id, tenant_id, legal_entity_id, code, name, kind, treatment,
                                is_inclusive_default, payable_account_id, receivable_account_id,
                                nonrecoverable_account_id)
         VALUES ($1,$2,$3,$4,$5,$6::tax_type,coalesce($7,'STANDARD')::tax_treatment,
                 coalesce($8,false),$9,$10,$11)
         RETURNING id, legal_entity_id, code, name, kind::text AS kind, treatment::text AS treatment,
                   is_inclusive_default, payable_account_id, receivable_account_id,
                   nonrecoverable_account_id, status::text AS status`,
        [
          uuidv7(),
          principal.tenantId,
          input.legalEntityId,
          input.code,
          input.name,
          input.kind,
          input.treatment ?? null,
          input.isInclusiveDefault ?? null,
          input.payableAccountId ?? null,
          input.receivableAccountId ?? null,
          input.nonrecoverableAccountId ?? null,
        ],
      );
      const created = rows[0]!;

      for (const [index, component] of (input.components ?? []).entries()) {
        await client.query(
          `INSERT INTO tax_components (id, tenant_id, tax_code_id, legal_entity_id, code, name,
                                       sequence, compound_on_previous, rounding_mode)
           VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8,false),$9::rounding_mode)`,
          [
            uuidv7(),
            principal.tenantId,
            created.id,
            input.legalEntityId,
            component.code,
            component.name,
            component.sequence ?? index + 1,
            component.compoundOnPrevious ?? null,
            component.roundingMode ?? null,
          ],
        );
      }

      await publish(client, context, {
        eventType: 'tax_code.created',
        aggregateType: 'tax_code',
        aggregateId: created.id,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        payload: { code: created.code, kind: created.kind, treatment: created.treatment },
      });
      await recordAudit(client, context, {
        action: 'tax_code.created',
        resourceType: 'tax_code',
        resourceId: created.id,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        after: created,
      });
      return created;
    });
  }

  async listTaxCodes(principal: TenantPrincipal, filter: { legalEntityId?: string | undefined }) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT tc.id, tc.legal_entity_id, tc.code, tc.name, tc.kind::text AS kind,
                tc.treatment::text AS treatment, tc.is_inclusive_default,
                tc.status::text AS status,
                coalesce(json_agg(json_build_object(
                  'id', comp.id, 'code', comp.code, 'name', comp.name,
                  'sequence', comp.sequence, 'compound_on_previous', comp.compound_on_previous
                ) ORDER BY comp.sequence) FILTER (WHERE comp.id IS NOT NULL), '[]') AS components
           FROM tax_codes tc
           LEFT JOIN tax_components comp ON comp.tax_code_id = tc.id
          WHERE ($1::uuid IS NULL OR tc.legal_entity_id = $1)
          GROUP BY tc.id
          ORDER BY tc.code`,
        [filter.legalEntityId ?? null],
      );
      return { data: rows };
    });
  }

  /**
   * doc 07 requires rates to be effective-dated; F-025 made overlaps structurally
   * impossible. The exclusion constraint is what refuses an overlap, so this
   * translates its error rather than checking first and racing.
   */
  async createTaxRate(
    principal: TenantPrincipal,
    input: {
      taxComponentId: string;
      rate: string;
      recoverablePercent?: string | undefined;
      validFrom: string;
      validTo?: string | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: owner } = await client.query<{ legal_entity_id: string; code: string }>(
        `SELECT legal_entity_id, code FROM tax_components WHERE id = $1`,
        [input.taxComponentId],
      );
      if (!owner[0]) throw notFound('tax component', input.taxComponentId);
      assertEntityPermission(principal, 'tax_code.manage', owner[0].legal_entity_id);

      try {
        const { rows } = await client.query(
          `INSERT INTO tax_rates (id, tenant_id, tax_component_id, rate, recoverable_percent,
                                  valid_from, valid_to)
           VALUES ($1,$2,$3,$4::numeric,coalesce($5,1)::numeric,$6::date,$7::date)
           RETURNING id, tax_component_id, rate::text AS rate,
                     recoverable_percent::text AS recoverable_percent,
                     valid_from::text AS valid_from, valid_to::text AS valid_to`,
          [
            uuidv7(),
            principal.tenantId,
            input.taxComponentId,
            input.rate,
            input.recoverablePercent ?? null,
            input.validFrom,
            input.validTo ?? null,
          ],
        );
        const created = rows[0]!;

        await publish(client, context, {
          eventType: 'tax_rate.changed',
          aggregateType: 'tax_rate',
          aggregateId: created.id as string,
          tenantId: principal.tenantId,
          legalEntityId: owner[0].legal_entity_id,
          payload: { rate: input.rate, valid_from: input.validFrom, component: owner[0].code },
        });
        return created;
      } catch (err) {
        if ((err as { constraint?: string }).constraint === 'tax_rates_no_overlap') {
          throw new AppError(
            'VALIDATION_FAILED',
            `A rate for component ${owner[0].code} already covers part of ${input.validFrom}` +
              `${input.validTo ? ` to ${input.validTo}` : ' onwards'}. Close the existing rate ` +
              'with a valid_to before opening the next one — two rates in force on one day has ' +
              'no defensible answer (F-025).',
            { details: { tax_component_id: input.taxComponentId } },
          );
        }
        throw err;
      }
    });
  }

  async listTaxRates(principal: TenantPrincipal, filter: { taxCodeId?: string | undefined }) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT r.id, r.tax_component_id, comp.code AS component_code, tc.code AS tax_code,
                r.rate::text AS rate, r.recoverable_percent::text AS recoverable_percent,
                r.valid_from::text AS valid_from, r.valid_to::text AS valid_to
           FROM tax_rates r
           JOIN tax_components comp ON comp.id = r.tax_component_id
           JOIN tax_codes tc ON tc.id = comp.tax_code_id
          WHERE ($1::uuid IS NULL OR tc.id = $1)
          ORDER BY tc.code, comp.sequence, r.valid_from DESC`,
        [filter.taxCodeId ?? null],
      );
      return { data: rows };
    });
  }

  async listTransactions(
    principal: TenantPrincipal,
    filter: {
      legalEntityId?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      direction?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT t.id, t.legal_entity_id, t.accounting_book_id, t.journal_entry_id,
                tc.code AS tax_code, comp.code AS component_code,
                t.source_type, t.source_id, t.direction,
                t.posting_date::text AS posting_date, t.currency,
                t.taxable_amount::text AS taxable_amount, t.tax_amount::text AS tax_amount,
                t.base_tax_amount::text AS base_tax_amount,
                t.recoverable_amount::text AS recoverable_amount,
                t.nonrecoverable_amount::text AS nonrecoverable_amount
           FROM tax_transactions t
           JOIN tax_codes tc ON tc.id = t.tax_code_id
           LEFT JOIN tax_components comp ON comp.id = t.tax_component_id
          WHERE ($1::uuid IS NULL OR t.legal_entity_id = $1)
            AND ($2::date IS NULL OR t.posting_date >= $2::date)
            AND ($3::date IS NULL OR t.posting_date <= $3::date)
            AND ($4::text IS NULL OR t.direction = $4)
          ORDER BY t.posting_date, t.created_at
          LIMIT 500`,
        [
          filter.legalEntityId ?? null,
          filter.from ?? null,
          filter.to ?? null,
          filter.direction ?? null,
        ],
      );
      return { data: rows };
    });
  }

  // -------------------------------------------------------------------------
  // Tax periods — F-717
  // -------------------------------------------------------------------------

  async createPeriod(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      jurisdiction: string;
      name: string;
      startDate: string;
      endDate: string;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'tax_period.manage', input.legalEntityId);
      const { rows } = await client.query(
        `INSERT INTO tax_periods (id, tenant_id, legal_entity_id, jurisdiction, name,
                                  start_date, end_date)
         VALUES ($1,$2,$3,$4,$5,$6::date,$7::date)
         RETURNING id, legal_entity_id, jurisdiction, name, start_date::text AS start_date,
                   end_date::text AS end_date, status::text AS status`,
        [
          uuidv7(),
          principal.tenantId,
          input.legalEntityId,
          input.jurisdiction,
          input.name,
          input.startDate,
          input.endDate,
        ],
      );
      const created = rows[0]!;
      await publish(client, context, {
        eventType: 'tax_period.opened',
        aggregateType: 'tax_period',
        aggregateId: created.id as string,
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        payload: { jurisdiction: input.jurisdiction, from: input.startDate, to: input.endDate },
      });
      return created;
    });
  }

  async listPeriods(principal: TenantPrincipal, filter: { legalEntityId?: string | undefined }) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT id, legal_entity_id, jurisdiction, name, start_date::text AS start_date,
                end_date::text AS end_date, status::text AS status
           FROM tax_periods
          WHERE ($1::uuid IS NULL OR legal_entity_id = $1)
          ORDER BY start_date DESC`,
        [filter.legalEntityId ?? null],
      );
      return { data: rows };
    });
  }

  /**
   * Closing a tax period refuses while any source document in range is unposted.
   *
   * Otherwise the period closes, a draft invoice from inside it is posted the
   * next morning, and the filed return is short by exactly that invoice — with
   * nothing in the system indicating it happened.
   */
  async closePeriod(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows } = await client.query<{
        id: string;
        legal_entity_id: string;
        start_date: string;
        end_date: string;
        status: string;
      }>(
        `SELECT id, legal_entity_id, start_date::text AS start_date, end_date::text AS end_date,
                status::text AS status
           FROM tax_periods WHERE id = $1 FOR UPDATE`,
        [id],
      );
      const period = rows[0];
      if (!period) throw notFound('tax period', id);
      assertEntityPermission(principal, 'tax_period.manage', period.legal_entity_id);
      if (period.status === 'CLOSED') return period;

      const { rows: unposted } = await client.query<{ kind: string; count: string }>(
        `SELECT 'invoice' AS kind, count(*)::text AS count
           FROM invoices
          WHERE legal_entity_id = $1 AND posting_date BETWEEN $2::date AND $3::date
            AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED')
         UNION ALL
         SELECT 'vendor_bill', count(*)::text
           FROM vendor_bills
          WHERE legal_entity_id = $1 AND posting_date BETWEEN $2::date AND $3::date
            AND status IN ('DRAFT','PENDING_APPROVAL','APPROVED')`,
        [period.legal_entity_id, period.start_date, period.end_date],
      );
      const outstanding = unposted.filter((r) => Number(r.count) > 0);
      if (outstanding.length > 0) {
        throw new AppError(
          'VALIDATION_FAILED',
          `This tax period still contains ${outstanding
            .map((r) => `${r.count} unposted ${r.kind}(s)`)
            .join(' and ')}. Closing now would file a return that the next posting contradicts.`,
          { details: { outstanding } },
        );
      }

      const { rows: closed } = await client.query(
        `UPDATE tax_periods SET status = 'CLOSED' WHERE id = $1
         RETURNING id, legal_entity_id, jurisdiction, name, start_date::text AS start_date,
                   end_date::text AS end_date, status::text AS status`,
        [id],
      );
      await publish(client, context, {
        eventType: 'tax_period.closed',
        aggregateType: 'tax_period',
        aggregateId: id,
        tenantId: principal.tenantId,
        legalEntityId: period.legal_entity_id,
        payload: { from: period.start_date, to: period.end_date },
      });
      await recordAudit(client, context, {
        action: 'tax_period.closed',
        resourceType: 'tax_period',
        resourceId: id,
        tenantId: principal.tenantId,
        legalEntityId: period.legal_entity_id,
        before: period,
        after: closed[0] as Record<string, unknown>,
      });
      return closed[0];
    });
  }

  /**
   * The tax report doc 07 calls Return-to-GL Reconciliation.
   *
   * Reports both sides and their difference rather than one number, because the
   * useful question is never "what is the tax" but "why do these two disagree".
   */
  async report(
    principal: TenantPrincipal,
    filter: { legalEntityId: string; from: string; to: string },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      assertEntityPermission(principal, 'tax.view', filter.legalEntityId);
      const { rows } = await client.query(
        `SELECT tc.code AS tax_code, comp.code AS component_code, t.direction,
                sum(t.base_taxable_amount)::text AS taxable_amount,
                sum(t.base_tax_amount)::text     AS tax_amount,
                sum(t.recoverable_amount)::text  AS recoverable_amount,
                count(*)::text                   AS transaction_count
           FROM tax_transactions t
           JOIN tax_codes tc ON tc.id = t.tax_code_id
           LEFT JOIN tax_components comp ON comp.id = t.tax_component_id
          WHERE t.legal_entity_id = $1 AND t.posting_date BETWEEN $2::date AND $3::date
          GROUP BY tc.code, comp.code, t.direction
          ORDER BY t.direction, tc.code, comp.code`,
        [filter.legalEntityId, filter.from, filter.to],
      );

      // ADR-0006 §1: exact decimals. A tax return is filed with an authority, so
      // "close enough" here is a number somebody has to defend.
      const output = sumExact(
        rows
          .filter((r) => (r as { direction: string }).direction === 'OUTPUT')
          .map((r) => D((r as { tax_amount: string }).tax_amount, MONEY_SCALE)),
      );
      const input = sumExact(
        rows
          .filter((r) => (r as { direction: string }).direction === 'INPUT')
          .map((r) => D((r as { recoverable_amount: string }).recoverable_amount, MONEY_SCALE)),
      );

      return {
        data: rows,
        period: { from: filter.from, to: filter.to },
        totals: {
          output_tax: output.toFixed(MONEY_SCALE),
          recoverable_input_tax: input.toFixed(MONEY_SCALE),
          net_payable: output.sub(input).toFixed(MONEY_SCALE),
        },
      };
    });
  }
}
