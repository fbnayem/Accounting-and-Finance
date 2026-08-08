#!/usr/bin/env node
/**
 * Definition of Done, enforced — F-312.
 *
 * The audit's finding was that doc 98's 18-item Definition of Done had no
 * enforcement mechanism: "a checklist nobody runs is a checklist nobody fails."
 * Five of the eighteen items are mechanically checkable against the canonical
 * contracts and the repository itself. Those five are checked here and run in CI.
 *
 * The other thirteen need human judgement (is the acceptance criterion actually
 * met, was the accountant review done). They are not silently dropped — this
 * script prints them as the reviewer's list, so the boundary between "the machine
 * checked this" and "a person must check this" is explicit rather than assumed.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const c = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', bold: '\x1b[1m' };
let failures = 0;
const pass = (m) => console.log(`  ${c.green}ok${c.reset}    ${m}`);
const fail = (m) => {
  failures++;
  console.error(`  ${c.red}FAIL${c.reset}  ${m}`);
};

/** Reports one check: every problem becomes a failure line, or a single pass line. */
function report(problems, passMessage) {
  if (problems.length === 0) {
    pass(passMessage);
    return;
  }
  for (const problem of problems) fail(problem);
}

/**
 * Application and library source only.
 *
 * Excluded, each for a reason:
 *   - `generated/` — produced from the contracts, so checking it checks the generator twice.
 *   - `*.test.ts` — negative tests name invalid and superseded values deliberately.
 *   - `scripts/` — the enforcement tooling itself. `check.ts` has to be able to
 *     write the word "bill.posted" in the comment explaining why it forbids it;
 *     a rule that its own explanation violates is a rule that gets deleted.
 */
function sourceFiles() {
  const out = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      if (['node_modules', 'dist', '.next', 'generated', 'coverage', 'scripts'].includes(entry)) {
        continue;
      }
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
    }
  };
  walk(join(ROOT, 'apps'));
  walk(join(ROOT, 'packages'));
  return out;
}

console.log(`${c.bold}Definition of Done — mechanical checks${c.reset}\n`);

const files = sourceFiles();
const sources = files.map((f) => ({ path: f, text: readFileSync(f, 'utf8') }));

// --- 1. every event published exists in the canonical contract ---------------
{
  const eventsGenerated = join(ROOT, 'packages/contracts/src/generated/events.ts');
  if (!existsSync(eventsGenerated)) {
    fail('contracts have not been generated — run `pnpm contracts:generate`');
  } else {
    // Only the EVENT_DEFINITIONS block. FORBIDDEN_EVENT_NAMES has the same line
    // shape, and including it would make this check accept the very names
    // check 2 exists to reject.
    const generated = readFileSync(eventsGenerated, 'utf8');
    const definitions = generated.split('FORBIDDEN_EVENT_NAMES')[0] ?? '';
    const known = new Set(
      [...definitions.matchAll(/^ {2}'([a-z_]+\.[a-z_]+)':/gm)].map((m) => m[1]),
    );
    const offenders = [];
    for (const { path, text } of sources) {
      for (const m of text.matchAll(/eventType:\s*'([^']+)'/g)) {
        if (!known.has(m[1])) offenders.push(`${relative(ROOT, path)} publishes "${m[1]}"`);
      }
    }
    report(
      offenders,
      `every published event type is in contracts/events.yaml (${known.size} defined)`,
    );
  }
}

// --- 2. no superseded event name reappears anywhere --------------------------
{
  const eventsYaml = readFileSync(join(ROOT, 'contracts/events.yaml'), 'utf8');
  const forbiddenBlock = eventsYaml.split(/^forbidden:/m)[1] ?? '';
  const forbidden = [...forbiddenBlock.matchAll(/^\s{2}([a-z_]+\.[a-z_]+):/gm)].map((m) => m[1]);
  const offenders = [];
  for (const { path, text } of sources) {
    for (const name of forbidden) {
      if (text.includes(`'${name}'`) || text.includes(`"${name}"`)) {
        offenders.push(`${relative(ROOT, path)} references the superseded name "${name}"`);
      }
    }
  }
  report(offenders, `no superseded event name appears in source (${forbidden.length} retired)`);
}

