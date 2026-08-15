import { describe, expect, it } from 'vitest';
import { parseDefinition, serializeDefinition } from './definition';

const namedUser = (id: string) => ({ resolved_from: 'NAMED_USER', user_id: id });

describe('a definition that can be satisfied', () => {
  it('accepts a serial two-step workflow and numbers it', () => {
    const def = parseDefinition({
      steps: [
        { approvers: [namedUser('u1')] },
        { approvers: [{ resolved_from: 'ROLE', role_id: 'r1' }] },
      ],
    });
    expect(def.steps.map((s) => s.stepNo)).toEqual([1, 2]);
    expect(def.steps[0]!.mode).toBe('SERIAL');
    expect(def.steps[0]!.quorum).toBe(1);
    expect(def.requireDistinctApprovers).toBe(true);
  });

  it('accepts a parallel step with a quorum below its approver count', () => {
    const def = parseDefinition({
      steps: [
        {
          mode: 'PARALLEL',
          quorum: 2,
          approvers: [namedUser('u1'), namedUser('u2'), namedUser('u3')],
        },
      ],
    });
    expect(def.steps[0]!.quorum).toBe(2);
  });

  it('round-trips through its canonical form unchanged', () => {
    const input = {
      steps: [
        {
          step_no: 1,
          mode: 'PARALLEL',
          quorum: 2,
          approvers: [namedUser('u1'), namedUser('u2')],
          expires_after_hours: 48,
          on_expiry: 'ESCALATE',
        },
      ],
      on_reject: 'TERMINATE',
      on_request_changes: 'RETURN_TO_REQUESTER',
      require_distinct_approvers: true,
    };
    expect(serializeDefinition(parseDefinition(input))).toEqual(input);
    expect(parseDefinition(serializeDefinition(parseDefinition(input)))).toEqual(
      parseDefinition(input),
    );
  });
});

describe('definitions that would produce an unapprovable document', () => {
  it('refuses a workflow with no steps', () => {
    expect(() => parseDefinition({ steps: [] })).toThrowError(/at least one step/);
  });

  it('refuses a step with no approvers', () => {
    expect(() => parseDefinition({ steps: [{ approvers: [] }] })).toThrowError(/no approvers/);
  });

  it('refuses a quorum larger than the number of approver slots', () => {
    expect(() =>
      parseDefinition({
        steps: [{ mode: 'PARALLEL', quorum: 3, approvers: [namedUser('u1'), namedUser('u2')] }],
      }),
    ).toThrowError(/can never be satisfied/);
  });

  it('refuses a resolution method the schema cannot answer, naming why', () => {
    expect(() =>
      parseDefinition({ steps: [{ approvers: [{ resolved_from: 'MANAGER' }] }] }),
    ).toThrowError(/no manager on users/);
    expect(() =>
      parseDefinition({ steps: [{ approvers: [{ resolved_from: 'AMOUNT_AUTHORITY' }] }] }),
    ).toThrowError(/amount-authority table/);
  });

  it('refuses the same person twice in one step', () => {
    expect(() =>
      parseDefinition({
        steps: [{ mode: 'PARALLEL', quorum: 2, approvers: [namedUser('u1'), namedUser('u1')] }],
      }),
    ).toThrowError(/same user twice/);
  });

  it('refuses a gap or a repeat in the step numbering', () => {
    expect(() =>
      parseDefinition({
        steps: [
          { step_no: 1, approvers: [namedUser('u1')] },
          { step_no: 3, approvers: [namedUser('u2')] },
        ],
      }),
    ).toThrowError(/numbered 1\.\.n in order/);
  });

  it('refuses a serial step that asks for more than one decision', () => {
    expect(() =>
      parseDefinition({
        steps: [{ mode: 'SERIAL', quorum: 2, approvers: [namedUser('u1'), namedUser('u2')] }],
      }),
    ).toThrowError(/SERIAL with quorum 2/);
  });
});

describe('outcomes that cannot be configured away', () => {
  it('refuses an expiry that would approve the document', () => {
    expect(() =>
      parseDefinition({
        steps: [
          { approvers: [namedUser('u1')], expires_after_hours: 1, on_expiry: 'AUTO_APPROVE' },
        ],
      }),
    ).toThrowError(/no AUTO_APPROVE/);
  });

  it('refuses a rejection rule that depends on decision order', () => {
    expect(() =>
      parseDefinition({ steps: [{ approvers: [namedUser('u1')] }], on_reject: 'CONTINUE' }),
    ).toThrowError(/must be TERMINATE/);
  });

  it('refuses a non-positive expiry', () => {
    expect(() =>
      parseDefinition({ steps: [{ approvers: [namedUser('u1')], expires_after_hours: 0 }] }),
    ).toThrowError(/positive number of hours/);
  });
});
