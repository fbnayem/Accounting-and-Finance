import { Controller, Get, Inject, Res } from '@nestjs/common';
import { Anonymous, Operation } from '../common/operation';
import type { Response } from 'express';
import { Pool } from 'pg';
import { readiness } from '@acct/database';
import { DATABASE_POOL, API_ENV } from '../common/database.module';
import type { loadApiEnv } from '@acct/config';

/**
 * Health endpoints — doc 21 Phase 0, and `getHealth` in contracts/openapi.yaml
 * (`security: []`, `x-phase: 0`).
 *
 * Three endpoints rather than one, because an orchestrator asks three different
 * questions and conflating them causes outages:
 *
 *   /health/live   is the process wedged?          Never touches a dependency.
 *   /health/ready  should it receive traffic?      Checks dependencies.
 *   /health        human-readable summary.
 *
 * Liveness must not check the database. A liveness probe that fails when the
 * database is slow restarts every replica at precisely the moment the database is
 * least able to cope with reconnections.
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(API_ENV) private readonly env: ReturnType<typeof loadApiEnv>,
  ) {}

  // Not in contracts/openapi.yaml, and deliberately so: an orchestrator probe is
  // not part of the public API surface. Marked @Anonymous rather than left
  // unmarked, because the guards reject anything carrying neither marker.
  @Get('health/live')
  @Anonymous()
  live(): { state: 'ok'; service: string; build: string } {
    return { state: 'ok', service: 'api', build: this.env.BUILD_SHA };
  }

  @Get('health/ready')
  @Anonymous()
  async ready(@Res() res: Response): Promise<void> {
    const report = await readiness(this.pool, this.env.BUILD_SHA);
    // 'degraded' still serves traffic: a lagging outbox means events are late,
    // not lost, and removing the replica would only make the backlog grow.
    res.status(report.state === 'down' ? 503 : 200).json(report);
  }

  @Get('health')
  @Operation('getHealth')
  async health(@Res() res: Response): Promise<void> {
    const report = await readiness(this.pool, this.env.BUILD_SHA);
    res.status(report.state === 'down' ? 503 : 200).json({
      state: report.state,
      service: 'api',
      version: report.version,
      environment: this.env.NODE_ENV,
      checked_at: report.checkedAt,
      checks: report.checks,
    });
  }
}
