import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from '@acct/database';
import {
  closeTestApp,
  createEntityRestrictedUser,
  createLegalEntity,
  createTenant,
  fixturePool,
  http,
  testApp,
  type TenantFixture,
} from './harness';

/**
 * Phase 1 exit criteria 1 and 2, and Gate B.
 *
 *   1. "Two tenants cannot access each other's records through UI, API or guessed IDs."
 *   2. "An entity-restricted user cannot query or mutate another entity."
 *
 * Both are stated as impossibilities, so both are tested by attempting them. Every
 * assertion below is an attack that must fail — a suite of successful requests
 * would demonstrate that the happy path works and nothing about isolation.
 */
describe('tenant and entity isolation', () => {
  let alpha: TenantFixture;
  let beta: TenantFixture;
  let alphaEntityA: string;
  let alphaEntityB: string;
  let betaEntity: string;
  let restricted: { auth: { Authorization: string }; userId: string };

  beforeAll(async () => {
    await testApp();
    alpha = await createTenant('Alpha');
    beta = await createTenant('Beta');
    alphaEntityA = (await createLegalEntity(alpha, 'ALPHA-A')).id;
    alphaEntityB = (await createLegalEntity(alpha, 'ALPHA-B')).id;
    betaEntity = (await createLegalEntity(beta, 'BETA-1')).id;
    // finance_manager rather than accountant: the point of the test is that the
    // *scope* refuses, so the role must hold the permission being exercised.
    // An accountant's reach over the setup family is VIEW, so a 403 from them
    // would prove only that they lack fiscal_year.create.
    restricted = await createEntityRestrictedUser(alpha, alphaEntityA, 'finance_manager');
  }, 180_000);

  afterAll(closeTestApp);

  // -------------------------------------------------------------------------
  // Exit criterion 1 — cross-tenant
  // -------------------------------------------------------------------------

  it("does not return another tenant's legal entity from a guessed id", async () => {
    // The id is not guessed here, it is *known* — which is strictly harder than the
    // criterion asks. If a known id is unreachable, a guessed one certainly is.
    await http().get(`/legal-entities/${betaEntity}`).set(alpha.auth).expect(404);
    await http().get(`/legal-entities/${alphaEntityA}`).set(beta.auth).expect(404);
  });

  it('answers 404 rather than 403 for a cross-tenant id', async () => {
    // Gate B: "cross-tenant object ID probes return no data." A 403 would confirm
    // the id exists somewhere, which is exactly what a probe is looking for.
    const response = await http().get(`/organizations/${beta.organizationId}`).set(alpha.auth);
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it("does not include another tenant's rows in any list", async () => {
    const entities = await http().get('/legal-entities').set(alpha.auth).expect(200);
    const ids = entities.body.data.map((e: { id: string }) => e.id);
    expect(ids).toContain(alphaEntityA);
    expect(ids).not.toContain(betaEntity);

    const organizations = await http().get('/organizations').set(alpha.auth).expect(200);
    const organizationIds = organizations.body.data.map((o: { id: string }) => o.id);
    expect(organizationIds).not.toContain(beta.organizationId);
  });

  it("refuses to create a child under another tenant's parent", async () => {
    // The dangerous direction: not reading across the boundary but writing across
    // it, which would leave a row whose scope columns disagree with its parent.
    await http()
      .post('/legal-entities')
      .set(alpha.auth)
      .send({
        organization_id: beta.organizationId,
        code: 'SMUGGLED',
        legal_name: 'Smuggled Ltd',
        country_code: 'GB',
        functional_currency: 'GBP',
        timezone: 'Europe/London',
      })
      .expect(404);
  });

  it("does not list another tenant's users or sessions", async () => {
    const users = await http().get('/users').set(alpha.auth).expect(200);
    const emails = users.body.data.map((u: { email: string }) => u.email);
    expect(emails).not.toContain(beta.email);

    const sessions = await http().get('/sessions').set(alpha.auth).expect(200);
    const userIds = sessions.body.data.map((s: { user_id: string }) => s.user_id);
    expect(userIds).not.toContain(beta.userId);
  });

  it('does not let a session bind to a tenant it has no membership in', async () => {
    await http().post(`/auth/tenants/${beta.tenantId}/select`).set(alpha.auth).expect(404);
  });

  it("does not return another tenant's audit events", async () => {
    const audit = await http().get('/audit-events').set(alpha.auth).expect(200);
    expect(audit.body.data.length).toBeGreaterThan(0);
    const resourceIds = audit.body.data.map((a: { resource_id: string }) => a.resource_id);
    expect(resourceIds).not.toContain(beta.tenantId);
    expect(resourceIds).not.toContain(betaEntity);
  });

  // -------------------------------------------------------------------------
  // Exit criterion 2 — entity restriction
  // -------------------------------------------------------------------------

  it('lists only the entities a restricted user is scoped to', async () => {
    const response = await http().get('/legal-entities').set(restricted.auth).expect(200);
    const ids = response.body.data.map((e: { id: string }) => e.id);
    expect(ids).toEqual([alphaEntityA]);
  });

  it("refuses to read an entity outside the restricted user's scope", async () => {
    // 403, not 404. Within a tenant the entity id is not a secret — it is on the
    // entity list every colleague can see — so hiding the difference would cost a
    // support call for every genuine permission gap and conceal nothing.
    const response = await http().get(`/legal-entities/${alphaEntityB}`).set(restricted.auth);
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ENTITY_ACCESS_DENIED');
  });

  it("refuses to mutate an entity outside the restricted user's scope", async () => {
    const forbidden = await http().post('/fiscal-years').set(restricted.auth).send({
      legal_entity_id: alphaEntityB,
      name: 'FY2026',
      start_date: '2026-01-01',
      end_date: '2026-12-31',
    });
    expect(forbidden.status).toBe(403);

    // And the same call against their own entity succeeds, so the refusal above is
    // the scope check and not a missing permission.
    await http()
      .post('/fiscal-years')
      .set(restricted.auth)
      .send({
        legal_entity_id: alphaEntityA,
        name: 'FY2026 restricted',
        start_date: '2026-01-01',
        end_date: '2026-12-31',
      })
      .expect(201);
  });

  it('refuses to widen its own access by inviting into another entity', async () => {
    const roles = await http().get('/roles').set(alpha.auth).expect(200);
    const owner = roles.body.data.find((r: { code: string }) => r.code === 'owner');

    // Two separate escalations in one request: an entity they cannot reach, and a
    // role holding permissions they do not hold. Either alone must fail.
    const response = await http()
      .post('/users/invite')
      .set(restricted.auth)
      .send({ email: 'escalation@example.test', role_id: owner.id, legal_entity_id: alphaEntityB });
    expect([403, 404]).toContain(response.status);
  });

  it('refuses to create a role holding permissions the caller does not hold', async () => {
    const response = await http()
      .post('/roles')
      .set(restricted.auth)
      .send({
        code: 'sneaky',
        name: 'Sneaky',
        permissions: ['role.manage', 'payment_run.execute'],
      });
    // `role.manage` is not held by an accountant, so the guard rejects it before
    // the escalation check is even reached. Both are correct answers.
    expect([403, 401]).toContain(response.status);
  });

  // -------------------------------------------------------------------------
  // The second layer — row-level security (ADR-0002)
  // -------------------------------------------------------------------------

  it('returns nothing from an RLS table when the tenant context is wrong', async () => {
    // Straight to the database as `app_runtime`, bypassing the application
    // entirely. This is the layer that has to hold when the application's own
    // scoping is the thing that is wrong.
    const owner = fixturePool();
    await owner.query(
      `INSERT INTO contacts (tenant_id, organization_id, legal_entity_id, kind, code, legal_name)
       VALUES ($1, $2, $3, 'CUSTOMER', 'RLS-PROBE', 'RLS Probe Ltd')
       ON CONFLICT DO NOTHING`,
      [alpha.tenantId, alpha.organizationId, alphaEntityA],
    );

    const runtime = createPool({
      connectionString: process.env.APP_DATABASE_URL!,
      max: 2,
      applicationName: 'acct-rls-probe',
    });
    try {
      // One pinned connection throughout: `set_config(..., false)` is
      // session-scoped, and a pooled query could land on a different connection
      // than the one the setting was applied to.
      const client = await runtime.connect();
      try {
        await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [alpha.tenantId]);
        const mine = await client.query(`SELECT count(*)::int AS n FROM contacts`);
        expect(mine.rows[0].n).toBeGreaterThan(0);

        await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [beta.tenantId]);
        const theirs = await client.query(`SELECT count(*)::int AS n FROM contacts`);
        expect(theirs.rows[0].n).toBe(0);

        // No context at all denies rather than permits: a query that forgot its
        // tenant reads nothing, which fails loudly, instead of reading everything.
        await client.query(`SELECT set_config('app.tenant_id', '', false)`);
        const none = await client.query(`SELECT count(*)::int AS n FROM contacts`);
        expect(none.rows[0].n).toBe(0);

        // And the application role cannot grant itself the exemption. The first
        // draft of migration 0024 keyed this off a session setting, which the
        // application role could simply set.
        await client.query(`SELECT set_config('app.rls_bypass', 'on', false)`);
        await client.query(`SELECT set_config('app.tenant_id', $1, false)`, [beta.tenantId]);
        const stillNone = await client.query(`SELECT count(*)::int AS n FROM contacts`);
        expect(stillNone.rows[0].n).toBe(0);
      } finally {
        client.release();
      }
    } finally {
      await runtime.end();
    }
  });

  it('cannot update or delete posted accounting facts as the runtime role', async () => {
    // Gate C: "Posted journal application role cannot UPDATE/DELETE protected
    // accounting facts." Two layers apply — the immutability trigger and the
    // revoked privilege — and this asserts the privilege, which is the one that
    // holds even if a trigger is dropped.
    const runtime = createPool({
      connectionString: process.env.APP_DATABASE_URL!,
      max: 1,
      applicationName: 'acct-privilege-probe',
    });
    try {
      const { rows } = await runtime.query<{ update: boolean; delete: boolean; audit: boolean }>(
        `SELECT has_table_privilege('journal_lines', 'UPDATE') AS update,
                has_table_privilege('journal_entries', 'DELETE') AS delete,
                has_table_privilege('audit_events', 'UPDATE') AS audit`,
      );
      expect(rows[0]).toEqual({ update: false, delete: false, audit: false });
    } finally {
      await runtime.end();
    }
  });
});