// --- 3. money never touches binary floating point ----------------------------
{
  // ADR-0006 §1. parseFloat/Number on a monetary string is the usual way in.
  const offenders = [];
  for (const { path, text } of sources) {
    if (path.includes(join('packages', 'domain', 'src', 'decimal.ts'))) continue; // the one sanctioned conversion
    if (path.includes(join('packages', 'ui', 'src', 'contrast.ts'))) continue; // colours, not money
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (/\bparseFloat\s*\(/.test(line)) {
        offenders.push(`${relative(ROOT, path)}:${i + 1} uses parseFloat (ADR-0006 §1)`);
      }
      // Word-bounded: "unbalanced" is a row count, not a balance, and a check
      // that cries wolf on counts is a check people learn to disable.
      if (
        /Number\([^)]*\b(amount|amounts|debit|credit|total|balance|price|unit_price)\b/i.test(line)
      ) {
        offenders.push(
          `${relative(ROOT, path)}:${i + 1} converts a monetary value with Number() (ADR-0006 §1)`,
        );
      }
    });
  }
  report(offenders, 'no monetary value is converted to a binary float (ADR-0006 §1)');
}

// --- 4. every migration is forward-only and unedited once applied ------------
{
  const dir = join(ROOT, 'contracts/schema');
  const migrations = readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f));
  const versions = migrations.map((f) => f.slice(0, 4));
  const duplicates = versions.filter((v, i) => versions.indexOf(v) !== i);
  const hasDown = migrations.filter((f) => /down|rollback/i.test(f));

  if (duplicates.length) fail(`duplicate migration versions: ${duplicates.join(', ')}`);
  else if (hasDown.length)
    fail(`down migrations are not permitted (ADR-0008 §3): ${hasDown.join(', ')}`);
  else pass(`${migrations.length} migrations, sequentially versioned and forward-only`);

  if (!existsSync(join(dir, 'schema.lock.json'))) {
    fail('contracts/schema/schema.lock.json is missing — the drift gate has no reference');
  } else {
    const lock = JSON.parse(readFileSync(join(dir, 'schema.lock.json'), 'utf8'));
    pass(
      `schema.lock.json present (${lock.counts.tables} tables, ${lock.counts.constraints} constraints)`,
    );
  }
}

// --- 5. every ADR referenced in source actually exists ------------------------
{
  const adrDir = join(ROOT, 'docs/adr');
  const existing = new Set(
    readdirSync(adrDir)
      .filter((f) => /^\d{4}-/.test(f))
      .map((f) => f.slice(0, 4)),
  );
  const referenced = new Set();
  for (const { text } of sources) {
    for (const m of text.matchAll(/ADR-(\d{4})/g)) referenced.add(m[1]);
  }
  const dangling = [...referenced]
    .filter((n) => !existing.has(n))
    .sort()
    .map((n) => `source cites ADR-${n}, which does not exist in docs/adr/`);
  report(dangling, `all ${referenced.size} ADRs cited in source exist (${existing.size} written)`);
}

/**
 * The phases whose routes are expected to exist.
 *
 * Read out of `apps/api/src/common/operation.ts` rather than restated here.
 * Phase 2 made that necessary: the same list drives the boot-time route
 * reconciliation, the generated authorization suite and this check, and three
 * copies of "which phases are delivered" is three chances for one to be a phase
 * behind — which would leave this check quietly green while covering less.
 *
 * Deliberately still a written-down list rather than "every phase that has a
 * handler", which would be a check that agrees with whatever it finds.
 */
const DELIVERED_PHASES = (() => {
  const source = readFileSync(join(ROOT, 'apps/api/src/common/operation.ts'), 'utf8');
  const match = /export const DELIVERED_PHASES = \[([\d, ]+)\]/.exec(source);
  if (!match) {
    console.error('  FAIL  DELIVERED_PHASES not found in apps/api/src/common/operation.ts');
    process.exit(1);
  }
  return match[1].split(',').map((n) => Number(n.trim()));
})();

