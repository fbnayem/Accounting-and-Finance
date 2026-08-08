/**
 * Contract drift gate — run by CI and by `pnpm ci`.
 *
 * Phase 0 exit criterion 2 is "CI rejects schema drift"; this is its contract-side
 * half. Each check below corresponds to a defect the audit actually found, so none
 * of them are hypothetical:
 *
 *   1. Generated files are current              — silent staleness
 *   2. No duplicate event types or operationIds — F-104
 *   3. No superseded (forbidden) name is live   — F-101, 22 events under two names
 *   4. Every event follows the naming rule      — contracts/events.yaml `naming`
 *   5. Every mutation declares a permission     — Gate B
 *   6. Every operation declares x-idempotency and x-phase — F-044
 *   7. Every event name used in code exists in the contract
 *   8. The seeded permission registry matches the contract exactly — F-503
 *   9. Every high-risk category doc 02 names has a permission — Gate B / Gate F
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ROOT,
  GENERATED_DIR,
  loadEvents,
  loadOperations,
  permissionRegistry,
  seededPermissions,
  MUTATION_METHODS,
} from './shared';
import { renderGenerated } from './render';

let failures = 0;

function pass(message: string): void {
  console.log(`  ok    ${message}`);
}

function fail(message: string): void {
  failures++;
  console.error(`  FAIL  ${message}`);
}

/** Reports one check: every problem is a failure line, or a single pass line. */
function report(problems: readonly string[], passMessage: string): void {
  if (problems.length === 0) {
    pass(passMessage);
    return;
  }
  for (const problem of problems) fail(problem);
}

const { events, forbidden } = loadEvents();
const operations = loadOperations();

// --- 1. generated files are current -----------------------------------------
{
  const expected = renderGenerated();
  const stale = Object.entries(expected)
    .filter(([name, content]) => {
      const path = join(GENERATED_DIR, name);
      return !existsSync(path) || readFileSync(path, 'utf8') !== content;
    })
    .map(([name]) => name);

  report(
    stale.length === 0
      ? []
      : [
          `generated contract files are out of date: ${stale.join(', ')}. ` +
            'Run `pnpm contracts:generate` and commit the result.',
        ],
    'generated contract files are current',
  );
}

// --- 2. no duplicates --------------------------------------------------------
{
  const repeated = (values: readonly string[]): string[] => {
    const counts = new Map<string, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts.entries()].filter(([, n]) => n > 1).map(([value]) => value);
  };

  report(
    repeated(events.map((e) => e.type)).map((t) => `duplicate event type: ${t}`),
    `${events.length} event types, no duplicates`,
  );

  report(
    repeated(operations.map((o) => o.operationId)).map((id) => `duplicate operationId: ${id}`),
    `${operations.length} operations, no duplicate operationIds`,
  );

  const unnamed = operations.filter((o) => !o.operationId);
  report(
    unnamed.length === 0 ? [] : [`${unnamed.length} operations without an operationId`],
    'every operation has an operationId',
  );
}

// --- 3. no superseded name is live ------------------------------------------
{
  // The key is the superseded name; the value is what supersedes it.
  const live = new Set(events.map((e) => e.type));
  const superseded = Object.keys(forbidden);

  report(
    superseded
      .filter((name) => live.has(name))
      .map((name) => `superseded event name is live: ${name}`),
    `${superseded.length} superseded names, none live`,
  );

  // The replacement must itself exist, or the mapping sends developers nowhere.
  const dangling = Object.entries(forbidden)
    .filter(([, replacement]) =>
      String(replacement)
        .split('|')
        .map((s) => s.trim().replace(/\s*\(.*\)$/, ''))
        .filter(Boolean)
        .some((name) => !live.has(name)),
    )
    .map(([name, replacement]) => `${name} points at a non-existent replacement: ${replacement}`);

  report(dangling, 'every superseded name points at a live replacement');
}

// --- 4. naming rule ----------------------------------------------------------
{
  const bad = events
    .filter((e) => !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(e.type))
    .map((e) => `event name violates <aggregate>.<past_tense_verb>: ${e.type}`);
  report(bad, 'all event names match the naming rule');
}

