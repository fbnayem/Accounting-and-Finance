import { Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import {
  CORRELATION_HEADER,
  CAUSATION_HEADER,
  IDEMPOTENCY_HEADER,
  RequestContext,
  newCorrelationId,
  runWithContext,
} from '@acct/domain';

/**
 * Establishes the request context for the whole request, including anything it
 * awaits. Phase 0 exit criterion 5.
 *
 * An inbound correlation ID is honoured so a trace that began in the web app, or
 * in a caller's system, stays one trace — but it is validated first. The value is
 * echoed in a response header and written into `audit_events` and the outbox
 * envelope, so an unbounded or control-character-laden header from a hostile
 * client would be a log-injection vector.
 */

const SAFE_CORRELATION = /^[A-Za-z0-9._:@=+/-]{1,128}$/;

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.header(CORRELATION_HEADER);
    const correlationId = inbound && SAFE_CORRELATION.test(inbound) ? inbound : newCorrelationId();

    const causation = req.header(CAUSATION_HEADER);
    const idempotencyKey = req.header(IDEMPOTENCY_HEADER);

    const context: RequestContext = {
      correlationId,
      ...(causation && SAFE_CORRELATION.test(causation) ? { causationId: causation } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      actorKind: 'SYSTEM',
      requestPath: `${req.method} ${req.path}`,
      ...(req.ip ? { ipAddress: req.ip } : {}),
      ...(req.header('user-agent') ? { userAgent: req.header('user-agent') } : {}),
    };

    // Echoed so a client — or a support engineer reading a browser network tab —
    // can quote the ID that appears in our logs.
    res.setHeader(CORRELATION_HEADER, correlationId);
    (req as Request & { correlationId?: string }).correlationId = correlationId;

    runWithContext(context, () => next());
  }
}
