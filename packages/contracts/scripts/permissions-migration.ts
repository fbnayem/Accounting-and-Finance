/**
 * Writes the migration that reconciles the permission registry with the contract.
 * `pnpm contracts:permissions`.
 *
 * Two rules meet here and pull in opposite directions:
 *
 *   - ADR-0005 §3 / 0002_identity.sql: the registry is *generated* from the
 *     contract and never hand-edited, so route and permission cannot drift.
 *   - ADR-0008 §3: migrations are forward-only, and `pnpm db:verify` rejects any
 *     edit to one that has been applied.
 *
 * Regenerating a single seed file in place satisfies the first and violates the
 * second. So the seed is accumulated instead: each change arrives in a new
 * migration, and the contract check compares the *union* across migrations against
 * the contract. Adding a route that needs a new permission therefore costs one
 * generated file and one review — which is the right price for widening what a role
 * can be granted.
 *
 * There are two kinds of change, and Phase 2 is where the second one first appeared:
 *
 *   INSERT  a permission the contract declares and no migration seeds.
 *   UPDATE  a permission whose generated description has changed, because a later
 *           phase added routes that use it. `account.view` was seeded in Phase 1 as
 *           "Routes: GET /accounts"; Phase 2 added /account-groups and
 *           /accounts/{id}/dimension-rules to it. The row is not wrong in any way
 *           that affects authorization — but `GET /permissions` serves that text to
 *           an administrator deciding what a role may do, and a description naming
 *           one of the three routes it actually unlocks is a misleading answer to
 *           exactly the question the endpoint exists for.
 *   UPDATE  a permission whose is_high_risk changed, which Phase 5 is where the third
 *           kind first appeared (F-921). This one DOES affect authorization, and it
 *           was the one case this generator could not see: it compared descriptions
 *           only, so when `inventory.post` stopped being high-risk the generator
 *           reported "registry is complete" while the registry and the contract
 *           disagreed about a permission's risk classification. `pnpm contracts:check`
 *           caught it, which is the right outcome — but a generator that reports
 *           completeness about a field it never compares is the failure this codebase
 *           keeps meeting, so it compares the field now.
 *
 * requires_reauth is derived from is_high_risk (ADR-0005 §3) rather than tracked
 * separately, so it moves with it.
 */
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  permissionRegistry,
  seededPermissions,
  renderPermissionSeed,
  sqlString,
  SCHEMA_DIR,
} from './shared';

const contract = permissionRegistry();
const seeded = new Map(seededPermissions().map((p) => [p.code, p]));

const missing = contract.filter((p) => !seeded.has(p.code));
const restated = contract.filter((p) => {
  const current = seeded.get(p.code);
  return current !== undefined && current.description !== p.description;
});

const reclassified = contract.filter((p) => {
  const current = seeded.get(p.code);
  return current !== undefined && current.isHighRisk !== p.isHighRisk;
});

if (missing.length === 0 && restated.length === 0 && reclassified.length === 0) {
  console.log(`permission registry is complete: ${contract.length} permissions already seeded`);
  process.exit(0);
}

const versions = readdirSync(SCHEMA_DIR)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .map((f) => Number(f.slice(0, 4)));
const next = String(Math.max(0, ...versions) + 1).padStart(4, '0');
const name = `${next}_permission_registry.sql`;

const parts: string[] = [
  `-- =============================================================================
-- ${next} — Permission registry (GENERATED — pnpm contracts:permissions)
-- =============================================================================
-- ADR-0005 §3 / F-016 / F-207. Rows are derived from x-permission and
-- x-additional-permissions in contracts/openapi.yaml. Do not hand-edit: the
-- contract check compares this seed against the contract and fails on any
-- difference.
--
-- ${missing.length} new permission(s), ${missing.filter((p) => p.isHighRisk).length} of them high-risk.
-- ${restated.length} description(s) restated because a later phase added routes.
-- ${reclassified.length} risk reclassification(s).
-- =============================================================================
`,
];

if (missing.length > 0) parts.push(renderPermissionSeed(missing));

if (restated.length > 0) {
  parts.push(
    '-- Descriptions only. is_high_risk, requires_reauth and min_phase are NOT touched\n' +
      '-- here: those are security-bearing, and a change to one is a new permission\n' +
      '-- decision that should be visible as such rather than folded into a text update.\n' +
      restated
        .map(
          (p) =>
            `UPDATE permissions SET description = ${sqlString(p.description)}\n` +
            ` WHERE code = ${sqlString(p.code)};`,
        )
        .join('\n'),
  );
}

if (reclassified.length > 0) {
  parts.push(
    '-- RISK RECLASSIFICATION. Its own section, deliberately: a change of\n' +
      '-- is_high_risk changes who may hold the permission and whether holding it\n' +
      '-- demands re-authentication, so it is a permission decision and reads as one\n' +
      '-- here rather than being folded in beside a text update.\n' +
      '--\n' +
      '-- requires_reauth follows is_high_risk (ADR-0005 §3) and is set with it.\n' +
      reclassified
        .map(
          (p) =>
            `-- ${p.code}: ${seeded.get(p.code)?.isHighRisk ? 'high-risk' : 'ordinary'} -> ` +
            `${p.isHighRisk ? 'high-risk' : 'ordinary'}\n` +
            `UPDATE permissions SET is_high_risk = ${p.isHighRisk}, ` +
            `requires_reauth = ${p.isHighRisk}\n WHERE code = ${sqlString(p.code)};`,
        )
        .join('\n'),
  );
}

writeFileSync(join(SCHEMA_DIR, name), `${parts.join('\n')}\n`, 'utf8');
console.log(
  `wrote contracts/schema/${name}: ${missing.length} new permission(s), ` +
    `${restated.length} description(s) restated, ` +
    `${reclassified.length} risk reclassification(s)`,
);
