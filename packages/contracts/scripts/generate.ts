/**
 * Generates typed constants from the canonical YAML contracts.
 *
 * The generated files are committed and CI checks they are current
 * (`pnpm contracts:check`). That buys three things a runtime YAML parse would not:
 *
 *   - The API and worker containers do not need contracts/ copied into the image.
 *   - An event-name typo is a compile error rather than a runtime one.
 *   - A contract change shows up as a reviewable diff, which is how F-101's
 *     "22 events under two names" becomes visible at review time instead of at
 *     integration time.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GENERATED_DIR } from './shared';
import { renderGenerated } from './render';

mkdirSync(GENERATED_DIR, { recursive: true });

const files = renderGenerated();
for (const [name, content] of Object.entries(files)) {
  writeFileSync(join(GENERATED_DIR, name), content, 'utf8');
}

// Counted per block rather than across the whole file. The permission codes and
// the high-risk subset have the same line shape, so a file-wide match reported
// 212 for 193 permissions — a counter that inflates is worse than no counter.
const count = (text: string, start: string, end: string, shape: RegExp): number =>
  (text.split(start)[1]?.split(end)[0] ?? '').match(shape)?.length ?? 0;

const events = count(files['events.ts'] ?? '', 'EVENT_TYPES = [', '] as const', /^ {2}'\S+',$/gm);
const ops = files['operations.ts'] ?? '';
const operations = count(ops, 'OPERATION_IDS = [', '] as const', /^ {2}'\w+',$/gm);
const permissions = count(ops, 'PERMISSIONS = [', '] as const', /^ {2}'\S+',$/gm);
const highRisk = count(ops, 'HIGH_RISK_PERMISSIONS = [', '] as const', /^ {2}'\S+',$/gm);

console.log(
  `generated: ${events} events, ${operations} operations, ` +
    `${permissions} permissions (${highRisk} high-risk)`,
);
