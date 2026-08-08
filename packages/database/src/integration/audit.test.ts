import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { withTransaction } from '../transaction';
import { recordAudit, verifyChain, redact } from '../audit';
import { testPool, testContext, createTestTenant, createTestUser, closeTestPool } from './helpers';

/**
 * F-043 — doc 16 calls the audit log immutable; the blueprint had no mechanism.
 * Two now: a trigger, and a hash chain that makes tampering below the application
 * detectable rather than merely discouraged.
 */
describe('audit log', () => {
  const pool = testPool();
  let tenantId: string;

  beforeAll(async () => {
    tenantId = await createTestTenant(pool);
  });
  afterAll(closeTestPool);

  it('chains rows so the sequence can be verified', async () => {
    const ctx = testContext({ tenantId, actorId: 'auditor-1', actorKind: 'USER' });

    for (let i = 0; i < 5; i++) {
      await withTransaction(
        pool,
        ({ client }) =>
          recordAudit(client, ctx, {
            action: 'organization.updated',
            resourceType: 'organization',
            resourceId: `org-${i}`,
            tenantId,
            after: { name: `Name ${i}` },
          }),
        { context: ctx },
      );
    }

    const result = await verifyChain(pool, tenantId);
    expect(result.valid).toBe(true);
    expect(result.rowsChecked).toBeGreaterThanOrEqual(5);
    expect(result.firstBreakAt).toBeNull();
  });

  it('rejects an UPDATE through the trigger', async () => {
    const ctx = testContext({ tenantId });
    const { id } = await withTransaction(
      pool,
      ({ client }) =>
        recordAudit(client, ctx, {
          action: 'tenant.viewed',
          resourceType: 'tenant',
          resourceId: tenantId,
          tenantId,
        }),
      { context: ctx },
    );

    await expect(
      pool.query(`UPDATE audit_events SET action = 'tampered' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ message: expect.stringContaining('POSTED_IMMUTABLE') });
  });

  it('rejects a DELETE through the trigger', async () => {
    await expect(
      pool.query(`DELETE FROM audit_events WHERE tenant_id = $1`, [tenantId]),
    ).rejects.toMatchObject({ message: expect.stringContaining('POSTED_IMMUTABLE') });
  });

  it('detects tampering that bypasses the application', async () => {
    // Simulates an attacker with direct database access: disable the trigger,
    // edit a row, restore the trigger. The chain is what catches this — nothing
    // at the application layer could.
    const tamperedTenant = await createTestTenant(pool);
    const ctx = testContext({ tenantId: tamperedTenant });

    for (let i = 0; i < 3; i++) {
      await withTransaction(
        pool,
        ({ client }) =>
          recordAudit(client, ctx, {
            action: 'payment.approved',
            resourceType: 'payment',
            resourceId: `pay-${i}`,
            tenantId: tamperedTenant,
            after: { amount: '100.00' },
          }),
        { context: ctx },
      );
    }
    expect((await verifyChain(pool, tamperedTenant)).valid).toBe(true);

    await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable');
    try {
      await pool.query(
        `UPDATE audit_events SET after_data = '{"amount":"1000000.00"}'::jsonb
          WHERE tenant_id = $1 AND resource_id = 'pay-1'`,
        [tamperedTenant],
      );
    } finally {
      await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable');
    }

    const after = await verifyChain(pool, tamperedTenant);
    expect(after.valid).toBe(false);
    expect(after.firstBreakAt).not.toBeNull();
  });

  it('never writes a secret into the permanent record', async () => {
    const cleaned = redact({
      name: 'Connector',
      connection_string: 'postgresql://user:hunter2@host/db',
      nested: { api_key: 'sk-live-123', label: 'keep me' },
      list: [{ password: 'p' }],
    }) as Record<string, any>;

    expect(cleaned.connection_string).toBe('[redacted]');
    expect(cleaned.nested.api_key).toBe('[redacted]');
    expect(cleaned.nested.label).toBe('keep me');
    expect(cleaned.list[0].password).toBe('[redacted]');
  });

  it('records both actors when support impersonates (doc 23)', async () => {
    // impersonated_by is a real FK to users: the schema will not let an audit row
    // name a support operator who does not exist.
    const supportAgentId = await createTestUser(pool, 'support-agent');
    const ctx = testContext({
      tenantId,
      actorId: 'customer-user',
      actorKind: 'USER',
      impersonatedBy: supportAgentId,
    });
    const { id } = await withTransaction(
      pool,
      ({ client }) =>
        recordAudit(client, ctx, {
          action: 'invoice.viewed',
          resourceType: 'invoice',
          resourceId: 'inv-1',
          tenantId,
          reason: 'support ticket 4821',
        }),
      { context: ctx },
    );

    const { rows } = await pool.query(
      `SELECT actor_id, impersonated_by::text, reason FROM audit_events WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toMatchObject({ actor_id: 'customer-user', reason: 'support ticket 4821' });
    expect(rows[0].impersonated_by).toBe(supportAgentId);
  });
});
