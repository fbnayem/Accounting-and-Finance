import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { loadApiEnv, loadOrExit } from '@acct/config';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/http-exception.filter';
import { APP_LOGGER } from './common/database.module';
import type { AppLogger } from './common/logger';
import { DELIVERED_PHASES, reconcileRoutes } from './common/operation';

async function bootstrap(): Promise<void> {
  // Configuration is validated before anything else starts. A process that cannot
  // read its own configuration must not come up half-configured and start
  // answering health checks.
  const env = loadOrExit(() => loadApiEnv());

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get<AppLogger>(APP_LOGGER);

  app.useGlobalFilters(new HttpExceptionFilter(logger));
  app.enableShutdownHooks();

  // The web app is a separate origin in development.
  app.enableCors({
    origin: [env.WEB_BASE_URL],
    credentials: true,
    exposedHeaders: ['x-correlation-id', 'idempotent-replay'],
  });

  // Every route reconciled against contracts/openapi.yaml before the port opens.
  //
  // This is Phase 1 exit criterion 4 made structural rather than sampled. It fails
  // the process on four things: a route with no @Operation (so no permission would
  // be enforced), a route naming an operation the contract does not define, a route
  // mounted at a path the contract does not agree with, and an operation from a
  // delivered phase with no handler at all. The last one is the direction that gets
  // forgotten — without it, deleting a controller shrinks the API and every
  // "all routes are covered" claim stays true by covering less.
  await app.init();
  const { mismatches, matched } = reconcileRoutes(app, { phases: DELIVERED_PHASES });
  if (mismatches.length > 0) {
    for (const mismatch of mismatches) logger.error({ kind: mismatch.kind }, mismatch.detail);
    logger.fatal(
      { mismatches: mismatches.length },
      'routes do not match contracts/openapi.yaml; refusing to start',
    );
    process.exit(1);
  }
  logger.info({ routes: matched }, 'routes reconciled against the contract');

  await app.listen(env.API_PORT, '0.0.0.0');

  logger.info(
    {
      port: env.API_PORT,
      web_origin: env.WEB_BASE_URL,
      phase0_sample: env.ENABLE_PHASE0_SAMPLE,
    },
    'api listening',
  );
}

bootstrap().catch((err) => {
  console.error('api failed to start', err);
  process.exit(1);
});
