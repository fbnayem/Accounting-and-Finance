#!/usr/bin/env node
/**
 * The one documented command behind Phase 0 exit criterion 1:
 *
 *   "Clean checkout starts full local stack with one documented command."
 *
 *   pnpm stack:up      create .env, start containers, wait for health, migrate, seed
 *   pnpm stack:down    stop containers, keep volumes
 *   pnpm stack:reset   stop containers, DESTROY volumes, then start clean
 *
 * Deliberately dependency-free: it must run before `pnpm install` has produced
 * anything, because a clean checkout has no node_modules.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, readFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = [
  'compose',
  '-f',
  join(ROOT, 'infra', 'docker-compose.yml'),
  '--env-file',
  join(ROOT, '.env'),
];

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};
const step = (m) => console.log(`${c.cyan}${c.bold}==>${c.reset} ${c.bold}${m}${c.reset}`);
const ok = (m) => console.log(`    ${c.green}ok${c.reset}   ${m}`);
const warn = (m) => console.log(`    ${c.yellow}warn${c.reset} ${m}`);
const fail = (m) => console.error(`    ${c.red}fail${c.reset} ${m}`);

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: ROOT,
    shell: process.platform === 'win32',
    ...opts,
  });
  if (r.status !== 0 && !opts.allowFailure) {
    fail(`${cmd} ${args.join(' ')} exited ${r.status}`);
    process.exit(r.status ?? 1);
  }
  return r.status ?? 1;
}

function capture(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  return (r.stdout ?? '') + (r.stderr ?? '');
}

function requireDocker() {
  const out = capture('docker', ['version', '--format', '{{.Server.Version}}']);
  if (!/^\d+\./m.test(out)) {
    fail('Docker is not running. Start Docker Desktop (or the daemon) and retry.');
    process.exit(1);
  }
  ok(`docker engine ${out.trim().split('\n').pop()}`);
}

const keysOf = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l.trim())?.[1])
    .filter(Boolean);

function ensureEnv() {
  const env = join(ROOT, '.env');
  const examplePath = join(ROOT, '.env.example');
  if (!existsSync(env)) {
    copyFileSync(examplePath, env);
    ok('.env created from .env.example');
    return;
  }

  // A phase that adds a required variable would otherwise leave every existing
  // checkout failing at boot with a validation error and no hint that .env.example
  // moved underneath it. Missing keys are appended with their example values,
  // which for a development .env is the answer anyway.
  const example = readFileSync(examplePath, 'utf8');
  const present = new Set(keysOf(readFileSync(env, 'utf8')));
  const missing = example
    .split(/\r?\n/)
    .filter((line) => {
      const key = /^([A-Z][A-Z0-9_]*)=/.exec(line.trim())?.[1];
      return key && !present.has(key);
    })
    .map((l) => l.trim());

  if (missing.length === 0) {
    ok('.env present and complete');
    return;
  }
  appendFileSync(
    env,
    `\n# --- added by \`pnpm stack:up\` from .env.example ---\n${missing.join('\n')}\n`,
    'utf8',
  );
  warn(
    `.env was missing ${missing.length} variable(s); appended: ${keysOf(missing.join('\n')).join(', ')}`,
  );
}

async function waitHealthy(timeoutMs = 120_000) {
  const services = ['postgres', 'postgres_test', 'redis', 'minio'];
  const deadline = Date.now() + timeoutMs;
  process.stdout.write('    waiting for health');
  for (;;) {
    const states = services.map((s) => {
      const id = capture('docker', [...COMPOSE, 'ps', '-q', s])
        .trim()
        .split('\n')[0];
      if (!id) return 'missing';
      return capture('docker', ['inspect', '-f', '{{.State.Health.Status}}', id]).trim();
    });
    if (states.every((s) => s === 'healthy')) {
      process.stdout.write('\n');
      services.forEach((s, i) => ok(`${s} ${states[i]}`));
      return;
    }
    if (Date.now() > deadline) {
      process.stdout.write('\n');
      services.forEach((s, i) => fail(`${s}: ${states[i]}`));
      fail('services did not become healthy in time — `pnpm stack:logs` for detail');
      process.exit(1);
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function pnpmAvailable() {
  return /^\d+\./.test(capture('pnpm', ['--version']).trim());
}

async function up({ reset = false } = {}) {
  step('Preflight');
  requireDocker();
  ensureEnv();

  if (reset) {
    step('Destroying volumes');
    run('docker', [...COMPOSE, 'down', '-v', '--remove-orphans'], { allowFailure: true });
    ok('volumes removed');
  }

  step('Starting containers');
  run('docker', [...COMPOSE, 'up', '-d', '--wait=false']);

  step('Health');
  await waitHealthy();

  if (!existsSync(join(ROOT, 'node_modules'))) {
    step('Installing dependencies');
    if (!pnpmAvailable()) {
      fail(
        'pnpm not found. Install it with: corepack enable && corepack prepare pnpm@11 --activate',
      );
      process.exit(1);
    }
    run('pnpm', ['install', '--frozen-lockfile=false']);
  }

  step('Applying migrations');
  run('pnpm', ['db:migrate']);

  // After the migrations, because 0025 creates the `app_runtime` privilege set this
  // login role is granted. Before the seed, because everything downstream of here
  // connects as it.
  step('Creating the application database role');
  run('pnpm', ['db:runtime-role']);

  step('Seeding (profile: small)');
  const seeded = run('pnpm', ['db:seed', '--', '--profile', 'small'], { allowFailure: true });
  if (seeded !== 0) warn('seed skipped or failed — the stack is still usable');

  console.log(`
${c.green}${c.bold}Local stack is up.${c.reset}

  ${c.dim}API${c.reset}            http://localhost:${process.env.API_PORT ?? 3001}       ${c.dim}pnpm dev${c.reset}
  ${c.dim}Web${c.reset}            http://localhost:${process.env.WEB_PORT ?? 3000}
  ${c.dim}PostgreSQL${c.reset}     localhost:${process.env.POSTGRES_PORT ?? 55432}   ${c.dim}(test db on ${process.env.POSTGRES_TEST_PORT ?? 55433})${c.reset}
  ${c.dim}Redis${c.reset}          localhost:${process.env.REDIS_PORT ?? 56379}
  ${c.dim}MinIO console${c.reset}  http://localhost:${process.env.S3_CONSOLE_PORT ?? 9101}

  ${c.bold}pnpm dev${c.reset}          start api + worker + web
  ${c.bold}pnpm db:verify${c.reset}    prove the schema matches contracts/schema
  ${c.bold}pnpm stack:down${c.reset}   stop (keeps data)
`);
}

const cmd = process.argv[2] ?? 'up';
if (cmd === 'up') await up();
else if (cmd === 'reset') await up({ reset: true });
else if (cmd === 'down') {
  step('Stopping containers');
  run('docker', [...COMPOSE, 'down', '--remove-orphans']);
  ok('stopped (volumes kept — `pnpm stack:reset` to destroy them)');
} else {
  fail(`unknown command: ${cmd}. Use up | down | reset.`);
  process.exit(1);
}
