import { describe, expect, it } from 'vitest';
import { AppError } from '@acct/domain';
import {
  activeStepNo,
  approversSoFar,
  assertDualApproval,
  assertSegregationOfDuties,
  delegationPermits,
  isActionable,
  notActionableBecause,
  stepOutcome,
  type DelegationGrant,
  type StepState,
} from './steps';

const step = (overrides: Partial<StepState> = {}): StepState => ({
  id: 'step-1',
  stepNo: 1,
  isParallel: false,
  approverUserId: 'approver-1',
  approverRoleId: null,
  resolvedFrom: 'NAMED_USER',
  status: 'PENDING',
  decision: null,
  decidedBy: null,
  expiresAt: null,
  ...overrides,
});

const NOW = new Date('2027-03-15T12:00:00.000Z');

describe('serial ordering', () => {
  const steps = [
    step({ id: 'a', stepNo: 1 }),
    step({ id: 'b', stepNo: 2, approverUserId: 'approver-2' }),
  ];

  it('makes the lowest pending step the active one', () => {
    expect(activeStepNo(steps)).toBe(1);
  });

  it('permits the active step', () => {
    expect(isActionable({ step: steps[0]!, steps, now: NOW })).toBe(true);
  });

  it('refuses a later step while an earlier one is pending — the simplest bypass', () => {
    const reason = notActionableBecause({ step: steps[1]!, steps, now: NOW });
    expect(reason).toEqual({ kind: 'NOT_ACTIVE', activeStepNo: 1 });
  });

  it('activates the next step once the first is decided', () => {
    const advanced = [
      { ...steps[0]!, status: 'APPROVED' as const, decidedBy: 'approver-1' },
      steps[1]!,
    ];
    expect(activeStepNo(advanced)).toBe(2);
    expect(isActionable({ step: advanced[1]!, steps: advanced, now: NOW })).toBe(true);
  });

  it('refuses a step that has already been decided', () => {
    const decided = step({ status: 'APPROVED', decidedBy: 'approver-1' });
    expect(notActionableBecause({ step: decided, steps: [decided], now: NOW })).toEqual({
      kind: 'DECIDED',
      status: 'APPROVED',
    });
  });
});

describe('expiry fails CLOSED', () => {
  const expired = step({ expiresAt: '2027-03-15T11:59:59.000Z' });
  const live = step({ expiresAt: '2027-03-15T12:00:01.000Z' });

  it('refuses a decision on an expired task', () => {
    expect(notActionableBecause({ step: expired, steps: [expired], now: NOW })).toEqual({
      kind: 'EXPIRED',
      expiredAt: '2027-03-15T11:59:59.000Z',
    });
  });

  it('permits a decision one second before expiry — the other half', () => {
    expect(isActionable({ step: live, steps: [live], now: NOW })).toBe(true);
  });

  it('leaves the step PENDING rather than approving it', () => {
    // The point of failing closed: an expired step is still awaiting a decision,
    // so the request never reaches SATISFIED by the passage of time.
    expect(stepOutcome([expired], 1)).toBe('PENDING');
    expect(activeStepNo([expired])).toBe(1);
  });
});