// --- 5. every mutation declares a permission --------------------------------
{
  // Two exemptions, both of which must be declared in the contract rather than
  // assumed: `security: []` (you cannot require a permission to log in) and
  // `x-self-service: true` (the operation acts only on the caller's own session).
  const mutations = operations.filter((o) => MUTATION_METHODS.has(o.method));
  const unprotected = mutations
    .filter((o) => o.permission === null && !o.unauthenticated && !o.selfService)
    .map((o) => `mutation without x-permission or a declared exemption: ${o.method} ${o.path}`);

  report(
    unprotected,
    `all ${mutations.length} mutations declare a permission or a stated exemption ` +
      `(${mutations.filter((o) => o.unauthenticated).length} unauthenticated, ` +
      `${mutations.filter((o) => o.selfService).length} self-service)`,
  );

  // An exemption anywhere but the auth and inbound-webhook surfaces is a hole.
  const suspicious = mutations
    .filter(
      (o) =>
        (o.unauthenticated || o.selfService) &&
        !o.path.startsWith('/auth/') &&
        !o.path.startsWith('/webhooks/'),
    )
    .map((o) => `permission exemption outside /auth and /webhooks: ${o.method} ${o.path}`);

  report(suspicious, 'no permission exemption outside the auth and inbound-webhook surfaces');
}

// --- 6. markers present ------------------------------------------------------
{
  const missing = operations
    .filter((o) => !o.idempotency || Number.isNaN(o.phase))
    .map((o) => `operation missing x-idempotency or x-phase: ${o.operationId}`);
  report(missing, 'every operation declares x-idempotency and x-phase');

  const required = operations.filter((o) => o.idempotency === 'required');
  const nonMutating = required
    .filter((o) => !MUTATION_METHODS.has(o.method))
    .map((o) => `non-mutating operation marked "idempotency: required": ${o.operationId}`);
  report(nonMutating, `${required.length} operations require an Idempotency-Key, all mutating`);
}

// --- 7. event names used in code exist in the contract ----------------------
{
  const sourceDirs = ['apps', 'packages'].map((d) => join(ROOT, d)).filter(existsSync);
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (['node_modules', 'dist', '.next', 'generated'].includes(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      // Test files are excluded on purpose. The outbox tests name
      // "organization.probably_created" and the superseded "bill.posted" to prove
      // the runtime guard rejects them; flagging those would force the negative
      // tests to be deleted to satisfy the check that they exist to verify.
      else if (/\.(ts|tsx)$/.test(path) && !/\.test\.(ts|tsx)$/.test(path)) files.push(path);
    }
  };
  for (const dir of sourceDirs) walk(dir);

  const live = new Set(events.map((e) => e.type));
  const supersededMap = new Map(
    Object.entries(forbidden).map(([name, replacement]) => [name, String(replacement)]),
  );

  const pattern = /eventType:\s*'([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)'/g;
  const problems: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      const type = match[1] as string;
      if (live.has(type)) continue;
      const replacement = supersededMap.get(type);
      problems.push(
        `${relative(ROOT, file)}: "${type}"` +
          (replacement
            ? ` is superseded — use "${replacement}"`
            : ' is not in contracts/events.yaml'),
      );
    }
  }
  report(problems, `${files.length} source files reference only canonical event names`);
}

