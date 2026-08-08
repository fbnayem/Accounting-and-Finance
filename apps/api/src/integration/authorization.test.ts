import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATIONS, PERMISSION_DEFINITIONS, type OperationDefinition } from '@acct/contracts';
import { DELIVERED_PHASES } from '../common/operation';
import {
  closeTestApp,
  createLedger,
  elevatedSession,
  createTenant,
  fixturePool,
  http,
  testApp,
  type LedgerFixture,
  type TenantFixture,
} from './harness';

/**
 * Phase 1 exit criterion 4: "role/permission tests cover every finance mutation
 * route created in this phase." Gate B says the same of every mutation route.
 *
 * The test is generated from the contract rather than written one route at a time.
 * A hand-written suite is a coverage claim that decays: the route added next
 * quarter has no test, and nothing says so. Here, adding a mutation to
 * contracts/openapi.yaml in any delivered phase adds a case to this test
 * automatically, and the case fails until the route enforces its declared
 * permission. `DELIVERED_PHASES` is the same list `main.ts` reconciles against, so
 * the set of routes that must exist and the set that must be authorization-tested
 * cannot drift apart.
 *
 * What each case asserts is narrow and specific: a caller holding *every*
 * permission except the one the contract declares must be refused. That
 * distinguishes "the guard works" from "the request happened to fail", which a
 * no-permissions caller cannot do — they would be refused by any bug at all.
 */
const DELIVERED_MUTATIONS = Object.values(OPERATIONS).filter(
  (o) =>
    DELIVERED_PHASES.includes(o.phase as (typeof DELIVERED_PHASES)[number]) &&
    ['POST', 'PATCH', 'PUT', 'DELETE'].includes(o.method) &&
    o.permission !== null &&
    // The platform surface is the operator's, granted outside the tenant model
    // entirely — no tenant role can hold it, so "all but this one" is not a state
    // a tenant principal can be put in.
    !o.permission.startsWith('platform.'),
);

