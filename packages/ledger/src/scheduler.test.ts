import { describe, it, expect } from 'vitest';
import { deterministicOccurrenceId, nextRunDate, servicePrincipal } from './scheduler';
import { can, canInEntity } from '@acct/domain';

/**
 * The parts of the scheduler that do not need a database.
 *
 * Both of them are the kind of thing that looks obviously correct and is quietly
 * wrong for eleven months of the year — recurrence dates and derived identifiers —
 * so they are tested against the cases that actually break.
 */

describe('nextRunDate', () => {
  it('advances daily and weekly across a month boundary', () => {
    expect(nextRunDate('2027-01-31', 'DAILY')).toBe('2027-02-01');
    expect(nextRunDate('2027-01-28', 'WEEKLY')).toBe('2027-02-04');
  });

  it('clamps rather than rolling over when the day does not exist', () => {
    // The one that matters. Naive month arithmetic turns 31 January into 3 March,
    // which posts the accrual into the wrong period and balances perfectly.
    expect(nextRunDate('2027-01-31', 'MONTHLY')).toBe('2027-02-28');
    expect(nextRunDate('2027-03-31', 'MONTHLY')).toBe('2027-04-30');
    expect(nextRunDate('2027-08-31', 'MONTHLY')).toBe('2027-09-30');
  });

  it('handles a leap year', () => {
    expect(nextRunDate('2028-01-31', 'MONTHLY')).toBe('2028-02-29');
    expect(nextRunDate('2028-02-29', 'ANNUAL')).toBe('2029-02-28');
  });

  it('advances quarterly and annually', () => {
    expect(nextRunDate('2027-01-15', 'QUARTERLY')).toBe('2027-04-15');
    expect(nextRunDate('2027-11-30', 'QUARTERLY')).toBe('2028-02-29');
    expect(nextRunDate('2027-06-30', 'ANNUAL')).toBe('2028-06-30');
  });

  it('keeps a mid-month day exactly where it is', () => {
    for (let month = 1; month <= 12; month++) {
      const from = `2027-${String(month).padStart(2, '0')}-15`;
      expect(nextRunDate(from, 'MONTHLY').slice(8)).toBe('15');
    }
  });
});

describe('deterministicOccurrenceId', () => {
  const template = '0195b0a0-1111-7000-8000-000000000001';

  it('is stable for the same template and date', () => {
    expect(deterministicOccurrenceId(template, '2027-03-31')).toBe(
      deterministicOccurrenceId(template, '2027-03-31'),
    );
  });

  it('differs per date and per template', () => {
    const a = deterministicOccurrenceId(template, '2027-03-31');
    const b = deterministicOccurrenceId(template, '2027-04-30');
    const c = deterministicOccurrenceId('0195b0a0-2222-7000-8000-000000000002', '2027-03-31');
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('is a well-formed uuid', () => {
    const id = deterministicOccurrenceId(template, '2027-03-31');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('does not collide across a year of monthly occurrences for many templates', () => {
    // The failure this guards against is not theoretical: a truncated uuidv7 was
    // used as an identity in Phase 0 and repeated every 65 seconds. Here a
    // collision would mean two occurrences sharing a source_event_id, and the
    // second month's journal silently resolving to the first month's entry.
    const ids = new Set<string>();
    for (let t = 0; t < 500; t++) {
      for (let m = 1; m <= 12; m++) {
        ids.add(
          deterministicOccurrenceId(
            `0195b0a0-0000-7000-8000-${String(t).padStart(12, '0')}`,
            `2027-${String(m).padStart(2, '0')}-01`,
          ),
        );
      }
    }
    expect(ids.size).toBe(6000);
  });
});

describe('servicePrincipal', () => {
  it('holds exactly the permissions it is given and nothing else', () => {
    const principal = servicePrincipal({
      tenantId: 'tenant-1',
      userId: 'system',
      permissions: ['journal.view', 'journal.reverse'],
    });
    expect(can(principal, 'journal.reverse')).toBe(true);
    expect(can(principal, 'journal.post')).toBe(false);
    expect(can(principal, 'role.manage')).toBe(false);
  });

  it('is tenant-wide within its tenant, and holds nothing outside it', () => {
    const principal = servicePrincipal({
      tenantId: 'tenant-1',
      userId: 'system',
      permissions: ['journal.view'],
    });
    // A null legalEntityId grant means every entity in the tenant, which is what a
    // scheduler needs — it acts on rows from any of them. The tenant boundary is
    // still absolute: `tenantId` is on the principal, and every query filters on it.
    expect(canInEntity(principal, 'journal.view', 'any-entity')).toBe(true);
    expect(principal.tenantId).toBe('tenant-1');
  });

  it('never claims MFA', () => {
    const principal = servicePrincipal({
      tenantId: 'tenant-1',
      userId: 'system',
      permissions: ['journal.post_control'],
    });
    // It holds a high-risk permission and has not re-authenticated. Anything that
    // demands recent MFA must therefore refuse it, rather than the scheduler
    // quietly being the one caller that never has to.
    expect(principal.mfaSatisfied).toBe(false);
    expect(principal.mfaVerifiedAt).toBeNull();
  });
});
