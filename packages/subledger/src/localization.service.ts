import { Pool } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  assertEntityPermission,
  type TenantPrincipal,
} from '@acct/domain';
import { publish, recordAudit, readInTenant, writeInTenant } from '@acct/database';

/**
 * Localization packages — the framework, not the content.
 *
 * The product decision on record is generic/global first: no country pack ships
 * in the first release, so nothing here knows a VAT rule. What must ship now is
 * the abstraction, because doc 07 and doc 20 both require a historical
 * transaction to retain the rule version in force when it was posted, and that
 * is not retrofittable — the moment tax history exists without a version
 * against it, "which rules produced this number" is unanswerable forever.
 * Hence: an installation records the exact version installed, installing the
 * same version again is a no-op, and installing anything else over an existing
 * installation refuses rather than silently rewriting what the entity runs.
 */

export interface InstalledLocalization {
  readonly packageCode: string;
  readonly version: string;
  /** The version row's effective_from — the tiebreaker when version strings do not parse. */
  readonly effectiveFrom: string;
}

/**
 * Orders two dotted version strings numerically ('1.10' > '1.9', which
 * lexicographic comparison gets wrong). Returns null when either side has a
 * non-numeric segment — refusing to rank is better than ranking wrongly.
 */
export function compareLocalizationVersions(a: string, b: string): -1 | 0 | 1 | null {
  const as = a.split('.');
  const bs = b.split('.');
  const length = Math.max(as.length, bs.length);
  for (let i = 0; i < length; i++) {
    const av = as[i] ?? '0';
    const bv = bs[i] ?? '0';
    if (!/^\d+$/.test(av) || !/^\d+$/.test(bv)) return null;
    const an = Number(av);
    const bn = Number(bv);
    if (an !== bn) return an < bn ? -1 : 1;
  }
  return 0;
}

/**
 * The install decision, pure and decidable.
 *
 * Idempotent on the same version, and a refusal for everything else: a
 * downgrade would run future postings under rules already superseded, an
 * upgrade is a deliberate migration (the `localization.upgraded` event exists
 * for it; the operation does not ship in this release), and a second package
 * would change the entity's statutory regime as a side effect of an install.
 */
export function decideInstallation(
  installed: InstalledLocalization | null,
  requested: InstalledLocalization,
): 'INSTALL' | 'ALREADY_INSTALLED' {
  if (!installed) return 'INSTALL';
  if (installed.packageCode === requested.packageCode && installed.version === requested.version) {
    return 'ALREADY_INSTALLED';
  }
  if (installed.packageCode !== requested.packageCode) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `This legal entity already runs localization ${installed.packageCode}@` +
        `${installed.version}. Installing ${requested.packageCode} over it would change ` +
        'which statutory regime future postings run under as a side effect of an install.',
      {
        details: {
          installed: `${installed.packageCode}@${installed.version}`,
          requested: `${requested.packageCode}@${requested.version}`,
        },
      },
    );
  }

  const order =
    compareLocalizationVersions(requested.version, installed.version) ??
    (requested.effectiveFrom < installed.effectiveFrom
      ? -1
      : requested.effectiveFrom > installed.effectiveFrom
        ? 1
        : null);
  if (order !== null && order < 0) {
    throw new AppError(
      'PRECONDITION_FAILED',
      `Downgrading ${installed.packageCode} from ${installed.version} to ` +
        `${requested.version} is refused. Historical transactions retain the rule version ` +
        'in force when they posted (doc 07), and future postings must not quietly run ' +
        'under rules that have been superseded.',
      { details: { installed: installed.version, requested: requested.version } },
    );
  }
  throw new AppError(
    'PRECONDITION_FAILED',
    `${installed.packageCode}@${installed.version} is already installed. Moving to ` +
      `${requested.version} is an upgrade — a deliberate, versioned migration that never ` +
      'rewrites history (doc 20) — not a re-install, and no upgrade path ships in this release.',
    { details: { installed: installed.version, requested: requested.version } },
  );
}

export class LocalizationService {
  constructor(private readonly pool: Pool) {}

  // -------------------------------------------------------------------------
  // GET /localizations
  // -------------------------------------------------------------------------

