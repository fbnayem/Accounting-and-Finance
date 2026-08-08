import { z } from 'zod';

/**
 * Doc 21 Phase 0: "Environment configuration with typed validation."
 *
 * One schema per surface. Each process validates only what it needs, so the web
 * app is not blocked by a missing database password and the worker is not blocked
 * by a missing session secret. `loadEnv` fails the process at boot rather than
 * letting an undefined value reach a query at 03:00.
 */

const port = z.coerce.number().int().min(1).max(65535);
const ms = z.coerce.number().int().positive();

const postgresUrl = z
  .string()
  .url()
  .refine((u) => u.startsWith('postgres://') || u.startsWith('postgresql://'), {
    message: 'must be a postgresql:// URL',
  });

export const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  SERVICE_NAME: z.string().default('unknown'),
  // Set by the deployment pipeline; surfaces in every log line and health response
  // so a support ticket can be tied to a build.
  BUILD_SHA: z.string().default('local'),
});

export const databaseSchema = z.object({
  /** The owner. Migrations, seeding, benchmarks — the cross-tenant maintenance paths. */
  DATABASE_URL: postgresUrl,
  /**
   * What the API and worker connect as: `app_runtime` (migration 0025).
   *
   * Separate from DATABASE_URL because the owner is a superuser in every standard
   * PostgreSQL image, and a superuser bypasses row-level security outright — with
   * the owner here, the ADR-0002 policies would exist and do nothing.
   */
  APP_DATABASE_URL: postgresUrl,
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(500).default(20),
  DATABASE_STATEMENT_TIMEOUT_MS: ms.default(30_000),
  // ADR-0004: posting takes row locks. A long lock wait is a defect, not load.
  DATABASE_LOCK_TIMEOUT_MS: ms.default(5_000),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export const redisSchema = z.object({
  REDIS_URL: z.string().url(),
});

export const storageSchema = z.object({
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export const apiSchema = baseSchema
  .merge(databaseSchema)
  .merge(redisSchema)
  .merge(storageSchema)
  .extend({
    API_PORT: port.default(3001),
    API_BASE_URL: z.string().url(),
    WEB_BASE_URL: z.string().url(),
    SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
    /** AES-256-GCM key for mfa_factors.secret_ciphertext. Base64 of exactly 32 bytes. */
    MFA_ENCRYPTION_KEY: z.string().min(1),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).default(2_592_000),
    SESSION_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().min(300).default(2_592_000),
    /**
     * How recently MFA must have been satisfied to exercise one of the 19 high-risk
     * permissions (ADR-0005 §3).
     */
    REAUTH_WINDOW_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
    ENABLE_PHASE0_SAMPLE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  .superRefine((env, ctx) => {
    assertDistinctDatabaseRoles(env, ctx);

    // A base64 key of the wrong length fails at the first enrolment rather than at
    // boot, which is the worst possible time to discover it.
    if (Buffer.from(env.MFA_ENCRYPTION_KEY, 'base64').length !== 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MFA_ENCRYPTION_KEY'],
        message: 'must be base64 of exactly 32 bytes (openssl rand -base64 32)',
      });
    }

    if (env.REFRESH_TOKEN_TTL_SECONDS > env.SESSION_ABSOLUTE_TTL_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REFRESH_TOKEN_TTL_SECONDS'],
        message:
          'cannot exceed SESSION_ABSOLUTE_TTL_SECONDS; the refresh would outlive the session it refreshes',
      });
    }

    // A scaffold route that writes tenants must never be reachable in production,
    // and a default secret must never ship. Both are release-blocking by ADR-0009 §5.
    if (env.NODE_ENV === 'production') {
      if (env.ENABLE_PHASE0_SAMPLE) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ENABLE_PHASE0_SAMPLE'],
          message: 'the Phase 0 sample command cannot be enabled in production',
        });
      }
      if (env.MFA_ENCRYPTION_KEY.startsWith('ZGV2ZWxvcG1lbnRfb25seV')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['MFA_ENCRYPTION_KEY'],
          message: 'the development MFA_ENCRYPTION_KEY cannot be used in production',
        });
      }
      if (env.SESSION_SECRET.includes('development_only')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SESSION_SECRET'],
          message: 'the development SESSION_SECRET cannot be used in production',
        });
      }
      if (!env.DATABASE_SSL) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['DATABASE_SSL'],
          message: 'DATABASE_SSL must be true in production',
        });
      }
    }
  });

export const workerSchema = baseSchema
  .merge(databaseSchema)
  .merge(redisSchema)
  .merge(storageSchema)
  .extend({
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    OUTBOX_POLL_INTERVAL_MS: ms.default(1_000),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
    /**
     * How often the Phase 2 scheduler looks for due scheduled reversals and
     * recurring journals. Both are date-granular, so a minute is already far finer
     * than the work needs; the default is five, and the only reason to lower it is
     * a test that does not want to wait.
     */
    LEDGER_SCHEDULER_INTERVAL_MS: ms.default(5 * 60_000),
    LEDGER_SCHEDULER_ENABLED: z.coerce.boolean().default(true),
    LEDGER_SCHEDULER_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  })
  .superRefine(assertDistinctDatabaseRoles);

/**
 * The application must not connect as the database owner.
 *
 * Checked at boot rather than left to a deployment note, because the failure is
 * silent: everything works, and row-level security simply stops applying. It is
 * also the natural thing to do when a permission error appears in staging at 18:00.
 */
function assertDistinctDatabaseRoles(
  env: { DATABASE_URL: string; APP_DATABASE_URL: string },
  ctx: z.RefinementCtx,
): void {
  try {
    const owner = new URL(env.DATABASE_URL);
    const app = new URL(env.APP_DATABASE_URL);
    if (owner.username && owner.username === app.username) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_DATABASE_URL'],
        message:
          `connects as "${app.username}", the same role as DATABASE_URL. The application must ` +
          'not be the schema owner: as the owner it is a superuser, and a superuser bypasses ' +
          'the row-level security policies in migration 0024 entirely.',
      });
    }
  } catch {
    // Malformed URLs are already reported by the postgresUrl schema.
  }
}

export const webSchema = baseSchema.extend({
  WEB_PORT: port.default(3000),
  NEXT_PUBLIC_API_BASE_URL: z.string().url(),
});

export const testSchema = baseSchema.merge(databaseSchema).extend({
  TEST_DATABASE_URL: postgresUrl,
});

export type ApiEnv = z.infer<typeof apiSchema>;
export type WorkerEnv = z.infer<typeof workerSchema>;
export type WebEnv = z.infer<typeof webSchema>;
export type TestEnv = z.infer<typeof testSchema>;
export type DatabaseEnv = z.infer<typeof databaseSchema>;
