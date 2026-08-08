import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AppError, requireContext, type ErrorResponseBody } from '@acct/domain';
import { mapDatabaseError, isDatabaseError } from '@acct/database';
import type { AppLogger } from './logger';

/**
 * Turns every thrown thing into the contract's `Error` shape:
 *
 *   required: [code, message, correlation_id]
 *   code: "Stable machine-readable code. Never a stack trace or SQL (doc 15)."
 *
 * The second half of that sentence is the reason this filter is a catch-all
 * rather than a handler for known errors. An unhandled `error: relation
 * "journal_lines" does not exist` reaching a customer is exactly what doc 15
 * forbids, and the only way to guarantee it cannot is to let nothing through
 * unformatted.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: AppLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();
    const correlationId = requireContext().correlationId;

    const appError = this.toAppError(exception);
    const body: ErrorResponseBody = appError.toResponse(correlationId);

    const logPayload = {
      err: {
        code: appError.code,
        message: appError.message,
        details: appError.details,
        stack: appError.stack,
        cause: appError.cause instanceof Error ? appError.cause.message : undefined,
      },
      req: { method: request.method, path: request.path },
      status: appError.httpStatus,
    };

    // 5xx is our fault and gets the full detail; 4xx is the caller's and would
    // otherwise fill the log with noise from ordinary validation failures.
    if (appError.httpStatus >= 500) this.logger.error(logPayload, 'request failed');
    else this.logger.warn(logPayload, 'request rejected');

    response.status(appError.httpStatus).json(body);
  }

  private toAppError(exception: unknown): AppError {
    if (AppError.isAppError(exception)) return exception;
    if (isDatabaseError(exception)) return mapDatabaseError(exception);

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as { message?: string | string[] }).message ?? exception.message);

      const code =
        status === 404
          ? 'NOT_FOUND'
          : status === 401
            ? 'UNAUTHENTICATED'
            : status === 403
              ? 'FORBIDDEN'
              : status === 405
                ? 'METHOD_NOT_ALLOWED'
                : status === 413
                  ? 'PAYLOAD_TOO_LARGE'
                  : status === 415
                    ? 'UNSUPPORTED_MEDIA_TYPE'
                    : status === 429
                      ? 'RATE_LIMITED'
                      : status < 500
                        ? 'VALIDATION_FAILED'
                        : 'INTERNAL';

      return new AppError(code, Array.isArray(message) ? message.join('; ') : String(message), {
        cause: exception,
        safeToExpose: status < 500,
      });
    }

    return new AppError('INTERNAL', 'An unexpected error occurred.', {
      cause: exception,
      safeToExpose: false,
    });
  }
}
