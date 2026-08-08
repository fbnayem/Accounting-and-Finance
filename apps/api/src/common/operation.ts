/**
 * Binds a route handler to its entry in contracts/openapi.yaml.
 *
 * Phase 1 exit criterion 4 is "role/permission tests cover every finance mutation
 * route created in this phase", and Gate B says the same thing about every mutation
 * route. The usual way to satisfy that is to write one authorization test per route
 * and hope nobody adds a route without one — which is a coverage claim that decays
 * from the day it is made.
 *
 * Here the handler declares only *which operation it is*. The required permission,
 * whether a session is needed, and whether an Idempotency-Key is mandatory are all
 * read from the generated contract at request time. A route therefore cannot
 * declare the wrong permission, because it does not declare one; and
 * `assertRoutesMatchContract` fails at boot if a handler's method and path disagree
 * with the contract, or if a Phase 1 operation has no handler at all.
 */
import { HttpCode, SetMetadata, applyDecorators, type INestApplication } from '@nestjs/common';
import { OPERATIONS, operation, type OperationDefinition, type OperationId } from '@acct/contracts';

export const OPERATION_METADATA = 'acct:operation';

/**
 * The phases whose routes must all exist.
 *
 * One list, read by `main.ts` at boot and by the authorization test that generates
 * a case per mutation. Keeping them in step matters more than it looks: if the two
 * ever disagreed, the boot check could demand a handler the test never covers, or
 * the test could quietly stop covering a phase the API still serves.
 */
export const DELIVERED_PHASES = [0, 1, 2, 3] as const;

/**
 * The status code comes from the contract too. `OPERATIONS` is a compile-time
 * constant, so `HttpCode` is applied at decoration time from the lowest 2xx the
 * document declares — a handler cannot answer 200 where the contract promises 201,
 * and nobody has to remember `@HttpCode` separately.
 */
export const Operation = (id: OperationId): MethodDecorator =>
  applyDecorators(SetMetadata(OPERATION_METADATA, id), HttpCode(OPERATIONS[id].successStatus));

/**
 * For the handful of endpoints that exist outside the contract: the liveness and
 * readiness probes. Marked explicitly, because the guards deny anything carrying
 * neither marker — an unmarked route is far more likely to be an oversight than a
 * deliberately public one.
 */
export const ANONYMOUS_METADATA = 'acct:anonymous';
export const Anonymous = (): MethodDecorator => SetMetadata(ANONYMOUS_METADATA, true);

export function operationOrThrow(id: string): OperationDefinition {
  const def = operation(id);
  if (!def) throw new Error(`no operation "${id}" in contracts/openapi.yaml`);
  return def;
}

// ---------------------------------------------------------------------------
// Boot-time reconciliation
// ---------------------------------------------------------------------------

/** OpenAPI writes `/legal-entities/{id}`; Express writes `/legal-entities/:id`. */
export function toContractPath(expressPath: string): string {
  const normalised = expressPath.replace(/:([A-Za-z0-9_]+)/g, '{$1}').replace(/\/+$/, '');
  return normalised === '' ? '/' : normalised;
}

export interface RouteMismatch {
  readonly kind: 'unmarked' | 'unknown-operation' | 'path-mismatch' | 'missing-handler';
  readonly detail: string;
}

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: { handle: unknown }[] };
  handle?: { stack?: RouteLayer[] };
}

/**
 * Walks the Express router the application actually built and reconciles it with
 * the contract.
 *
 * Reading the router rather than the decorator metadata is the point: metadata says
 * what someone intended, the router says what is reachable. A controller that was
 * never registered in a module has perfectly good metadata and no route.
 */
export function reconcileRoutes(
  app: INestApplication,
  options: { phases: readonly number[] },
): { mismatches: RouteMismatch[]; matched: number } {
  const server = app.getHttpAdapter().getInstance() as {
    _router?: { stack: RouteLayer[] };
    router?: { stack: RouteLayer[] };
  };
  const stack = (server._router ?? server.router)?.stack ?? [];

  const mismatches: RouteMismatch[] = [];
  const seen = new Set<string>();
  let matched = 0;

  const visit = (layers: RouteLayer[]): void => {
    for (const layer of layers) {
      if (layer.handle?.stack) visit(layer.handle.stack);
      if (!layer.route) continue;

      const path = toContractPath(layer.route.path);
      for (const method of Object.keys(layer.route.methods).filter((m) => m !== '_all')) {
        const handler = layer.route.stack[layer.route.stack.length - 1]?.handle;
        const id = handler ? Reflect.getMetadata(OPERATION_METADATA, handler) : undefined;
        const anonymous = handler ? Reflect.getMetadata(ANONYMOUS_METADATA, handler) : undefined;
        if (anonymous) continue;

        if (!id) {
          mismatches.push({
            kind: 'unmarked',
            detail: `${method.toUpperCase()} ${path} carries no @Operation and is not @Anonymous`,
          });
          continue;
        }
        const def = operation(String(id));
        if (!def) {
          mismatches.push({
            kind: 'unknown-operation',
            detail: `${method.toUpperCase()} ${path} declares @Operation('${id}'), which is not in the contract`,
          });
          continue;
        }
        if (def.method.toLowerCase() !== method.toLowerCase() || def.path !== path) {
          mismatches.push({
            kind: 'path-mismatch',
            detail:
              `${id} is mounted at ${method.toUpperCase()} ${path} but the contract says ` +
              `${def.method} ${def.path}`,
          });
          continue;
        }
        seen.add(def.operationId);
        matched++;
      }
    }
  };
  visit(stack);

  // The other direction. Without it, deleting a controller silently reduces the API
  // and every "all routes are covered" statement stays true by getting smaller.
  const expected = Object.values(OPERATIONS).filter((o) => options.phases.includes(o.phase));
  for (const def of expected) {
    if (!seen.has(def.operationId)) {
      mismatches.push({
        kind: 'missing-handler',
        detail: `${def.method} ${def.path} (${def.operationId}, phase ${def.phase}) has no handler`,
      });
    }
  }

  return { mismatches, matched };
}
