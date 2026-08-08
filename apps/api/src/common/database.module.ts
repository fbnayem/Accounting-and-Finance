import { Global, Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { createPool } from '@acct/database';
import { loadApiEnv } from '@acct/config';
import { createLogger, type AppLogger } from './logger';

export const DATABASE_POOL = Symbol('DATABASE_POOL');
export const APP_LOGGER = Symbol('APP_LOGGER');
export const API_ENV = Symbol('API_ENV');

/**
 * Wires the pool, the logger and the validated environment.
 *
 * Global because every module needs at least the logger, and threading it through
 * imports produces a module graph that describes plumbing rather than domains.
 */
@Global()
@Module({
  providers: [
    {
      provide: API_ENV,
      useFactory: () => loadApiEnv(),
    },
    {
      provide: APP_LOGGER,
      inject: [API_ENV],
      useFactory: (env: ReturnType<typeof loadApiEnv>) =>
        createLogger({
          level: env.LOG_LEVEL,
          service: 'api',
          environment: env.NODE_ENV,
          buildSha: env.BUILD_SHA,
        }),
    },
    {
      provide: DATABASE_POOL,
      inject: [API_ENV],
      useFactory: (env: ReturnType<typeof loadApiEnv>) =>
        createPool({
          // APP_DATABASE_URL, never DATABASE_URL: the request path connects as
          // `app_runtime`, which is not a superuser and therefore the only role the
          // migration 0024 row-level security policies actually apply to.
          connectionString: env.APP_DATABASE_URL,
          max: env.DATABASE_POOL_MAX,
          statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
          lockTimeoutMs: env.DATABASE_LOCK_TIMEOUT_MS,
          ssl: env.DATABASE_SSL,
          applicationName: 'acct-api',
        }),
    },
  ],
  exports: [DATABASE_POOL, APP_LOGGER, API_ENV],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(APP_LOGGER) private readonly logger: AppLogger,
  ) {}

  /**
   * Drains the pool on shutdown. Without this a rolling deploy can terminate a
   * connection mid-transaction; PostgreSQL rolls it back correctly, but the caller
   * sees a 500 for a request that would have succeeded.
   */
  async onApplicationShutdown(signal?: string): Promise<void> {
    this.logger.info({ signal }, 'draining database pool');
    await this.pool.end();
  }
}
