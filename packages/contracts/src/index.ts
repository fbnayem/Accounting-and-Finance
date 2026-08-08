/**
 * @acct/contracts — the compiled form of contracts/events.yaml and
 * contracts/openapi.yaml, which Deliverable 2 made the single source of truth for
 * events and routes.
 *
 * Nothing here is hand-written apart from the lookups: the data comes from
 * `src/generated/`, which `pnpm contracts:generate` produces and CI verifies is
 * current.
 */
export * from './generated/events';
export * from './generated/operations';

import {
  EVENT_DEFINITIONS,
  EVENT_TYPES,
  FORBIDDEN_EVENT_NAMES,
  type EventDefinition,
  type EventScope,
  type EventType,
} from './generated/events';
import {
  OPERATIONS,
  PERMISSIONS,
  type OperationDefinition,
  type OperationId,
  type Permission,
} from './generated/operations';

export function isKnownEvent(type: string): type is EventType {
  return Object.prototype.hasOwnProperty.call(EVENT_DEFINITIONS, type);
}

export function eventDefinition(type: string): EventDefinition | undefined {
  return isKnownEvent(type) ? EVENT_DEFINITIONS[type] : undefined;
}

/**
 * `platform` events may carry a null `legal_entity_id`; everything else may not.
 * The outbox writer enforces this, which is what keeps F-041's envelope
 * requirement true of the data rather than only of the document.
 */
export function eventScope(type: string): EventScope {
  return eventDefinition(type)?.scope ?? 'entity';
}

export function eventPhase(type: string): number | undefined {
  return eventDefinition(type)?.phase;
}

/**
 * Given a superseded event name, returns what replaced it.
 *
 * Not always a single type: `accounting_period.closed` was split into
 * `soft_closed` and `hard_closed` because, as contracts/events.yaml puts it, they
 * "are different states with different consequences".
 */
export function canonicalEventName(type: string): string | undefined {
  return FORBIDDEN_EVENT_NAMES[type];
}

export function isSupersededEventName(type: string): boolean {
  return Object.prototype.hasOwnProperty.call(FORBIDDEN_EVENT_NAMES, type);
}

export function eventsForPhase(phase: number): EventDefinition[] {
  return EVENT_TYPES.map((t) => EVENT_DEFINITIONS[t]).filter((e) => e.phase === phase);
}

export function isKnownOperation(id: string): id is OperationId {
  return Object.prototype.hasOwnProperty.call(OPERATIONS, id);
}

export function operation(id: string): OperationDefinition | undefined {
  return isKnownOperation(id) ? OPERATIONS[id] : undefined;
}

export function operationsForPhase(phase: number): OperationDefinition[] {
  return Object.values(OPERATIONS).filter((o) => o.phase === phase);
}

export function isKnownPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/** Operations that must reject a request with no Idempotency-Key header. */
export function operationsRequiringIdempotency(): OperationDefinition[] {
  return Object.values(OPERATIONS).filter((o) => o.idempotency === 'required');
}
