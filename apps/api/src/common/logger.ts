import pino, { Logger } from 'pino';
import { currentContext } from '@acct/domain';

/**
 * Structured logging — doc 21 Phase 0.
 *
 * Every line carries the correlation ID automatically, taken from the async
 * context rather than passed in. Phase 0 exit criterion 5 is "Logs trace a request
 * across API and worker by correlation ID", and a logger that has to be *given*
 * the ID is a logger somebody will call without one.
 *
 * The redaction list is not cosmetic. Doc 16 requires secrets never be logged, and
 * an accounting system's logs are retained for years — a token that lands in them
 * is a token that stays there.
 */

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.body.password',
  'req.body.password_hash',
  'req.body.token',
  'req.body.secret',
  'req.body.client_secret',
  'req.body.connection_string',
  '*.password',
  '*.password_hash',
  '*.access_token',
  '*.refresh_token',
  '*.api_key',
  '*.client_secret',
  '*.connection_string',
];

export function createLogger(options: {
  level: string;
  service: string;
  environment: string;
  buildSha: string;
}): Logger {
  return pino({
    level: options.level,
    base: {
      service: options.service,
      env: options.environment,
      build: options.buildSha,
    },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // ISO timestamps: log aggregation across API and worker has to sort a single
    // request's lines correctly, and epoch millis are unreadable when it does not.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      // The correlation ID is attached here, once, for every line the process emits.
      log: (object) => {
        const ctx = currentContext();
        if (!ctx) return object;
        return {
          ...object,
          correlation_id: ctx.correlationId,
          ...(ctx.tenantId ? { tenant_id: ctx.tenantId } : {}),
          ...(ctx.legalEntityId ? { legal_entity_id: ctx.legalEntityId } : {}),
          ...(ctx.actorId ? { actor_id: ctx.actorId } : {}),
        };
      },
    },
    transport:
      options.environment === 'development'
        ? { target: 'pino/file', options: { destination: 1 } }
        : undefined,
  });
}

export type AppLogger = Logger;