// --- 8. the seeded registry matches the contract ----------------------------
{
  // 0002_identity.sql: "SEEDED FROM contracts/openapi.yaml x-permission values
  // (ADR-0005), so route and permission cannot drift. CI fails if a route declares
  // a permission absent from this table." This is that CI check. Because migrations
  // are forward-only, the seed accumulates across files and is compared as a set.
  const contract = permissionRegistry(operations);
  const seeded = seededPermissions();
  const byCode = new Map(seeded.map((p) => [p.code, p]));
  const problems: string[] = [];

  for (const want of contract) {
    const got = byCode.get(want.code);
    if (!got) {
      problems.push(
        `permission "${want.code}" is declared by the contract but no migration seeds it. ` +
          'Run `pnpm contracts:permissions` and commit the new migration.',
      );
      continue;
    }
    // Everything about the row, not merely its existence. A permission seeded as
    // ordinary when the contract calls it high-risk is the failure that matters:
    // it would be grantable without reauthentication and nobody would notice.
    if (got.isHighRisk !== want.isHighRisk) {
      problems.push(
        `permission "${want.code}" is seeded with is_high_risk=${got.isHighRisk} ` +
          `but the contract says ${want.isHighRisk} (${got.migration})`,
      );
    }
    if (got.requiresReauth !== want.isHighRisk) {
      problems.push(
        `permission "${want.code}" is seeded with requires_reauth=${got.requiresReauth}; ` +
          `ADR-0005 §3 ties it to is_high_risk=${want.isHighRisk} (${got.migration})`,
      );
    }
    if (got.minPhase !== want.minPhase) {
      problems.push(
        `permission "${want.code}" is seeded with min_phase=${got.minPhase} ` +
          `but the earliest route that uses it is phase ${want.minPhase} (${got.migration})`,
      );
    }
    if (got.description !== want.description) {
      // Usually this means a later phase added routes that use an existing
      // permission, so its generated route list has grown. `pnpm contracts:permissions`
      // emits the UPDATE. It can also mean somebody edited the seed by hand, which
      // is the case the check was originally written for — both are reported the
      // same way because the fix is the same: regenerate.
      problems.push(
        `permission "${want.code}" is described as "${got.description}" (${got.migration}) ` +
          `but the contract now derives "${want.description}". Run \`pnpm contracts:permissions\`.`,
      );
    }
  }

  const declared = new Set(contract.map((p) => p.code));
  for (const got of seeded) {
    if (!declared.has(got.code)) {
      problems.push(
        `permission "${got.code}" is seeded by ${got.migration} but no route declares it. ` +
          'A permission no route requires can be granted and never checked.',
      );
    }
  }

  const duplicates = seeded
    .map((p) => p.code)
    .filter((code, i, all) => all.indexOf(code) !== i)
    .filter((code, i, all) => all.indexOf(code) === i);
  for (const code of duplicates) {
    problems.push(`permission "${code}" is seeded by more than one migration`);
  }

  report(
    problems,
    `permission registry matches the contract (${contract.length} permissions, ` +
      `${contract.filter((p) => p.isHighRisk).length} high-risk)`,
  );
}

// --- 9. doc 02's high-risk categories all have a permission ------------------
{
  // doc 02 lists seven high-risk permissions by description, not by code. Gate B
  // ("audit trail records sensitive setup/permission changes") and Gate F
  // ("high-risk flows enforce configured approval controls") both depend on those
  // seven being representable. Spelling the mapping out here means a future
  // refactor that renames a permission out from under a category fails the build
  // rather than quietly emptying a control.
  const categories: Record<string, readonly string[]> = {
    'change vendor bank details': ['vendor.change_bank_details'],
    'approve payments': ['payment_run.approve', 'payment_run.execute', 'vendor_payment.pay'],
    'post manual journals to control accounts': ['journal.post_control'],
    'reopen periods': ['accounting_period.reopen'],
    'override tax': ['tax.override'],
    'export all financial data': ['report.export'],
    'manage roles/integrations': ['role.manage', 'integration.manage'],
  };

  const registry = new Map(permissionRegistry(operations).map((p) => [p.code, p]));
  const problems: string[] = [];
  for (const [category, codes] of Object.entries(categories)) {
    for (const code of codes) {
      const def = registry.get(code);
      if (!def) {
        problems.push(
          `doc 02 high-risk category "${category}" names ${code}, which does not exist`,
        );
      } else if (!def.isHighRisk) {
        problems.push(
          `${code} covers doc 02 high-risk category "${category}" but is not flagged high-risk`,
        );
      }
    }
  }

  report(problems, `all 7 doc 02 high-risk categories map to flagged permissions`);
}

console.log('');
if (failures > 0) {
  console.error(`contract check FAILED with ${failures} problem(s)`);
  process.exit(1);
}
console.log('contract check passed');