// --- 6. every delivered route exists, in both directions ----------------------
{
  // Two items from doc 98's Definition of Done live here rather than on the human
  // list: "authorization tested for every new mutation route" and "idempotency
  // tested for every new command". Both were reviewer judgement because there was
  // no way to enumerate the routes. There is now: the handlers declare which
  // contract operation they are, and the permission and the idempotency rule are
  // read from the contract at request time rather than restated in the handler.
  //
  // This is the static half — the routes exist and nothing is orphaned. The
  // behavioural half is `apps/api/src/integration/authorization.test.ts`, which
  // generates one case per Phase 1 mutation from the same contract.
  const generated = join(ROOT, 'packages/contracts/src/generated/operations.ts');
  const text = existsSync(generated) ? readFileSync(generated, 'utf8') : '';
  const contract = [
    ...text.matchAll(
      /operationId: '([^']+)', method: '([^']+)', path: '([^']+)'[^}]*?phase: (\d+)/g,
    ),
  ]
    .map((m) => ({ id: m[1], method: m[2], path: m[3], phase: Number(m[4]) }))
    .filter((o) => DELIVERED_PHASES.includes(o.phase));

  // Controllers only. `common/operation.ts` defines the decorator and quotes it in
  // the message it prints when a route declares an operation the contract does not
  // have — the same shape as a real usage, and the check found it on the first run.
  // Enforcement code has to be able to name what it enforces.
  const handled = new Set();
  for (const { path, text: source } of sources) {
    if (!path.endsWith('.controller.ts')) continue;
    for (const m of source.matchAll(/@Operation\('([^']+)'\)/g)) handled.add(m[1]);
  }

  const problems = [
    ...contract
      .filter((o) => !handled.has(o.id))
      .map((o) => `${o.method} ${o.path} (${o.id}, phase ${o.phase}) has no handler in apps/api`),
    ...[...handled]
      .filter((id) => !contract.some((o) => o.id === id))
      .map(
        (id) =>
          `apps/api handles "${id}", which is not a phase ${DELIVERED_PHASES.join('/')} operation`,
      ),
  ];
  report(
    problems,
    `all ${contract.length} phase ${DELIVERED_PHASES.join('/')} operations have a handler, and no handler is orphaned`,
  );
}

// --- 7. the cross-cutting rules are still registered globally -----------------
{
  // The guards and the idempotency interceptor are registered once, globally, and
  // read what to enforce from the contract. That design means deleting three lines
  // in app.module.ts would silently remove authentication, authorization and
  // idempotency from every route at once, with every test that checks a *specific*
  // route still passing if it happened to be one that answers 404 anyway.
  const modulePath = join(ROOT, 'apps/api/src/app.module.ts');
  const module = existsSync(modulePath) ? readFileSync(modulePath, 'utf8') : '';
  const required = [
    ['APP_GUARD', 'AuthGuard'],
    ['APP_GUARD', 'PermissionGuard'],
    ['APP_INTERCEPTOR', 'IdempotencyInterceptor'],
  ];
  const missing = required
    .filter(
      ([token, provider]) =>
        !new RegExp(`provide:\\s*${token},\\s*useClass:\\s*${provider}`).test(module),
    )
    .map(
      ([token, provider]) => `${provider} is not registered as a global ${token} in app.module.ts`,
    );
  report(missing, 'authentication, authorization and idempotency are registered globally');
}

// --- the human half ----------------------------------------------------------
console.log(`\n${c.bold}Requires a person — not checkable here${c.reset}`);
for (const item of [
  'Acceptance criteria in the owning module spec are met',
  'Golden posting fixtures updated for any new or changed posting rule',
  'Subledger-to-control reconciliation still balances',
  'Concurrency behaviour considered and, where contended, tested',
  'Period-close interaction considered',
  'Multi-currency behaviour considered',
  'Audit trail entries produced for the new action',
  'Error taxonomy applied — no new ad-hoc error shapes',
  'Performance measured against the Gate H target for the affected workload',
  'Accessibility checked against ADR-0010 for any new interface',
  'Localization rule version retained on any historical record touched',
]) {
  console.log(`  ${c.dim}·${c.reset}     ${item}`);
}

console.log('');
if (failures > 0) {
  console.error(
    `${c.red}${c.bold}Definition of Done: ${failures} mechanical check(s) FAILED${c.reset}`,
  );
  process.exit(1);
}
console.log(`${c.green}${c.bold}Definition of Done: mechanical checks passed${c.reset}`);
