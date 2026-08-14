import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

export function repositoryRoot(from: string = process.cwd()): string {
  let dir = resolve(from);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(from);
}

export const ROOT = repositoryRoot();
export const EVENTS_YAML = join(ROOT, 'contracts', 'events.yaml');
export const OPENAPI_YAML = join(ROOT, 'contracts', 'openapi.yaml');
export const GENERATED_DIR = join(ROOT, 'packages', 'contracts', 'src', 'generated');

/**
 * `platform` events may carry a null `legal_entity_id`; `entity` and `book` events
 * may not. `book` narrows further — the event also belongs to one accounting book,
 * which matters for multi-book tenants in Phase 10.
 */
export type EventScope = 'platform' | 'entity' | 'book';

export interface EventDefinition {
  readonly type: string;
  readonly context: string;
  readonly scope: EventScope;
  readonly phase: number;
  readonly status: 'stable' | 'new' | 'renamed' | 'split';
  readonly was?: string;
  readonly note?: string;
}

/**
 * A permission that gates a *condition inside* a route rather than the route
 * itself — F-503.
 *
 * `x-permission` answers "may you call this operation at all". Some permissions
 * answer a narrower question: may you post this particular journal to a control
 * account, override this line's tax code, accept this suspected-duplicate bill.
 * Before F-503 those had nowhere to live. `postJournal`'s own description named
 * `journal.post_control`, `createVendorBill`'s named `vendor_bill.override_duplicate`,
 * and `tax_overrides` exists in the schema — yet none of the three could ever
 * appear in the registry, because the registry was generated from `x-permission`
 * alone. A permission the registry cannot hold is a permission no role can grant
 * and no test can cover, which is precisely the hole Gate B is meant to close.
 */
export interface AdditionalPermission {
  readonly code: string;
  readonly description: string;
  readonly highRisk: boolean;
}

export interface OperationDefinition {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly tag: string;
  readonly permission: string | null;
  readonly idempotency: 'required' | 'recommended' | 'n-a';
  readonly phase: number;
  readonly highRisk: boolean;
  /** `security: []` — reachable without a session (login, refresh, MFA, health). */
  readonly unauthenticated: boolean;
  /**
   * Authenticated but permission-free, because the operation acts only on the
   * caller's own resources. The only legitimate reason a mutation may carry no
   * x-permission while still requiring a session.
   */
  readonly selfService: boolean;
  /** Conditional permissions this operation can demand — see AdditionalPermission. */
  readonly additionalPermissions: readonly AdditionalPermission[];
  /**
   * The success status the contract declares — the lowest 2xx in `responses`.
   *
   * Generated so the HTTP status is contract-driven like everything else: a route
   * cannot answer 200 where the document promises 201, and the idempotency replay
   * has a status to store without inferring one from the framework's defaults.
   */
  readonly successStatus: number;
}

/** One row of the `permissions` table, as the contract defines it. */
export interface PermissionDefinition {
  readonly code: string;
  readonly resource: string;
  readonly action: string;
  readonly description: string;
  readonly isHighRisk: boolean;
  readonly minPhase: number;
}

interface EventsDocument {
  contexts: Record<
    string,
    {
      scope?: string;
      phase?: number;
      events: Record<string, { status?: string; was?: string; note?: string } | null>;
    }
  >;
  forbidden?: Record<string, string>;
}

export function loadEvents(): {
  events: EventDefinition[];
  forbidden: Record<string, string>;
} {
  const doc = parse(readFileSync(EVENTS_YAML, 'utf8')) as EventsDocument;
  const events: EventDefinition[] = [];

  for (const [context, block] of Object.entries(doc.contexts ?? {})) {
    // The YAML carries a trailing comment on one scope value, so match the leading word.
    const declared = String(block.scope ?? 'entity')
      .trim()
      .split(/\s+/)[0];
    const scope: EventScope =
      declared === 'platform' ? 'platform' : declared === 'book' ? 'book' : 'entity';
    const phase = block.phase ?? 0;
    for (const [type, meta] of Object.entries(block.events ?? {})) {
      const m = meta ?? {};
      const def: EventDefinition = {
        type,
        context,
        scope,
        phase,
        status: (m.status as EventDefinition['status']) ?? 'stable',
        ...(m.was ? { was: m.was } : {}),
        ...(m.note ? { note: m.note } : {}),
      };
      events.push(def);
    }
  }

  return { events, forbidden: doc.forbidden ?? {} };
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'options']);