/** A body that gets past validation far enough to reach the permission check. */
function sampleBody(operation: OperationDefinition, ids: Record<string, string>): unknown {
  switch (operation.operationId) {
    case 'createOrganization':
      return { name: 'Probe Organization' };
    case 'updateOrganization':
      return { name: 'Probe Renamed' };
    case 'createLegalEntity':
      return {
        organization_id: ids.organizationId,
        code: 'PROBE',
        legal_name: 'Probe Ltd',
        country_code: 'GB',
        functional_currency: 'GBP',
        timezone: 'Europe/London',
      };
    case 'updateLegalEntity':
      return { legal_name: 'Probe Renamed Ltd' };
    case 'createBranch':
      return { legal_entity_id: ids.legalEntityId, code: 'PB', name: 'Probe Branch' };
    case 'createAccountingPolicyVersion':
      return { legal_entity_id: ids.legalEntityId, valid_from: '2030-01-01' };
    case 'createNumberSequence':
      return { legal_entity_id: ids.legalEntityId, document_type: 'PROBE_DOC' };
    case 'createFiscalYear':
      return {
        legal_entity_id: ids.legalEntityId,
        name: 'FY-probe',
        start_date: '2030-01-01',
        end_date: '2030-12-31',
      };
    case 'createExchangeRate':
      return {
        rate_date: '2030-01-01',
        from_currency: 'GBP',
        to_currency: 'USD',
        rate: '1.250000000000',
        source: 'probe',
      };
    case 'inviteUser':
      return { email: 'probe@example.test', role_id: ids.viewerRoleId };
    case 'createRole':
      return { code: 'probe_role', name: 'Probe Role', permissions: [] };
    case 'updateRole':
      return { name: 'Probe Role Renamed' };
    case 'createMembership':
      return { user_id: ids.userId, role_id: ids.viewerRoleId };
    case 'softClosePeriod':
    case 'hardClosePeriod':
    case 'reopenPeriod':
      return { reason: 'authorization probe' };

    // --- Phase 2 ---------------------------------------------------------
    case 'createAccount':
      return {
        legal_entity_id: ids.legalEntityId,
        code: 'PROBE1',
        name: 'Probe account',
        account_type: 'EXPENSE',
      };
    case 'updateAccount':
      return { name: 'Probe renamed' };
    case 'createAccountGroup':
      return { legal_entity_id: ids.legalEntityId, code: 'PG', name: 'Probe group' };
    case 'setAccountDimensionRules':
      return { rules: [] };
    case 'createDimension':
      return { legal_entity_id: ids.legalEntityId, code: 'PDIM', name: 'Probe dimension' };
    case 'createDimensionValue':
      return { dimension_id: ids.dimensionId, code: 'PV', name: 'Probe value' };
    case 'createJournalDefinition':
      return {
        accounting_book_id: ids.accountingBookId,
        code: 'PJ',
        name: 'Probe journal',
        journal_type: 'GENERAL',
      };
    case 'createJournalDraft':
      return {
        accounting_book_id: ids.accountingBookId,
        journal_id: ids.journalDefinitionId,
        posting_date: '2027-03-15',
        lines: [
          { account_id: ids.debitAccountId, debit: '1.00' },
          { account_id: ids.creditAccountId, credit: '1.00' },
        ],
      };
    case 'updateJournalDraft':
      return { description: 'probe' };
    case 'reverseJournal':
      return { reason: 'authorization probe' };
    case 'scheduleJournalReversal':
      return { scheduled_date: '2027-06-30', reason: 'authorization probe' };
    case 'cancelScheduledReversal':
      return { reason: 'authorization probe' };
    case 'createPostingRuleVersion':
      return {
        accounting_book_id: ids.accountingBookId,
        event_type: 'PROBE_EVENT',
        valid_from: '2027-01-01T00:00:00Z',
        rule_definition: {
          event_type: 'PROBE_EVENT',
          lines: [
            { role: 'a', account: { code: '1000' }, side: 'DEBIT', amount: { const: '1' } },
            { role: 'b', account: { code: '1010' }, side: 'CREDIT', amount: { const: '1' } },
          ],
        },
      };
    case 'simulatePosting':
      return {
        accounting_book_id: ids.accountingBookId,
        event_type: 'PROBE_EVENT',
        posting_date: '2027-03-15',
        payload: {},
      };
    case 'createRecurringJournal':
      return {
        accounting_book_id: ids.accountingBookId,
        journal_id: ids.journalDefinitionId,
        name: 'Probe recurring',
        frequency: 'MONTHLY',
        start_date: '2027-03-01',
        lines: [
          { account_id: ids.debitAccountId, debit: '1.00' },
          { account_id: ids.creditAccountId, credit: '1.00' },
        ],
      };
    case 'createOpeningBalanceSet':
      return {
        accounting_book_id: ids.accountingBookId,
        journal_id: ids.openingJournalId,
        as_of_date: '2027-01-01',
        lines: [
          { account_id: ids.debitAccountId, debit: '1.00' },
          { account_id: ids.creditAccountId, credit: '1.00' },
        ],
      };
    case 'rebuildLedgerProjections':
      return { accounting_book_id: ids.accountingBookId };

    default:
      return {};
  }
}

function resolvePath(operation: OperationDefinition, ids: Record<string, string>): string {
  return operation.path.replace('{id}', () => {
    if (operation.path.startsWith('/legal-entities')) return ids.legalEntityId!;
    if (operation.path.startsWith('/organizations')) return ids.organizationId!;
    if (operation.path.startsWith('/accounting-periods')) return ids.periodId!;
    if (operation.path.startsWith('/roles')) return ids.viewerRoleId!;
    if (operation.path.startsWith('/users')) return ids.userId!;
    if (operation.path.startsWith('/sessions')) return ids.sessionId!;
    if (operation.path.startsWith('/accounts')) return ids.debitAccountId!;
    if (operation.path.startsWith('/journals')) return ids.journalEntryId!;
    if (operation.path.startsWith('/scheduled-reversals')) return ids.scheduledReversalId!;
    if (operation.path.startsWith('/opening-balances')) return ids.openingBalanceSetId!;
    return ids.legalEntityId!;
  });
}

