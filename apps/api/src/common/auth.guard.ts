import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError } from '@acct/domain';
import { SessionService } from '../auth/session.service';
import { ANONYMOUS_METADATA, OPERATION_METADATA, operationOrThrow } from './operation';
import type { Principal } from './principal';

export interface AuthenticatedRequest extends Request {
  principal?: Principal;
  operationId?: string;
}

/**
 * Establishes who is calling, from the contract's own description of the route.
 *
 * The guard never asks the handler whether authentication is required. It reads
 * `security: []` out of contracts/openapi.yaml — the same field the contract check
 * uses to decide which routes are allowed to skip a permission — so "public" is one
 * fact recorded in one place rather than a decorator that can disagree with the
 * document it is supposed to implement.
 *
 * Fails closed. A route with no `@Operation` and no `@Anonymous` is rejected rather
 * than allowed, because a forgotten decorator is overwhelmingly more likely than a
 * deliberately unmarked endpoint.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  // Explicit tokens throughout. The dev runner is esbuild-based and does not
  // implement `emitDecoratorMetadata`, so Nest has no design-time type to infer
  // from — an inferred injection resolves to undefined and fails on first use,
  // which is a confusing runtime error for a purely build-level reason.
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const handler = context.getHandler();
    if (this.reflector.get<boolean>(ANONYMOUS_METADATA, handler)) return true;

    const operationId = this.reflector.get<string>(OPERATION_METADATA, handler);
    if (!operationId) {
      throw new AppError(
        'INTERNAL',
        `route ${context.getClass().name}.${handler.name} declares no @Operation`,
        { safeToExpose: false },
      );
    }
    const definition = operationOrThrow(operationId);

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    request.operationId = operationId;

    const header = request.header('authorization');
    const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;

    if (!bearer) {
      if (definition.unauthenticated) return true;
      throw new AppError('UNAUTHENTICATED', 'This request requires a signed-in session.');
    }

    // Resolved even for unauthenticated operations when a token is present: signing
    // up or logging in while already signed in should still know who you are, and
    // `logout` is reachable only that way.
    const principal = await this.sessions.resolve(bearer);
    if (!principal) {
      if (definition.unauthenticated) return true;
      throw new AppError('UNAUTHENTICATED', 'The session token is not valid.');
    }

    request.principal = principal;
    return true;
  }
}
