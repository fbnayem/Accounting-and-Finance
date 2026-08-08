import { describe, it, expect } from 'vitest';
import {
  EVENT_TYPES,
  OPERATION_IDS,
  PERMISSIONS,
  isKnownEvent,
  eventScope,
  canonicalEventName,
  operation,
  operationsRequiringIdempotency,
} from './index';

describe('event contract', () => {
  it('carries the full canonical catalog', () => {
    expect(EVENT_TYPES.length).toBeGreaterThanOrEqual(177);
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
  });

  it('recognises canonical names and rejects invented ones', () => {
    expect(isKnownEvent('tenant.created')).toBe(true);
    expect(isKnownEvent('tenant.was_created_probably')).toBe(false);
  });

  it('maps superseded names to their replacement (F-101)', () => {
    // doc 05's prose said `bill.posted`; the canonical name is `vendor_bill.posted`.
    expect(canonicalEventName('bill.posted')).toBe('vendor_bill.posted');
    expect(isKnownEvent('bill.posted')).toBe(false);
    expect(isKnownEvent('vendor_bill.posted')).toBe(true);
  });

  it('records a split rather than pretending one name replaced another', () => {
    // Soft and hard close are different states with different consequences, so
    // the superseded name points at both.
    expect(canonicalEventName('accounting_period.closed')).toContain('soft_closed');
    expect(canonicalEventName('accounting_period.closed')).toContain('hard_closed');
  });

  it('marks platform events as the only ones that may omit legal_entity_id', () => {
    expect(eventScope('tenant.created')).toBe('platform');
    expect(eventScope('journal_entry.posted')).toBe('entity');
  });
});

describe('route contract', () => {
  it('carries every operation and a derived permission registry', () => {
    expect(OPERATION_IDS.length).toBeGreaterThanOrEqual(260);
    expect(PERMISSIONS.length).toBeGreaterThan(100);
  });

  it('exposes the Phase 0 health operation without a permission', () => {
    const health = operation('getHealth');
    expect(health?.method).toBe('GET');
    expect(health?.permission).toBeNull();
    expect(health?.phase).toBe(0);
  });

  it('lists the operations whose Idempotency-Key is mandatory', () => {
    const required = operationsRequiringIdempotency();
    expect(required.length).toBeGreaterThan(0);
    expect(required.every((o) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(o.method))).toBe(true);
  });
});
