import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

export * from './schema';
import { apiSchema, webSchema, workerSchema, testSchema } from './schema';

let dotenvLoaded = false;

/**
 * Loads `.env` from the repository root, once. Real deployments inject variables
 * directly and have no `.env`; that is not an error.
 */
export function loadDotenv(root = process.cwd()): void {
  if (dotenvLoaded) return;
  dotenvLoaded = true;
  for (const dir of [
    root,
    resolve(root, '..'),
    resolve(root, '../..'),
    resolve(root, '../../..'),
  ]) {
    const p = resolve(dir, '.env');
    if (existsSync(p)) {
      dotenvConfig({ path: p });
      return;
    }
  }
}

export class EnvironmentValidationError extends Error {
  constructor(readonly issues: z.ZodIssue[]) {
    const lines = issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`);
    super(`Invalid environment configuration:\n${lines.join('\n')}`);
    this.name = 'EnvironmentValidationError';
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  loadDotenv();
  const result = schema.safeParse({ ...process.env, ...source });
  if (!result.success) throw new EnvironmentValidationError(result.error.issues);
  return result.data;
}

export const loadApiEnv = (src: NodeJS.ProcessEnv = {}) =>
  parse(apiSchema, { SERVICE_NAME: 'api', ...src });
export const loadWorkerEnv = (src: NodeJS.ProcessEnv = {}) =>
  parse(workerSchema, { SERVICE_NAME: 'worker', ...src });
export const loadWebEnv = (src: NodeJS.ProcessEnv = {}) =>
  parse(webSchema, { SERVICE_NAME: 'web', ...src });
export const loadTestEnv = (src: NodeJS.ProcessEnv = {}) =>
  parse(testSchema, { SERVICE_NAME: 'test', NODE_ENV: 'test', ...src });

/**
 * Prints the validation failure in a form a developer can act on, then exits.
 * Used by every entrypoint — a process that cannot read its configuration must
 * not start half-configured.
 */
export function loadOrExit<T>(loader: () => T): T {
  try {
    return loader();
  } catch (err) {
    if (err instanceof EnvironmentValidationError) {
      console.error(`\n${err.message}\n\nSee .env.example for the expected values.\n`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }
}
