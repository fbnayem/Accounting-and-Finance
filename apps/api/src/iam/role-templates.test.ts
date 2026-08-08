import { describe, expect, it } from 'vitest';
import { PERMISSIONS, PERMISSION_DEFINITIONS } from '@acct/contracts';
import {
  ROLE_TEMPLATES,
  SEGREGATION_SENSITIVE,
  permissionsFor,
  templateByCode,
  unclassifiedActions,
  unclassifiedResources,
} from './role-templates';

describe('role templates', () => {
  it('classifies every action and resource in the registry', () => {
    // The property that makes rule-based templates safe. Phase 3 adds tax and AR
    // permissions, Phase 5 adds inventory; if one lands in no family or no tier it
    // belongs to no role, and the only symptom is a customer who cannot do their
    // job. Failing here instead costs one line in the map.
    expect(unclassifiedActions()).toEqual([]);
    expect(unclassifiedResources()).toEqual([]);
  });

  it('names the eleven system roles doc 02 lists', () => {
    expect(ROLE_TEMPLATES.map((t) => t.code)).toEqual([
      'owner',
      'administrator',
      'accountant',
      'finance_manager',
      'ar_clerk',
      'ap_clerk',
      'procurement',
      'treasury',
      'inventory_manager',
      'auditor',
      'viewer',
    ]);
  });

  it('references only permissions the registry contains', () => {
    // ADR-0005: "CI fails if a route exists without a declared permission, or if a
    // permission is referenced by a role but absent from the registry."
    const known = new Set<string>(PERMISSIONS);
    for (const template of ROLE_TEMPLATES) {
      for (const permission of [...(template.grant ?? []), ...(template.deny ?? [])]) {
        expect(known.has(permission), `${template.code} references ${permission}`).toBe(true);
      }
    }
  });

  it('leaves no tenant permission ungranted by every role', () => {
    // A permission no role can hold is a route nobody can call. The Owner is the
    // catch-all, so this is really a check that `deny` has not grown teeth.
    const owner = new Set(permissionsFor(templateByCode('owner')!));
    const unreachable = PERMISSIONS.filter((p) => !p.startsWith('platform.') && !owner.has(p));
    expect(unreachable).toEqual([]);
  });

  it('keeps the platform surface out of every tenant role', () => {
    // doc 23's SaaS administration is the operator's, not the customer's. A tenant
    // role holding platform.tenant_manage could suspend somebody else's tenant.
    for (const template of ROLE_TEMPLATES) {
      const platform = permissionsFor(template).filter((p) => p.startsWith('platform.'));
      expect(platform, `${template.code} holds ${platform.join(', ')}`).toEqual([]);
    }
  });

  it('separates payment approval from payment execution', () => {
    // doc 02 makes "approve payments" high-risk; Gate F requires maker/checker
    // rules that "cannot be bypassed by API". A role holding both sides of the
    // split bypasses it without touching the API at all.
    for (const template of ROLE_TEMPLATES) {
      if (template.code === 'owner') continue;
      const held = new Set(permissionsFor(template));
      const approves = held.has('payment_run.approve');
      const executes = held.has('payment_run.execute') || held.has('vendor_payment.pay');
      expect(approves && executes, `${template.code} both approves and executes payments`).toBe(
        false,
      );
    }
  });

  it('gives only the Owner the segregation-sensitive permissions as a set', () => {
    for (const template of ROLE_TEMPLATES) {
      if (template.code === 'owner') continue;
      const held = new Set(permissionsFor(template));
      const sensitive = SEGREGATION_SENSITIVE.filter((p) => held.has(p));
      expect(
        sensitive.length,
        `${template.code} holds ${sensitive.join(', ')}`,
      ).toBeLessThanOrEqual(2);
    }
  });

  it('keeps the read-only roles read-only', () => {
    for (const code of ['viewer', 'auditor']) {
      const held = permissionsFor(templateByCode(code)!);
      const writes = held.filter(
        (p) => !p.endsWith('.view') && p !== 'report.export' && p !== 'audit.view',
      );
      expect(writes, `${code} can ${writes.join(', ')}`).toEqual([]);
    }
  });

  it('does not give the Viewer the audit trail or exports', () => {
    const viewer = new Set(permissionsFor(templateByCode('viewer')!));
    expect(viewer.has('audit.view')).toBe(false);
    expect(viewer.has('report.export')).toBe(false);
  });

  it('gives every role a non-empty permission set', () => {
    for (const template of ROLE_TEMPLATES) {
      expect(permissionsFor(template).length, template.code).toBeGreaterThan(0);
    }
  });

  it('flags the high-risk permissions each role carries', () => {
    // Not an assertion about the numbers so much as a guard on the shape: a clerk
    // template that starts carrying high-risk permissions is a template that has
    // been edited without thought.
    const clerks = ['ar_clerk', 'ap_clerk', 'procurement', 'inventory_manager', 'viewer'];
    for (const code of clerks) {
      const high = permissionsFor(templateByCode(code)!).filter(
        (p) => PERMISSION_DEFINITIONS[p]?.isHighRisk,
      );
      expect(high, `${code} carries high-risk ${high.join(', ')}`).toEqual([]);
    }
  });
});