export function loadOperations(): OperationDefinition[] {
  const doc = parse(readFileSync(OPENAPI_YAML, 'utf8')) as {
    paths: Record<string, Record<string, Record<string, unknown>>>;
  };
  const out: OperationDefinition[] = [];

  for (const [path, methods] of Object.entries(doc.paths ?? {})) {
    for (const [method, op] of Object.entries(methods ?? {})) {
      if (!HTTP_METHODS.has(method)) continue;
      const permission = op['x-permission'];
      const extra = Array.isArray(op['x-additional-permissions'])
        ? (op['x-additional-permissions'] as Record<string, unknown>[])
        : [];
      out.push({
        operationId: String(op.operationId ?? ''),
        method: method.toUpperCase(),
        path,
        tag: Array.isArray(op.tags) ? String(op.tags[0]) : 'Untagged',
        permission: permission == null ? null : String(permission),
        idempotency: (op['x-idempotency'] as OperationDefinition['idempotency']) ?? 'n-a',
        phase: Number(op['x-phase'] ?? 0),
        highRisk: op['x-high-risk'] === true,
        unauthenticated: Array.isArray(op.security) && op.security.length === 0,
        selfService: op['x-self-service'] === true,
        additionalPermissions: extra.map((e) => ({
          code: String(e.code ?? ''),
          description: String(e.description ?? ''),
          highRisk: e.high_risk === true,
        })),
        successStatus: successStatus(op.responses),
      });
    }
  }

  return out.sort((a, b) => a.operationId.localeCompare(b.operationId));
}

function successStatus(responses: unknown): number {
  const codes = Object.keys((responses as Record<string, unknown>) ?? {})
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 200 && n < 300)
    .sort((a, b) => a - b);
  return codes[0] ?? 200;
}

/** Mutating methods carry the authorization obligations Gate B tests. */
export const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * The permission registry, derived from the contract and from nothing else.
 *
 * `contracts/schema/0002_identity.sql` says the table is "SEEDED FROM
 * contracts/openapi.yaml x-permission values … Never hand-edited", and ADR-0005 §3
 * makes that the reason Gate B is provable. This function is the single derivation;
 * the migration writer and the drift check both call it, so the seeded rows and the
 * checked rows cannot come from different opinions.
 *
 * `description` is deliberately mechanical rather than prose. Nobody maintains 193
 * hand-written sentences, and the routes a permission actually unlocks is the thing
 * an auditor asks for. Additional permissions carry the description the contract
 * gives them, because for those the route list would say nothing useful.
 */