describe('authorization covers every delivered mutation route', () => {
  let tenant: TenantFixture;
  let ledger: LedgerFixture;
  let ids: Record<string, string>;

  beforeAll(async () => {
    await testApp();
    tenant = await createTenant('Authz');

    // A posting-ready entity, because half the Phase 2 routes cannot be reached at
    // all without one — and a route that 404s before the guard runs would pass this
    // test while proving nothing about its permission.
    ledger = await createLedger(tenant, { code: 'AUTHZ', year: 2027 });

    const fiscalYear = await http()
      .get('/accounting-periods')
      .query({ legal_entity_id: ledger.legalEntityId })
      .set(tenant.auth)
      .expect(200);

    const dimension = await http()
      .post('/dimensions')
      .set(tenant.auth)
      .send({ legal_entity_id: ledger.legalEntityId, code: 'AUTHZDIM', name: 'Authz dimension' })
      .expect(201);

    const draft = await http()
      .post('/journals')
      .set(tenant.auth)
      .send({
        accounting_book_id: ledger.accountingBookId,
        journal_id: ledger.generalJournalId,
        posting_date: '2027-03-15',
        description: 'authorization probe target',
        lines: [
          { account_id: ledger.accounts.expense, debit: '1.00' },
          { account_id: ledger.accounts.cash, credit: '1.00' },
        ],
      })
      .expect(201);

    // journal.post is high-risk, so building this fixture needs a session that has
    // re-authenticated — while `tenant.auth` deliberately has not, because the MFA
    // assertion further down depends on it.
    const elevated = await elevatedSession(tenant);
    const posted = await http()
      .post(`/journals/${draft.body.id}/post`)
      .set(elevated)
      .set('Idempotency-Key', `authz-target-${draft.body.id}`)
      .send({})
      .expect(200);

    const schedule = await http()
      .post(`/journals/${posted.body.id}/schedule-reversal`)
      .set(tenant.auth)
      .set('Idempotency-Key', `authz-schedule-${posted.body.id}`)
      .send({ scheduled_date: '2027-09-30', reason: 'authorization probe target' })
      .expect(201);

    const roles = await http().get('/roles').set(tenant.auth).expect(200);
    const viewer = roles.body.data.find((r: { code: string }) => r.code === 'viewer');
    const sessions = await http().get('/sessions').set(tenant.auth).expect(200);

    ids = {
      organizationId: tenant.organizationId,
      legalEntityId: ledger.legalEntityId,
      periodId: fiscalYear.body.data[0].id,
      viewerRoleId: viewer.id,
      userId: tenant.userId,
      sessionId: sessions.body.data[0].id,
      accountingBookId: ledger.accountingBookId,
      journalDefinitionId: ledger.generalJournalId,
      openingJournalId: ledger.openingJournalId,
      dimensionId: dimension.body.id,
      debitAccountId: ledger.accounts.expense,
      creditAccountId: ledger.accounts.cash,
      journalEntryId: posted.body.id,
      scheduledReversalId: schedule.body.id,
      // No opening balance set is created: `postOpeningBalanceSet` must be refused
      // by its permission before it ever looks the id up, and pointing it at a real
      // one would let a 404 masquerade as a 403.
      openingBalanceSetId: posted.body.id,
    };
  }, 300_000);

  afterAll(closeTestApp);

  it('has a case for every delivered mutation the contract declares', () => {
    // The guard on the guard. If this number silently drops, the suite below is
    // still green while testing less — which is how coverage claims rot. Raised
    // from 20 to 40 in Phase 2 for the same reason it existed at 20.
    expect(DELIVERED_MUTATIONS.length).toBeGreaterThanOrEqual(40);
    for (const phase of DELIVERED_PHASES) {
      if (phase === 0) continue; // Phase 0 has no permission-bearing mutations
      expect(
        DELIVERED_MUTATIONS.some((o) => o.phase === phase),
        `no mutation from phase ${phase} is covered`,
      ).toBe(true);
    }
  });

  it.each(DELIVERED_MUTATIONS.map((o) => [o.operationId, o] as const))(
    '%s is refused without %s',
    async (_id, operation) => {
      // A role holding everything except the one permission under test. Any
      // failure is then attributable to that permission and nothing else.
      const roleCode = `probe_${operation.operationId.toLowerCase()}`.slice(0, 40);
      const { rows } = await fixturePool().query<{ id: string }>(
        `INSERT INTO roles (tenant_id, code, name, is_system)
         VALUES ($1, $2, $3, false)
         ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [tenant.tenantId, roleCode, `Probe for ${operation.operationId}`],
      );
      const roleId = rows[0]!.id;
      await fixturePool().query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
      await fixturePool().query(
        `INSERT INTO role_permissions (role_id, permission_code)
         SELECT $1, code FROM permissions
          WHERE code <> $2 AND code NOT LIKE 'platform.%'`,
        [roleId, operation.permission],
      );

      const email = `probe-${roleCode}-${Date.now().toString(36)}@example.test`;
      const { rows: userRows } = await fixturePool().query<{ id: string }>(
        `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`,
        [email, 'Probe'],
      );
      const userId = userRows[0]!.id;
      await fixturePool().query(
        `INSERT INTO memberships (tenant_id, user_id, role_id) VALUES ($1, $2, $3)`,
        [tenant.tenantId, userId, roleId],
      );
      // MFA satisfied, so a high-risk route is refused for the permission and not
      // for the re-authentication window.
      const { rows: sessionRows } = await fixturePool().query<{ id: string }>(
        `INSERT INTO sessions (user_id, tenant_id, expires_at, access_expires_at,
                               mfa_satisfied, mfa_verified_at)
         VALUES ($1, $2, now() + interval '1 hour', now() + interval '1 hour', true, now())
         RETURNING id`,
        [userId, tenant.tenantId],
      );
      const sessionId = sessionRows[0]!.id;
      const secret = `probe-secret-${sessionId}`;
      const { createHash } = await import('node:crypto');
      await fixturePool().query(`UPDATE sessions SET access_token_hash = $2 WHERE id = $1`, [
        sessionId,
        createHash('sha256').update(secret, 'utf8').digest('base64url'),
      ]);

      const path = resolvePath(operation, ids);
      const method = operation.method.toLowerCase() as 'post' | 'patch' | 'put' | 'delete';
      const response = await http()
        [method](path)
        .set('Authorization', `Bearer ${sessionId}.${secret}`)
        .set('If-Match', '1')
        .set('Idempotency-Key', `authz-${operation.operationId}`)
        .send(sampleBody(operation, ids) as object);

      expect(
        response.status,
        `${operation.method} ${path} answered ${response.status} ` +
          `(${JSON.stringify(response.body).slice(0, 200)}) without ${operation.permission}`,
      ).toBe(403);
      expect(response.body.code).toBe('FORBIDDEN');
    },
    60_000,
  );

  it('requires recent MFA for every high-risk permission', async () => {
    // ADR-0005 §3. Asserted over the registry rather than over one route, so a
    // permission that becomes high-risk later is covered without an edit here.
    const highRisk = Object.values(OPERATIONS).filter(
      (o) =>
        o.phase === 1 &&
        o.permission &&
        PERMISSION_DEFINITIONS[o.permission as never]?.isHighRisk &&
        !o.permission.startsWith('platform.'),
    );
    expect(highRisk.length).toBeGreaterThan(0);

    // The tenant Owner holds every non-platform permission and has not done MFA.
    for (const operation of highRisk) {
      const path = resolvePath(operation, ids);
      const method = operation.method.toLowerCase() as 'post' | 'patch';
      const response = await http()
        [method](path)
        .set(tenant.auth)
        .set('Idempotency-Key', `mfa-${operation.operationId}`)
        .send(sampleBody(operation, ids) as object);
      expect(response.body.code, `${operation.operationId} did not demand MFA`).toBe(
        'MFA_REQUIRED',
      );
    }
  });

  it('rejects an unauthenticated call to every permission-bearing Phase 1 route', async () => {
    for (const operation of DELIVERED_MUTATIONS) {
      const response = await http()
        [operation.method.toLowerCase() as 'post'](resolvePath(operation, ids))
        .send({});
      expect(response.status, `${operation.method} ${operation.path}`).toBe(401);
    }
  });
});
