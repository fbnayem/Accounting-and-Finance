import { AsyncLocalStorage } from 'node:async_hooks';
import { newCorrelationId } from './ids';

/**
 * Request context, propagated without being threaded through every signature.
 *
 * Phase 0 exit criterion 5 — "Logs trace a request across API and worker by
 * correlation ID" — needs the correlation ID available at the logger, at the
 * database layer (to stamp `audit_events.correlation_id`) and at the outbox
 * writer (to stamp the event envelope), none of which the calling code should
 * have to remember to pass.
 *
 * The scope fields are here for the same reason: ADR-0002 makes tenant and entity
 * part of every query's identity, and a helper that has to be *given* the tenant
 * is a helper someone will one day call without one.
 */
export interface RequestContext {
  readonly correlationId: string;
  readonly causationId?: string;
  readonly tenantId?: string;
  readonly organizationId?: string;
  readonly legalEntityId?: string;
  readonly accountingBookId?: string;
  readonly branchId?: string;
  readonly actorId?: string;
  readonly actorKind?: 'USER' | 'SERVICE' | 'SYSTEM' | 'AI';
  /** doc 23: support impersonation records both actors, never just the operator. */
  readonly impersonatedBy?: string;
  readonly idempotencyKey?: string;
  readonly requestPath?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/**
 * Never throws. A background task with no request context still needs a
 * correlation ID for its logs; inventing one is better than logging none, and
 * better than making every caller handle `undefined`.
 */
export function requireContext(): RequestContext {
  return storage.getStore() ?? { correlationId: newCorrelationId(), actorKind: 'SYSTEM' };
}

export function withScope(extra: Partial<RequestContext>): RequestContext {
  return { ...requireContext(), ...extra };
}

/** The subset that travels on a queue job, so a worker can rebuild the context. */
export interface PropagatedContext {
  correlationId: string;
  causationId?: string;
  tenantId?: string;
  organizationId?: string;
  legalEntityId?: string;
  actorId?: string;
  actorKind?: RequestContext['actorKind'];
}

export function propagate(ctx: RequestContext = requireContext()): PropagatedContext {
  const out: PropagatedContext = { correlationId: ctx.correlationId };
  if (ctx.causationId) out.causationId = ctx.causationId;
  if (ctx.tenantId) out.tenantId = ctx.tenantId;
  if (ctx.organizationId) out.organizationId = ctx.organizationId;
  if (ctx.legalEntityId) out.legalEntityId = ctx.legalEntityId;
  if (ctx.actorId) out.actorId = ctx.actorId;
  if (ctx.actorKind) out.actorKind = ctx.actorKind;
  return out;
}

export const CORRELATION_HEADER = 'x-correlation-id';
export const CAUSATION_HEADER = 'x-causation-id';
export const IDEMPOTENCY_HEADER = 'idempotency-key';
