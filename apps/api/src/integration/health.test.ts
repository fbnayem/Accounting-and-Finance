import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeTestApp, http, testApp } from './harness';

/**
 * The health endpoints, over HTTP, as the role that actually serves traffic.
 *
 * F-622. `GET /health` answered `{"state":"down"}` with `permission denied for
 * schema public` from the moment ADR-0002 gave the application its own
 * `app_runtime` role, because the readiness probe's migration check began with
 * `CREATE TABLE IF NOT EXISTS schema_migrations` and the runtime role has no
 * CREATE on schema public. Two phases shipped that way. Nothing caught it because
 * the endpoint had no test at all: the unit tests called the check functions with
 * the owner's pool, for whom the DDL succeeds.
 *
 * That is the reason these assertions go through HTTP against the assembled
 * application rather than calling `readiness()` — the defect was not in the check,
 * it was in who runs it, and only the assembled application answers that.
 */
describe('health endpoints', () => {
  beforeAll(async () => {
    await testApp();
  });
  afterAll(closeTestApp);

  it('reports ready, as the runtime role, with every dependency reachable', async () => {
    const response = await http().get('/health');

    expect(response.status).toBe(200);
    // Not 'ok': no worker runs during the test suite, so the outbox is legitimately
    // behind and the report is 'degraded' — which still serves traffic, by design.
    // 'down' is the assertion that matters, and it is the one F-622 tripped.
    expect(response.body.state).not.toBe('down');

    // Named individually: a probe that is green because a check silently stopped
    // running is the same outage as one that is red.
    const byName = Object.fromEntries(
      (response.body.checks as Array<{ name: string; state: string; detail?: string }>).map((c) => [
        c.name,
        c,
      ]),
    );
    expect(Object.keys(byName).sort()).toEqual(['database', 'migrations', 'outbox']);
    expect(byName.database?.state).toBe('ok');
    expect(byName.outbox?.state).not.toBe('down');

    // The one F-622 broke, asserted on its detail as well as its state, because
    // "ok" with nothing applied would also have been a lie.
    expect(byName.migrations?.state).toBe('ok');
    expect(byName.migrations?.detail).toMatch(/^\d+ applied$/);
  });

  it('serves 200 on the readiness probe an orchestrator actually calls', async () => {
    // /health is the human-readable one; /health/ready is what decides whether the
    // replica receives traffic. F-622 made this 503 permanently.
    const response = await http().get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body.state).not.toBe('down');
  });

  it('answers liveness without touching the database', async () => {
    // Separate from readiness on purpose (health.ts): a liveness probe that fails
    // on a slow database restarts every replica exactly when the database is
    // already struggling.
    const response = await http().get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body.state).toBe('ok');
  });

  it('is reachable without a session', async () => {
    // An orchestrator has no credentials. If this ever requires authentication the
    // probe fails closed and the deployment never goes green.
    const response = await http().get('/health').set('Authorization', '');

    expect(response.status).toBe(200);
  });
});