export function permissionRegistry(
  operations: readonly OperationDefinition[] = loadOperations(),
): PermissionDefinition[] {
  const byCode = new Map<
    string,
    { routes: string[]; highRisk: boolean; minPhase: number; description: string | null }
  >();

  const touch = (code: string) => {
    let entry = byCode.get(code);
    if (!entry) {
      entry = { routes: [], highRisk: false, minPhase: Number.MAX_SAFE_INTEGER, description: null };
      byCode.set(code, entry);
    }
    return entry;
  };

  for (const op of [...operations].sort((a, b) => a.path.localeCompare(b.path))) {
    if (op.permission) {
      const entry = touch(op.permission);
      entry.routes.push(`${op.method} ${op.path}`);
      entry.highRisk = entry.highRisk || op.highRisk;
      entry.minPhase = Math.min(entry.minPhase, op.phase);
    }
    for (const extra of op.additionalPermissions) {
      const entry = touch(extra.code);
      entry.highRisk = entry.highRisk || extra.highRisk;
      entry.minPhase = Math.min(entry.minPhase, op.phase);
      // First declaration wins; the check rejects conflicting redeclarations.
      entry.description ??= extra.description;
    }
  }

  return [...byCode.entries()]
    .map(([code, entry]) => {
      const dot = code.indexOf('.');
      const shown = entry.routes.slice(0, 3).join(', ');
      const more = entry.routes.length > 3 ? ` +${entry.routes.length - 3} more` : '';
      return {
        code,
        resource: code.slice(0, dot),
        action: code.slice(dot + 1),
        description:
          entry.description ??
          (entry.routes.length > 0 ? `Routes: ${shown}${more}` : 'No route declares this.'),
        isHighRisk: entry.highRisk,
        minPhase: entry.minPhase === Number.MAX_SAFE_INTEGER ? 0 : entry.minPhase,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------------------
// The registry as the database holds it
// ---------------------------------------------------------------------------

export const SCHEMA_DIR = join(ROOT, 'contracts', 'schema');

/** One row as seeded by a migration, so it can be compared with the contract. */
export interface SeededPermission {
  readonly code: string;
  readonly resource: string;
  readonly action: string;
  readonly description: string;
  readonly isHighRisk: boolean;
  readonly requiresReauth: boolean;
  readonly minPhase: number;
  readonly migration: string;
}

const ROW = new RegExp(
  String.raw`\(\s*'([a-z_]+\.[a-z_]+)',\s*'([a-z_]+)',\s*'([a-z_]+)',\s*'((?:[^']|'')*)',\s*` +
    String.raw`(true|false),\s*(true|false),\s*(\d+)\s*\)`,
  'g',
);

/**
 * Every permission any migration seeds.
 *
 * Migrations are forward-only (ADR-0008 §3), so the registry cannot be regenerated
 * in place when a route is added — the checksum gate would reject the edit, and
 * rightly. Instead the seed is *accumulated* across migrations and compared with
 * the contract as a set. Adding a permission therefore means adding a migration,
 * which is the correct amount of ceremony for a change that widens what a role can
 * be granted.
 */
const DESCRIPTION_UPDATE =
  /UPDATE\s+permissions\s+SET\s+description\s*=\s*'((?:[^']|'')*)'\s*WHERE\s+code\s*=\s*'([a-z_]+\.[a-z_]+)'/gi;

/**
 * A later migration reclassifying a permission's risk (F-921).
 *
 * The accumulated seed has to describe the rows a fresh database would actually
 * contain. Without this, a reclassification applied by migration is invisible to
 * every check that reads these files, and the contract check reports drift that
 * has in fact already been corrected — which trains people to ignore it.
 */
const RISK_UPDATE =
  /UPDATE\s+permissions\s+SET\s+is_high_risk\s*=\s*(true|false)\s*,\s*requires_reauth\s*=\s*(true|false)\s*WHERE\s+code\s*=\s*'([a-z_]+\.[a-z_]+)'/gi;

export function seededPermissions(): SeededPermission[] {
  const out: SeededPermission[] = [];
  for (const file of readdirSync(SCHEMA_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()) {
    const sql = readFileSync(join(SCHEMA_DIR, file), 'utf8');
    // Only the INSERT ... VALUES blocks, so a comment mentioning a tuple cannot
    // masquerade as a seeded row.
    for (const block of sql.split(/INSERT\s+INTO\s+permissions\b/i).slice(1)) {
      const statement = block.split(/;\s*$/m)[0] ?? '';
      ROW.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = ROW.exec(statement)) !== null) {
        out.push({
          code: m[1]!,
          resource: m[2]!,
          action: m[3]!,
          description: m[4]!.replace(/''/g, "'"),
          isHighRisk: m[5] === 'true',
          requiresReauth: m[6] === 'true',
          minPhase: Number(m[7]),
          migration: file,
        });
      }
    }

    // Descriptions restated by a later phase. Applied in migration order for the
    // same reason the database applies them in migration order: the accumulated
    // seed has to describe the rows a fresh database would actually contain, not
    // the rows the first INSERT created.
    DESCRIPTION_UPDATE.lastIndex = 0;
    let u: RegExpExecArray | null;
    while ((u = DESCRIPTION_UPDATE.exec(sql)) !== null) {
      const code = u[2]!;
      const index = out.findIndex((p) => p.code === code);
      if (index >= 0) {
        out[index] = {
          ...out[index]!,
          description: u[1]!.replace(/''/g, "'"),
          migration: `${out[index]!.migration} (restated by ${file})`,
        };
      }
    }

    RISK_UPDATE.lastIndex = 0;
    let r: RegExpExecArray | null;
    while ((r = RISK_UPDATE.exec(sql)) !== null) {
      const code = r[3]!;
      const index = out.findIndex((p) => p.code === code);
      if (index >= 0) {
        out[index] = {
          ...out[index]!,
          isHighRisk: r[1] === 'true',
          requiresReauth: r[2] === 'true',
          migration: `${out[index]!.migration} (reclassified by ${file})`,
        };
      }
    }
  }
  return out;
}

export const sqlString = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * Renders the seed rows for a migration.
 *
 * `requires_reauth` mirrors `is_high_risk`: ADR-0005 §3 names the same seven
 * categories as the ones that "drive reauthentication and segregation-of-duties
 * rules", and inventing a second, narrower list here would put a security boundary
 * in a code comment instead of in the decision record.
 */
export function renderPermissionSeed(defs: readonly PermissionDefinition[]): string {
  const rows = defs.map(
    (p) =>
      `  (${sqlString(p.code)}, ${sqlString(p.resource)}, ${sqlString(p.action)}, ` +
      `${sqlString(p.description)}, ${p.isHighRisk}, ${p.isHighRisk}, ${p.minPhase})`,
  );
  return (
    'INSERT INTO permissions (code, resource, action, description, is_high_risk, requires_reauth, min_phase) VALUES\n' +
    rows.join(',\n') +
    ';\n'
  );
}
