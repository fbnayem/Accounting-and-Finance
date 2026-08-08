import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Pool } from 'pg';
import type { Response } from 'express';
import { Observable, from, lastValueFrom } from 'rxjs';
import { AppError } from '@acct/domain';
import { withIdempotency } from '@acct/database';
import { DATABASE_POOL } from './database.module';
import { ANONYMOUS_METADATA, OPERATION_METADATA, operationOrThrow } from './operation';
import type { AuthenticatedRequest } from './auth.guard';
import { contextFor } from './db';

/**
 * Applies F-044's idempotency protocol to every route the contract marks.
 *
 * `x-idempotency` is already on all 263 operations and CI checks it is there, so
 * there is nothing for a handler to declare and nothing for it to get wrong. What
 * the contract says the operation is, is what it gets:
 *
 *   required     no Idempotency-Key is a 422. 86 operations, all mutating.
 *   recommended  the key is honoured when sent and the route works without one.
 *   n-a          ignored.
 *
 * Phase 0 proved the mechanism on a scaffold route. This is the same mechanism
 * applied by position in the request pipeline instead of by each handler
 * remembering to call it, which is the difference between a protocol and a habit.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const handler = context.getHandler();
    if (this.reflector.get<boolean>(ANONYMOUS_METADATA, handler)) return next.handle();

    const operationId = this.reflector.get<string>(OPERATION_METADATA, handler);
    if (!operationId) return next.handle();
    const definition = operationOrThrow(operationId);
    if (definition.idempotency === 'n-a') return next.handle();

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const key = request.header('idempotency-key');

    if (!key) {
      if (definition.idempotency === 'required') {
        throw new AppError(
          'VALIDATION_FAILED',
          `${operationId} requires an Idempotency-Key header (x-idempotency: required).`,
          {
            fieldErrors: [
              { field: 'Idempotency-Key', code: 'REQUIRED', message: 'header is required' },
            ],
          },
        );
      }
      return next.handle();
    }

    const principal = request.principal;
    if (!principal?.tenantId) {
      // The key is scoped by tenant (idempotency_keys is keyed on it), so a request
      // with no tenant has nothing to be idempotent within. Signup is the only such
      // route, and it is idempotent through the unique constraint on the email.
      return next.handle();
    }

    // Params as well as body: `POST /accounting-periods/{id}/soft-close` carries no
    // body at all, and hashing an empty body would make one key reusable across
    // every period — the same key on a different period would replay the first
    // period's response instead of closing the second.
    const payload = { params: request.params, query: request.query, body: request.body };

    return from(
      (async () => {
        const outcome = await withIdempotency(
          this.pool,
          contextFor(principal, { idempotencyKey: key }),
          {
            tenantId: principal.tenantId!,
            operation: operationId,
            key,
            requestPayload: payload,
          },
          async () => {
            const body = await lastValueFrom(next.handle());
            return {
              statusCode: definition.successStatus,
              body: body ?? null,
              resourceType: definition.tag,
              resourceId: extractResourceId(body),
              value: body,
            };
          },
        );

        if (outcome.kind === 'replayed') {
          response.status(outcome.statusCode);
          response.setHeader('Idempotent-Replay', 'true');
          return outcome.body;
        }
        return outcome.value;
      })(),
    );
  }
}

function extractResourceId(body: unknown): string | null {
  if (body && typeof body === 'object' && 'id' in body) {
    const id = (body as { id: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}
