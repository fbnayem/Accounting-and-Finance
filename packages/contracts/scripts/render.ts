/**
 * Renders the generated contract modules from the canonical YAML.
 *
 * Pure: it returns file contents and writes nothing. `generate.ts` writes them,
 * `check.ts` compares them against what is committed. Sharing the renderer means
 * the check cannot disagree with the generator, which is the failure mode a
 * "regenerate then diff" script run as a subprocess is prone to.
 */
import { loadEvents, loadOperations, permissionRegistry } from './shared';

const BANNER = `// GENERATED FILE - do not edit.
// Source: contracts/events.yaml, contracts/openapi.yaml
// Regenerate: pnpm contracts:generate   |   Verify: pnpm contracts:check
`;

export function renderGenerated(): Record<string, string> {
  const { events, forbidden } = loadEvents();
  const operations = loadOperations();
  const sortedEvents = [...events].sort((a, b) => a.type.localeCompare(b.type));

  const eventsFile = `${BANNER}
/**
 * platform events may carry a null legal_entity_id; entity and book events may not.
 * book narrows further - the event also belongs to one accounting book.
 */
export type EventScope = 'platform' | 'entity' | 'book';

export interface EventDefinition {
  readonly type: string;
  readonly context: string;
  readonly scope: EventScope;
  readonly phase: number;
  readonly status: 'stable' | 'new' | 'renamed' | 'split';
  readonly was?: string;
}

export const EVENT_TYPES = [
${sortedEvents.map((e) => `  '${e.type}',`).join('\n')}
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_DEFINITIONS: Readonly<Record<EventType, EventDefinition>> = {
${sortedEvents
  .map(
    (e) =>
      `  '${e.type}': { type: '${e.type}', context: '${e.context}', scope: '${e.scope}', phase: ${e.phase}, status: '${e.status}'${
        e.was ? `, was: '${e.was}'` : ''
      } },`,
  )
  .join('\n')}
};

/**
 * Superseded names, mapped to what replaced them.
 *
 * The key must never be published; the value says what to publish instead.
 * contracts/README.md rule 2 records these so a developer grepping the old module
 * prose lands on the canonical form rather than reintroducing the drift F-101
 * catalogued. The value is guidance rather than always a single type:
 * accounting_period.closed was split into two states with different consequences.
 */
export const FORBIDDEN_EVENT_NAMES: Readonly<Record<string, string>> = {
${Object.entries(forbidden)
  .map(([superseded, replacement]) => `  '${superseded}': ${JSON.stringify(String(replacement))},`)
  .join('\n')}
};
`;

  const permissions = permissionRegistry(operations);

  const operationsFile = `${BANNER}
/**
 * A permission that gates a condition inside a route rather than the route itself
 * (F-503) - post to a control account, override a tax code, accept a suspected
 * duplicate. Declared by x-additional-permissions in contracts/openapi.yaml.
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
  /** security: [] - reachable without a session (login, refresh, MFA, health). */
  readonly unauthenticated: boolean;
  /** Authenticated but permission-free, acting only on the caller's own resources. */
  readonly selfService: boolean;
  readonly additionalPermissions: readonly AdditionalPermission[];
  /** The success status the contract declares - the lowest 2xx in its responses. */
  readonly successStatus: number;
}

export interface PermissionDefinition {
  readonly code: string;
  readonly resource: string;
  readonly action: string;
  readonly description: string;
  readonly isHighRisk: boolean;
  readonly minPhase: number;
}

export const OPERATION_IDS = [
${operations.map((o) => `  '${o.operationId}',`).join('\n')}
] as const;

export type OperationId = (typeof OPERATION_IDS)[number];

export const OPERATIONS: Readonly<Record<OperationId, OperationDefinition>> = {
${operations
  .map(
    (o) =>
      `  ${o.operationId}: { operationId: '${o.operationId}', method: '${o.method}', path: '${o.path}', tag: '${o.tag}', permission: ${
        o.permission === null ? 'null' : `'${o.permission}'`
      }, idempotency: '${o.idempotency}', phase: ${o.phase}, highRisk: ${o.highRisk}, unauthenticated: ${o.unauthenticated}, selfService: ${o.selfService}, additionalPermissions: [${o.additionalPermissions
        .map(
          (a) =>
            `{ code: '${a.code}', description: ${JSON.stringify(a.description)}, highRisk: ${a.highRisk} }`,
        )
        .join(', ')}], successStatus: ${o.successStatus} },`,
  )
  .join('\n')}
};

/**
 * The permission registry, generated from x-permission and x-additional-permissions.
 *
 * contracts/README.md rule 3: CI fails if a route declares a permission absent
 * from this list, or a role references one that does not exist. That is what makes
 * Gate B's "authorization tests cover every mutation route" provable rather than
 * asserted. contracts/schema/0022_permission_registry.sql seeds the same rows into
 * the database, and contract check 13 fails if the two ever disagree.
 */
export const PERMISSIONS = [
${permissions.map((p) => `  '${p.code}',`).join('\n')}
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_DEFINITIONS: Readonly<Record<Permission, PermissionDefinition>> = {
${permissions
  .map(
    (p) =>
      `  '${p.code}': { code: '${p.code}', resource: '${p.resource}', action: '${p.action}', description: ${JSON.stringify(
        p.description,
      )}, isHighRisk: ${p.isHighRisk}, minPhase: ${p.minPhase} },`,
  )
  .join('\n')}
};

/**
 * doc 02's seven high-risk categories, as codes. These drive reauthentication and
 * segregation-of-duties handling (ADR-0005 §3), so they are exported separately
 * rather than left to callers to re-derive by filtering.
 */
export const HIGH_RISK_PERMISSIONS = [
${permissions
  .filter((p) => p.isHighRisk)
  .map((p) => `  '${p.code}',`)
  .join('\n')}
] as const;
`;

  return { 'events.ts': eventsFile, 'operations.ts': operationsFile };
}