  /**
   * The catalog of packages and their versions. Empty in the first release by
   * design — listing what exists, rather than pretending country content, is
   * the honest answer until a reviewed pack lands (doc 20's review rule).
   */
  async listLocalizations(principal: TenantPrincipal) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT p.id, p.code, p.country_code, p.name, p.status::text AS status,
                coalesce(json_agg(json_build_object(
                  'id', v.id, 'version', v.version,
                  'effective_from', v.effective_from::text,
                  'effective_to', v.effective_to::text,
                  'published_at', v.published_at::text,
                  'source_reference', v.source_reference,
                  'release_notes', v.release_notes
                ) ORDER BY v.effective_from) FILTER (WHERE v.id IS NOT NULL), '[]') AS versions
           FROM localization_packages p
           LEFT JOIN localization_versions v
             ON v.localization_package_id = p.id AND v.status = 'ACTIVE'
          WHERE p.status = 'ACTIVE'
          GROUP BY p.id
          ORDER BY p.code`,
      );
      return { data: rows };
    });
  }

  // -------------------------------------------------------------------------
  // POST /legal-entities/{id}/localization/install
  // -------------------------------------------------------------------------

  async installLocalization(
    principal: TenantPrincipal,
    legalEntityId: string,
    input: { packageCode: string; version: string },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'localization.install', legalEntityId);

      const { rows: entities } = await client.query<{ id: string }>(
        `SELECT id FROM legal_entities WHERE id = $1`,
        [legalEntityId],
      );
      if (!entities[0]) throw notFound('legal entity', legalEntityId);

      const { rows: versions } = await client.query<{
        id: string;
        version: string;
        effective_from: string;
        version_status: string;
        package_code: string;
        country_code: string;
        package_name: string;
        package_status: string;
      }>(
        `SELECT v.id, v.version, v.effective_from::text AS effective_from,
                v.status::text AS version_status,
                p.code AS package_code, p.country_code, p.name AS package_name,
                p.status::text AS package_status
           FROM localization_versions v
           JOIN localization_packages p ON p.id = v.localization_package_id
          WHERE p.code = $1 AND v.version = $2`,
        [input.packageCode, input.version],
      );
      const requested = versions[0];
      if (!requested) {
        throw notFound('localization version', `${input.packageCode}@${input.version}`);
      }
      if (requested.package_status !== 'ACTIVE' || requested.version_status !== 'ACTIVE') {
        throw new AppError(
          'VALIDATION_FAILED',
          `${input.packageCode}@${input.version} is not an active package version; a retired ` +
            'version cannot be newly installed.',
          {
            details: {
              package_status: requested.package_status,
              version_status: requested.version_status,
            },
          },
        );
      }

      // Lock the current installation row so two concurrent installs serialise;
      // the UNIQUE (legal_entity_id, localization_version_id) is the backstop.
      const { rows: existing } = await client.query<{
        id: string;
        localization_version_id: string;
        installed_at: string;
        status: string;
        version: string;
        effective_from: string;
        package_code: string;
      }>(
        `SELECT i.id, i.localization_version_id, i.installed_at::text AS installed_at,
                i.status::text AS status, v.version, v.effective_from::text AS effective_from,
                p.code AS package_code
           FROM localization_installations i
           JOIN localization_versions v ON v.id = i.localization_version_id
           JOIN localization_packages p ON p.id = v.localization_package_id
          WHERE i.legal_entity_id = $1 AND i.status = 'ACTIVE'
          ORDER BY i.installed_at DESC
          LIMIT 1
            FOR UPDATE OF i`,
        [legalEntityId],
      );
      const current = existing[0] ?? null;

      const decision = decideInstallation(
        current
          ? {
              packageCode: current.package_code,
              version: current.version,
              effectiveFrom: current.effective_from,
            }
          : null,
        {
          packageCode: requested.package_code,
          version: requested.version,
          effectiveFrom: requested.effective_from,
        },
      );

      if (decision === 'ALREADY_INSTALLED') {
        // Idempotent by design: the retry of an install returns the
        // installation it already made, not an error and not a second row.
        return {
          id: current!.id,
          legal_entity_id: legalEntityId,
          localization_version_id: current!.localization_version_id,
          package_code: current!.package_code,
          version: current!.version,
          installed_at: current!.installed_at,
          status: current!.status,
          already_installed: true,
        };
      }

      const { rows: created } = await client.query<{
        id: string;
        legal_entity_id: string;
        localization_version_id: string;
        installed_at: string;
        status: string;
      }>(
        `INSERT INTO localization_installations (id, tenant_id, legal_entity_id,
                                                 localization_version_id, installed_by)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, legal_entity_id, localization_version_id,
                   installed_at::text AS installed_at, status::text AS status`,
        [uuidv7(), principal.tenantId, legalEntityId, requested.id, principal.userId],
      );
      const installation = created[0]!;

      await publish(client, context, {
        eventType: 'localization.installed',
        aggregateType: 'localization_installation',
        aggregateId: installation.id,
        tenantId: principal.tenantId,
        legalEntityId,
        payload: {
          package: requested.package_code,
          version: requested.version,
          effective_from: requested.effective_from,
        },
      });
      await recordAudit(client, context, {
        action: 'localization.installed',
        resourceType: 'localization_installation',
        resourceId: installation.id,
        tenantId: principal.tenantId,
        legalEntityId,
        after: {
          ...installation,
          package_code: requested.package_code,
          version: requested.version,
        },
      });

      return {
        ...installation,
        package_code: requested.package_code,
        version: requested.version,
        already_installed: false,
      };
    });
  }
}
