import { Pool } from 'pg';
import { AppError, uuidv7, D, assertEntityPermission, type TenantPrincipal } from '@acct/domain';
import { writeInTenant, readInTenant, recordAudit } from '@acct/database';

/**
 * Asset categories — doc 09 "Asset category", added by F-904.
 *
 * The category is the only place the assets module maps to the GL: cost,
 * accumulated depreciation and depreciation expense are NOT NULL on the table,
 * and every posting this package makes reads its accounts from here. F-904's
 * finding was that without this route `POST /assets` could never succeed, so
 * exit criteria 4 and 5 had nothing to test against.
 */

const METHODS = new Set(['STRAIGHT_LINE', 'DECLINING_BALANCE', 'UNITS_OF_PRODUCTION', 'CUSTOM']);
const PRORATIONS = new Set(['EXACT_DAYS', 'FULL_MONTH', 'HALF_MONTH', 'MONTHLY', 'NONE']);

export class AssetCategoriesService {
  constructor(private readonly pool: Pool) {}

  async createCategory(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      code: string;
      name: string;
      assetAccountId: string;
      accumulatedDepreciationAccountId: string;
      depreciationExpenseAccountId: string;
      impairmentLossAccountId?: string | null | undefined;
      accumulatedImpairmentAccountId?: string | null | undefined;
      revaluationSurplusAccountId?: string | null | undefined;
      gainAccountId?: string | null | undefined;
      lossAccountId?: string | null | undefined;
      cipAccountId?: string | null | undefined;
      defaultMethod?: string | undefined;
      defaultUsefulLifeMonths?: number | null | undefined;
      defaultProration?: string | undefined;
      residualValuePolicy?: string | null | undefined;
      capitalizationThreshold?: string | null | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'asset_category.manage', input.legalEntityId);

      const method = input.defaultMethod ?? 'STRAIGHT_LINE';
      if (!METHODS.has(method)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${method}" is not a depreciation method. The schema names: ${[...METHODS].join(', ')}.`,
        );
      }
      const proration = input.defaultProration ?? 'MONTHLY';
      if (!PRORATIONS.has(proration)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${proration}" is not a proration convention. The schema names: ${[...PRORATIONS].join(', ')}.`,
        );
      }
      if (
        input.defaultUsefulLifeMonths !== undefined &&
        input.defaultUsefulLifeMonths !== null &&
        (!Number.isInteger(input.defaultUsefulLifeMonths) || input.defaultUsefulLifeMonths <= 0)
      ) {
        throw new AppError(
          'VALIDATION_FAILED',
          `A default useful life of ${input.defaultUsefulLifeMonths} months has no schedule.`,
        );
      }
      // Parsed rather than passed through: an unparseable threshold would
      // otherwise surface as a numeric cast error at INSERT.
      const threshold = input.capitalizationThreshold ? D(input.capitalizationThreshold) : null;
      if (threshold?.isNegative()) {
        throw new AppError('VALIDATION_FAILED', 'A capitalization threshold cannot be negative.');
      }

      // Every account named here becomes a posting destination — cost on
      // capitalize, accumulated on the run, gain/loss on disposal. A heading or
      // another entity's account would produce a journal that fails later and
      // further from the mistake, so all of them are checked at the door
      // (banking's F-033 pattern for its GL mapping).
      const accountIds = [
        input.assetAccountId,
        input.accumulatedDepreciationAccountId,
        input.depreciationExpenseAccountId,
        input.impairmentLossAccountId,
        input.accumulatedImpairmentAccountId,
        input.revaluationSurplusAccountId,
        input.gainAccountId,
        input.lossAccountId,
        input.cipAccountId,
      ].filter((id): id is string => id != null);
      const { rows: accounts } = await client.query<{ id: string; is_posting: boolean }>(
        `SELECT id, is_posting FROM accounts WHERE id = ANY($1::uuid[]) AND legal_entity_id = $2`,
        [accountIds, input.legalEntityId],
      );
      const byId = new Map(accounts.map((a) => [a.id, a]));
      for (const id of accountIds) {
        const account = byId.get(id);
        if (!account) {
          throw new AppError(
            'VALIDATION_FAILED',
            `Account ${id} does not exist in this legal entity. A category maps only to its own ` +
              `entity's accounts.`,
            { details: { account_id: id } },
          );
        }
        if (!account.is_posting) {
          throw new AppError(
            'ACCOUNT_NOT_POSTABLE',
            `Account ${id} is a heading. Every category account is a posting destination.`,
            { details: { account_id: id } },
          );
        }
      }

      const { rows: existing } = await client.query(
        `SELECT id FROM asset_categories WHERE legal_entity_id = $1 AND code = $2`,
        [input.legalEntityId, input.code],
      );
      if (existing[0]) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Category code "${input.code}" already exists in this legal entity.`,
          { details: { code: input.code } },
        );
      }

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO asset_categories
           (id, tenant_id, legal_entity_id, code, name,
            asset_account_id, accumulated_depreciation_account_id,
            depreciation_expense_account_id, impairment_loss_account_id,
            accumulated_impairment_account_id, revaluation_surplus_account_id,
            gain_account_id, loss_account_id, cip_account_id,
            default_method, default_useful_life_months, default_proration,
            residual_value_policy, capitalization_threshold)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING id, legal_entity_id, code, name, asset_account_id,
                   accumulated_depreciation_account_id, depreciation_expense_account_id,
                   impairment_loss_account_id, accumulated_impairment_account_id,
                   revaluation_surplus_account_id, gain_account_id, loss_account_id,
                   cip_account_id, default_method::text AS default_method,
                   default_useful_life_months, default_proration::text AS default_proration,
                   residual_value_policy, capitalization_threshold::text AS capitalization_threshold,
                   status::text AS status`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          input.code,
          input.name,
          input.assetAccountId,
          input.accumulatedDepreciationAccountId,
          input.depreciationExpenseAccountId,
          input.impairmentLossAccountId ?? null,
          input.accumulatedImpairmentAccountId ?? null,
          input.revaluationSurplusAccountId ?? null,
          input.gainAccountId ?? null,
          input.lossAccountId ?? null,
          input.cipAccountId ?? null,
          method,
          input.defaultUsefulLifeMonths ?? null,
          proration,
          input.residualValuePolicy ?? null,
          threshold?.toString() ?? null,
        ],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        legalEntityId: input.legalEntityId,
        action: 'asset_category.created',
        resourceType: 'asset_category',
        resourceId: id,
        after: rows[0] as Record<string, unknown>,
      });

      return rows[0];
    });
  }

  /** F-814: every list in this package returns the `{ data }` envelope. */
  async listCategories(principal: TenantPrincipal, query: { legalEntityId?: string | undefined }) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT id, legal_entity_id, code, name, asset_account_id,
                accumulated_depreciation_account_id, depreciation_expense_account_id,
                impairment_loss_account_id, accumulated_impairment_account_id,
                revaluation_surplus_account_id, gain_account_id, loss_account_id, cip_account_id,
                default_method::text AS default_method, default_useful_life_months,
                default_proration::text AS default_proration, residual_value_policy,
                capitalization_threshold::text AS capitalization_threshold,
                status::text AS status
           FROM asset_categories
          WHERE ($1::uuid IS NULL OR legal_entity_id = $1)
            AND status = 'ACTIVE'
          ORDER BY code`,
        [query.legalEntityId ?? null],
      );
      return { data: rows };
    });
  }
}