describe('quorum and parallel determinism', () => {
  const parallel = (id: string, status: StepState['status'], decidedBy: string | null) =>
    step({
      id,
      isParallel: true,
      status,
      decidedBy,
      decision: status === 'APPROVED' ? 'APPROVE' : status === 'REJECTED' ? 'REJECT' : null,
    });

  it('needs the whole quorum', () => {
    expect(stepOutcome([parallel('a', 'APPROVED', 'u1'), parallel('b', 'PENDING', null)], 2)).toBe(
      'PENDING',
    );
  });

  it('is satisfied at the quorum', () => {
    expect(stepOutcome([parallel('a', 'APPROVED', 'u1'), parallel('b', 'APPROVED', 'u2')], 2)).toBe(
      'SATISFIED',
    );
  });

  it('does not count one person twice toward a quorum', () => {
    expect(stepOutcome([parallel('a', 'APPROVED', 'u1'), parallel('b', 'APPROVED', 'u1')], 2)).toBe(
      'PENDING',
    );
  });

  it('lets a rejection dominate, whichever order the decisions arrived in', () => {
    const approveFirst = [parallel('a', 'APPROVED', 'u1'), parallel('b', 'REJECTED', 'u2')];
    const rejectFirst = [parallel('b', 'REJECTED', 'u2'), parallel('a', 'APPROVED', 'u1')];
    expect(stepOutcome(approveFirst, 1)).toBe('REJECTED');
    expect(stepOutcome(rejectFirst, 1)).toBe('REJECTED');
  });

  it('lists each distinct approver once', () => {
    expect(
      approversSoFar([parallel('a', 'APPROVED', 'u1'), parallel('b', 'APPROVED', 'u1')]),
    ).toEqual(['u1']);
  });
});

describe('segregation of duties', () => {
  const base = {
    preparedBy: 'maker',
    requestedBy: 'maker',
    actorId: 'checker',
    authorityOf: 'checker',
    priorApprovers: [] as string[],
    requireDistinctApprovers: true,
    reference: 'Journal JE-1',
  };

  it('permits a different person — the half that keeps this from being an outage', () => {
    expect(() => assertSegregationOfDuties(base)).not.toThrow();
  });

  it('refuses the preparer', () => {
    expect(() => assertSegregationOfDuties({ ...base, actorId: 'maker' })).toThrowError(
      /you prepared/i,
    );
  });

  it('refuses the requester', () => {
    expect(() =>
      assertSegregationOfDuties({ ...base, requestedBy: 'submitter', actorId: 'submitter' }),
    ).toThrowError(/requested approval/i);
  });

  /**
   * The NULL case, negative-tested specifically.
   *
   * `approver <> preparer` against a NULL preparer is NULL, and a NULL CHECK
   * PASSES — which is how `pr_maker_checker` was decorative for exactly the rows
   * where it mattered most. The rule here refuses instead.
   */
  it('refuses when the preparer is unknown', () => {
    let thrown: AppError | undefined;
    try {
      assertSegregationOfDuties({ ...base, preparedBy: null });
    } catch (error) {
      thrown = error as AppError;
    }
    expect(thrown?.code).toBe('SEGREGATION_OF_DUTIES');
    expect(thrown?.message).toMatch(/records no preparer/);
  });

  it('refuses when the requester is unknown', () => {
    expect(() => assertSegregationOfDuties({ ...base, requestedBy: null })).toThrowError(
      /records no requester/,
    );
  });

  it("refuses a delegate acting on the preparer's authority", () => {
    // The delegate is a different person, so every naive check passes. What is
    // wrong is whose authority is being exercised: the preparer's.
    expect(() =>
      assertSegregationOfDuties({ ...base, actorId: 'delegate', authorityOf: 'maker' }),
    ).toThrowError(/even as their delegate/);
  });

  it('refuses one person satisfying two steps when the workflow forbids it', () => {
    expect(() => assertSegregationOfDuties({ ...base, priorApprovers: ['checker'] })).toThrowError(
      /already approved/,
    );
  });

  it('permits one person satisfying two steps when the workflow allows it', () => {
    expect(() =>
      assertSegregationOfDuties({
        ...base,
        priorApprovers: ['checker'],
        requireDistinctApprovers: false,
      }),
    ).not.toThrow();
  });
});

