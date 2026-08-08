import { describe, it, expect } from 'vitest';
import { apiSchema, workerSchema } from './schema';

const VALID_API = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://owner:p@localhost:5432/db',
  APP_DATABASE_URL: 'postgresql://app_runtime_login:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'files',
  S3_ACCESS_KEY_ID: 'k',
  S3_SECRET_ACCESS_KEY: 's',
  API_BASE_URL: 'http://localhost:3001',
  WEB_BASE_URL: 'http://localhost:3000',
  SESSION_SECRET: 'x'.repeat(32),
  MFA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('api environment schema', () => {
  it('accepts a complete development configuration', () => {
    const env = apiSchema.parse(VALID_API);
    expect(env.API_PORT).toBe(3001);
    expect(env.DATABASE_LOCK_TIMEOUT_MS).toBe(5000);
  });

  it('rejects a short session secret', () => {
    const r = apiSchema.safeParse({ ...VALID_API, SESSION_SECRET: 'too-short' });
    expect(r.success).toBe(false);
  });

  it('rejects a non-postgres database url', () => {
    const r = apiSchema.safeParse({ ...VALID_API, DATABASE_URL: 'mysql://u:p@h:3306/d' });
    expect(r.success).toBe(false);
  });

  it('refuses to let the application connect as the database owner', () => {
    // Migration 0025 exists because the owner is a superuser in every standard
    // PostgreSQL image, and a superuser bypasses row-level security outright. The
    // failure is silent — everything works and the policies simply stop applying —
    // so it is caught at boot rather than left to a deployment note.
    const r = apiSchema.safeParse({ ...VALID_API, APP_DATABASE_URL: VALID_API.DATABASE_URL });
    expect(r.success).toBe(false);
    expect(
      r.success === false &&
        r.error.issues.some((i) => String(i.message).includes('must not be the schema owner')),
    ).toBe(true);
  });

  it('rejects an MFA key that is not 32 bytes', () => {
    // AES-256-GCM needs exactly 32. A short key fails at the first enrolment
    // otherwise, which is the worst possible moment to discover it.
    const r = apiSchema.safeParse({
      ...VALID_API,
      MFA_ENCRYPTION_KEY: Buffer.alloc(16, 7).toString('base64'),
    });
    expect(r.success).toBe(false);
  });

  it('rejects a refresh lifetime longer than the session it refreshes', () => {
    const r = apiSchema.safeParse({
      ...VALID_API,
      REFRESH_TOKEN_TTL_SECONDS: '999999',
      SESSION_ABSOLUTE_TTL_SECONDS: '3600',
    });
    expect(r.success).toBe(false);
  });

  it('refuses the Phase 0 sample command in production', () => {
    const r = apiSchema.safeParse({
      ...VALID_API,
      NODE_ENV: 'production',
      DATABASE_SSL: 'true',
      SESSION_SECRET: 'a-real-production-secret-value-32ch',
      ENABLE_PHASE0_SAMPLE: 'true',
    });
    expect(r.success).toBe(false);
    expect(
      r.success === false && r.error.issues.some((i) => i.path[0] === 'ENABLE_PHASE0_SAMPLE'),
    ).toBe(true);
  });

  it('refuses the development secret in production', () => {
    const r = apiSchema.safeParse({
      ...VALID_API,
      NODE_ENV: 'production',
      DATABASE_SSL: 'true',
      SESSION_SECRET: 'development_only_session_secret_change_me_now',
    });
    expect(r.success).toBe(false);
  });

  it('requires TLS to the database in production', () => {
    const r = apiSchema.safeParse({
      ...VALID_API,
      NODE_ENV: 'production',
      SESSION_SECRET: 'a-real-production-secret-value-32ch',
    });
    expect(r.success === false && r.error.issues.some((i) => i.path[0] === 'DATABASE_SSL')).toBe(
      true,
    );
  });
});

describe('worker environment schema', () => {
  it('defaults the outbox drain settings', () => {
    const env = workerSchema.parse(VALID_API);
    expect(env.OUTBOX_POLL_INTERVAL_MS).toBe(1000);
    expect(env.OUTBOX_BATCH_SIZE).toBe(100);
    expect(env.WORKER_CONCURRENCY).toBe(4);
  });
});
