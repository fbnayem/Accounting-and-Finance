import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { APP_LOGGER } from './database.module';
import type { AppLogger } from './logger';

/**
 * One log line per request, on completion.
 *
 * Logged on `finish` rather than on entry so the line carries the status and
 * duration — two lines per request doubles the volume and still requires a join
 * to answer "was it slow, and did it work".
 */
@Injectable()
export class RequestLoggingMiddleware implements NestMiddleware {
  constructor(@Inject(APP_LOGGER) private readonly logger: AppLogger) {}

  use(req: Request, res: Response, next: NextFunction): void {
    // Health probes run every few seconds and would otherwise be most of the log.
    if (req.path.startsWith('/health')) return next();

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      this.logger.info(
        {
          req: { method: req.method, path: req.path },
          res: { status: res.statusCode },
          duration_ms: Number(durationMs.toFixed(2)),
        },
        'request',
      );
    });
    next();
  }
}