describe('dual approval over threshold', () => {
  const base = {
    threshold: '10000.00',
    amount: '25000.00',
    currency: 'USD',
    preparedBy: 'maker',
    approvers: ['checker-1', 'checker-2'],
    reference: 'Payment run PR-1',
  };

  it('permits two distinct approvals over the threshold', () => {
    expect(() => assertDualApproval(base)).not.toThrow();
  });

  it('refuses one approval over the threshold, naming both numbers', () => {
    let thrown: AppError | undefined;
    try {
      assertDualApproval({ ...base, approvers: ['checker-1'] });
    } catch (error) {
      thrown = error as AppError;
    }
    expect(thrown?.code).toBe('APPROVAL_REQUIRED');
    expect(thrown?.message).toContain('25000.00');
    expect(thrown?.message).toContain('10000.00');
  });

  it('permits one approval below the threshold', () => {
    expect(() =>
      assertDualApproval({ ...base, amount: '9999.99', approvers: ['checker-1'] }),
    ).not.toThrow();
  });

  it('takes effect exactly at the threshold', () => {
    expect(() =>
      assertDualApproval({ ...base, amount: '10000.00', approvers: ['checker-1'] }),
    ).toThrowError(/Two distinct approvals/);
  });

  it('does nothing when the rule is not configured', () => {
    expect(() =>
      assertDualApproval({ ...base, threshold: null, approvers: ['checker-1'] }),
    ).not.toThrow();
  });

  it('refuses when the preparer is one of the two approvers', () => {
    expect(() => assertDualApproval({ ...base, approvers: ['maker', 'checker-2'] })).toThrowError(
      /approved by the person who prepared it/,
    );
  });

  it('refuses when the preparer is unknown', () => {
    expect(() => assertDualApproval({ ...base, preparedBy: null })).toThrowError(
      /records no preparer/,
    );
  });
});

describe('delegation', () => {
  const grant = (overrides: Partial<DelegationGrant> = {}): DelegationGrant => ({
    id: 'delegation-1',
    delegatorUserId: 'approver-1',
    delegateUserId: 'cover-1',
    scopeResourceType: 'JOURNAL',
    legalEntityId: 'entity-1',
    maxAmount: '5000.00',
    validFrom: '2027-03-01T00:00:00.000Z',
    validTo: '2027-03-31T00:00:00.000Z',
    ...overrides,
  });

  const question = {
    delegatorUserId: 'approver-1',
    actorId: 'cover-1',
    resourceType: 'JOURNAL',
    legalEntityId: 'entity-1',
    amount: '4000.00',
    now: NOW,
  };

  it('permits the delegate inside the window, scope and cap', () => {
    expect(delegationPermits({ ...question, grants: [grant()] }).permitted).toBe(true);
  });

  it('refuses above the cap, exactly', () => {
    const answer = delegationPermits({
      ...question,
      amount: '5000.01',
      grants: [grant()],
    });
    expect(answer.permitted).toBe(false);
    expect(answer.permitted === false && answer.reason).toMatch(/capped at 5000.00/);
  });

  it('permits at the cap, exactly', () => {
    expect(delegationPermits({ ...question, amount: '5000.00', grants: [grant()] }).permitted).toBe(
      true,
    );
  });

  it('refuses after the window closes', () => {
    expect(
      delegationPermits({
        ...question,
        grants: [grant({ validTo: '2027-03-15T11:00:00.000Z' })],
      }).permitted,
    ).toBe(false);
  });

  it('refuses outside the delegated resource type', () => {
    expect(
      delegationPermits({ ...question, resourceType: 'VENDOR_BILL', grants: [grant()] }).permitted,
    ).toBe(false);
  });

  it('refuses another entity', () => {
    expect(
      delegationPermits({ ...question, legalEntityId: 'entity-2', grants: [grant()] }).permitted,
    ).toBe(false);
  });

  it('refuses when nobody delegated to this actor', () => {
    expect(delegationPermits({ ...question, grants: [] }).permitted).toBe(false);
  });

  it('an uncapped delegation carries any amount', () => {
    expect(
      delegationPermits({
        ...question,
        amount: '9007199254740993.01',
        grants: [grant({ maxAmount: null })],
      }).permitted,
    ).toBe(true);
  });
});
