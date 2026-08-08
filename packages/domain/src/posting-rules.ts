/**
 * The posting rule language.
 *
 * `project plan/posting_rule_catalog.md` opens with: "All rules are templates.
 * Concrete account IDs come from the entity/book accounting policy and installed
 * localization. Rules are versioned and effective-dated." doc 01 rule 7 makes the
 * versioning non-negotiable, and `posting_rule_versions.rule_definition` is a
 * `jsonb` column — which means the shape of that JSON is a contract, and until it
 * is written down every module that emits a rule invents its own.
 *
 * This is that shape, and an interpreter for it. It is deliberately small: it
 * expresses the catalog's forty rules and nothing else. No conditionals, no
 * arithmetic beyond multiply-by-a-factor, no loops except one over a named array.
 * A rule language that can compute cannot be reviewed by an accountant, and the
 * whole point of extracting rules from code is that an accountant can read them.
 *
 * Determinism is the property Phase 2 asks for ("Deterministic accounting event
 * and posting-rule infrastructure"): the same event and the same rule version
 * produce byte-identical lines, on any machine, at any later date. So there is no
 * clock, no random, no lookup that is not passed in.
 */
import { AppError } from './errors';
import { Decimal, D, MONEY_SCALE } from './decimal';
import type { DraftLineInput } from './posting';

// ---------------------------------------------------------------------------
// The language
// ---------------------------------------------------------------------------

/** Where a line's account comes from. Exactly one key. */
export type AccountSource =
  /** A column of `accounting_policies` — the catalog's "concrete account IDs come from the policy". */
  | { readonly policy: string }
  /** A field of the event carrying an account id, e.g. an invoice line's revenue account. */
  | { readonly event: string }
  /** A literal account code within the entity. Localization packs use this. */
  | { readonly code: string };

/** Where a line's amount comes from. Exactly one key. */
export type AmountSource =
  | { readonly event: string; readonly factor?: string }
  | { readonly const: string }
  /** Whatever makes the journal balance — the catalog's "Dr/Cr … for balancing result". */
  | { readonly balancing: true };

export type LineSide = 'DEBIT' | 'CREDIT';

export interface PostingRuleLine {
  /** Free-text label carried onto the journal line, e.g. "AR", "Output tax". */
  readonly role: string;
  readonly account: AccountSource;
  readonly side: LineSide;
  readonly amount: AmountSource;
  /** Event field naming the transaction currency; defaults to the event's `currency`. */
  readonly currency?: string;
  /** Event field naming the rate; defaults to the event's `exchange_rate`. */
  readonly rate?: string;
  /** Repeat this line once per element of the named event array, resolving fields against the element. */
  readonly forEach?: string;
  /** Event field naming a `{dimensionId: valueId}` object. */
  readonly dimensions?: string;
  /** Drop the line when its amount resolves to zero. Default true — zero lines are legal but noisy. */
  readonly omitIfZero?: boolean;
}

export interface PostingRuleDefinition {
  readonly event_type: string;
  readonly description?: string;
  readonly lines: readonly PostingRuleLine[];
}

export interface AccountingEvent {
  readonly eventType: string;
  readonly legalEntityId: string;
  readonly accountingBookId: string;
  readonly postingDate: string;
  readonly sourceType: string;
  readonly sourceId?: string | null;
  readonly sourceEventId?: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface RuleResolutionContext {
  /** `accounting_policies` row, flattened to `column -> account id`. */
  readonly policyAccounts: Readonly<Record<string, string | null>>;
  /** Account code -> id, for `{ code: … }` sources. */
  readonly accountsByCode: ReadonlyMap<string, string>;
  readonly baseCurrency: string;
}

// ---------------------------------------------------------------------------
// Validation — run when a rule version is created, not when it fires
// ---------------------------------------------------------------------------

const SIDES = new Set<LineSide>(['DEBIT', 'CREDIT']);

/**
 * Rejects a malformed rule at the moment someone writes it.
 *
 * A rule that fails at posting time fails during a month-end close, on a document
 * that has already been approved, in front of somebody who cannot fix it. The
 * `posting_rule.manage` route calls this before the INSERT.
 */
export function parsePostingRule(raw: unknown): PostingRuleDefinition {
  const problems: string[] = [];
  const doc = raw as Partial<PostingRuleDefinition> | null;

  if (!doc || typeof doc !== 'object') {
    throw invalid(['a posting rule is a JSON object with `event_type` and `lines`']);
  }
  if (typeof doc.event_type !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(doc.event_type)) {
    problems.push('`event_type` must be an UPPER_SNAKE_CASE identifier, e.g. SALES_INVOICE_POSTED');
  }
  if (!Array.isArray(doc.lines) || doc.lines.length === 0) {
    throw invalid([...problems, '`lines` must be a non-empty array']);
  }

  let balancing = 0;
  doc.lines.forEach((line, i) => {
    const at = `lines[${i}]`;
    if (typeof line?.role !== 'string' || line.role.length === 0) {
      problems.push(`${at}.role is required — it labels the line in every report and audit trail`);
    }
    if (!SIDES.has(line?.side as LineSide)) {
      problems.push(`${at}.side must be DEBIT or CREDIT`);
    }
    problems.push(...checkAccountSource(line?.account, `${at}.account`));
    problems.push(...checkAmountSource(line?.amount, `${at}.amount`));
    if (isBalancing(line?.amount)) balancing += 1;
    if (line?.forEach !== undefined && typeof line.forEach !== 'string') {
      problems.push(`${at}.forEach must name an array field of the event`);
    }
  });

  // Two balancing lines have no unique solution; the catalog never needs more than
  // one (ASSET_DISPOSAL's gain/loss, ROUNDING_ADJUSTMENT's residual).
  if (balancing > 1) {
    problems.push(
      `${balancing} lines are marked balancing. Only one line can absorb the residual, or the ` +
        'split between them is arbitrary.',
    );
  }

  if (problems.length > 0) throw invalid(problems);
  return doc as PostingRuleDefinition;
}

function isBalancing(amount: unknown): boolean {
  return typeof amount === 'object' && amount !== null && 'balancing' in amount;
}

function checkAccountSource(source: unknown, at: string): string[] {
  if (!source || typeof source !== 'object') return [`${at} must be an object`];
  const keys = Object.keys(source);
  const known = keys.filter((k) => k === 'policy' || k === 'event' || k === 'code');
  if (known.length !== 1 || keys.length !== 1) {
    return [
      `${at} must have exactly one of: policy, event, code (got ${keys.join(', ') || 'none'})`,
    ];
  }
  return [];
}

function checkAmountSource(source: unknown, at: string): string[] {
  if (!source || typeof source !== 'object') return [`${at} must be an object`];
  const keys = Object.keys(source).filter((k) => k !== 'factor');
  if (keys.length !== 1 || !['event', 'const', 'balancing'].includes(keys[0] as string)) {
    return [`${at} must have exactly one of: event, const, balancing`];
  }
  if ('const' in source) {
    try {
      D(String((source as { const: unknown }).const));
    } catch {
      return [`${at}.const is not a decimal literal`];
    }
  }
  if ('factor' in source) {
    try {
      D(String((source as { factor: unknown }).factor));
    } catch {
      return [`${at}.factor is not a decimal literal`];
    }
  }
  return [];
}

function invalid(problems: readonly string[]): AppError {
  // The problems are quoted in the message as well as listed in field_errors: a
  // rule is authored in a JSON editor, and "this posting rule is not valid" with
  // the reason somewhere else is the kind of error that gets retried verbatim.
  const shown = problems.slice(0, 3).join('; ');
  const more = problems.length > 3 ? ` (+${problems.length - 3} more)` : '';
  return new AppError('VALIDATION_FAILED', `This posting rule is not valid: ${shown}${more}`, {
    fieldErrors: problems.map((message, i) => ({
      field: `rule_definition[${i}]`,
      code: 'INVALID_RULE',
      message,
    })),
  });
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Reads `a.b.c` out of a nested payload. Missing means missing, not undefined-as-zero. */
function read(payload: Readonly<Record<string, unknown>>, path: string): unknown {
  let cursor: unknown = payload;
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

/**
 * Turns an event plus a rule version into draft lines.
 *
 * The output feeds `preparePosting`, which does the validating. This function's
 * only job is resolution: which account, which amount, which currency. Splitting
 * them means the simulation endpoint and the real posting path run identical code
 * and cannot drift — doc 03 requires the simulation to show "the journal that
 * would be created", and the only way to keep that promise is for it to be the
 * same journal.
 */
export function evaluatePostingRule(
  rule: PostingRuleDefinition,
  event: AccountingEvent,
  context: RuleResolutionContext,
): DraftLineInput[] {
  if (rule.event_type !== event.eventType) {
    throw new AppError(
      'POSTING_RULE_MISSING',
      `Rule version is for ${rule.event_type} but the event is ${event.eventType}.`,
      { details: { rule: rule.event_type, event: event.eventType } },
    );
  }

  const out: DraftLineInput[] = [];
  const balancingSlots: { index: number; side: 'DEBIT' | 'CREDIT' }[] = [];

  for (const line of rule.lines) {
    const scopes: Readonly<Record<string, unknown>>[] = line.forEach
      ? asArray(read(event.payload, line.forEach), line.forEach, line.role).map((element) => ({
          ...event.payload,
          ...(element as Record<string, unknown>),
        }))
      : [event.payload];

    for (const scope of scopes) {
      const accountId = resolveAccount(line, scope, context);
      const currency = String(
        (line.currency ? read(scope, line.currency) : read(scope, 'currency')) ??
          context.baseCurrency,
      );
      const rateRaw = line.rate ? read(scope, line.rate) : read(scope, 'exchange_rate');
      const exchangeRate = rateRaw === undefined || rateRaw === null ? null : String(rateRaw);
      const dimensions = line.dimensions
        ? (read(scope, line.dimensions) as Record<string, string> | undefined)
        : undefined;

      const base: DraftLineInput = {
        accountId,
        description: line.role,
        transactionCurrency: currency,
        exchangeRate,
        ...(dimensions ? { dimensions } : {}),
      };

      if (isBalancing(line.amount)) {
        balancingSlots.push({ index: out.length, side: line.side });
        out.push({ ...base, debit: '0', credit: '0' });
        continue;
      }

      const amount = resolveAmount(line.amount, scope, line.role);
      if (amount.isZero() && (line.omitIfZero ?? true)) continue;

      // A negative amount flips the side rather than posting a negative debit.
      // ASSET_DISPOSAL and VENDOR_CREDIT both rely on it, and journal_lines.
      // jl_nonneg forbids the alternative.
      const magnitude = amount.abs().toFixed(MONEY_SCALE);
      const side: LineSide = amount.isNegative() ? flip(line.side) : line.side;
      out.push({
        ...base,
        debit: side === 'DEBIT' ? magnitude : '0',
        credit: side === 'CREDIT' ? magnitude : '0',
      });
    }
  }

  // The balancing line is resolved last, from what the other lines produced. It is
  // computed in TRANSACTION currency only when every line shares one currency;
  // otherwise there is no single currency in which "the balance" is meaningful and
  // the rule is wrong for this event.
  if (balancingSlots.length === 1) {
    const slot = balancingSlots[0] as { index: number; side: LineSide };
    const others = out.filter((_, i) => i !== slot.index);
    const currencies = new Set(others.map((l) => l.transactionCurrency ?? context.baseCurrency));
    if (currencies.size > 1) {
      throw new AppError(
        'POSTING_RULE_MISSING',
        'A balancing line needs one transaction currency to balance in, and this event produced ' +
          `${currencies.size}: ${[...currencies].join(', ')}.`,
        { details: { currencies: [...currencies] } },
      );
    }
    const debit = others.reduce(
      (a, l) => a.add(D(l.debit ?? '0', MONEY_SCALE)),
      Decimal.zero(MONEY_SCALE),
    );
    const credit = others.reduce(
      (a, l) => a.add(D(l.credit ?? '0', MONEY_SCALE)),
      Decimal.zero(MONEY_SCALE),
    );
    const residual = debit.sub(credit);
    const side: LineSide = residual.isPositive() ? 'CREDIT' : 'DEBIT';
    const magnitude = residual.abs().toFixed(MONEY_SCALE);
    const existing = out[slot.index] as DraftLineInput;
    if (residual.isZero()) out.splice(slot.index, 1);
    else {
      out[slot.index] = {
        ...existing,
        debit: side === 'DEBIT' ? magnitude : '0',
        credit: side === 'CREDIT' ? magnitude : '0',
      };
    }
  }

  if (out.length === 0) {
    throw new AppError(
      'POSTING_RULE_MISSING',
      `Rule ${rule.event_type} produced no lines for this event. Every amount it names resolved ` +
        'to zero or was absent.',
      { details: { event_type: rule.event_type } },
    );
  }
  return out.map((line, i) => ({ ...line, lineNo: i + 1 }));
}

const flip = (side: LineSide): LineSide => (side === 'DEBIT' ? 'CREDIT' : 'DEBIT');

function asArray(value: unknown, path: string, role: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new AppError(
      'POSTING_RULE_MISSING',
      `Line "${role}" repeats over "${path}", which the event does not carry as an array.`,
      { details: { path, role } },
    );
  }
  return value;
}

function resolveAccount(
  line: PostingRuleLine,
  scope: Readonly<Record<string, unknown>>,
  context: RuleResolutionContext,
): string {
  const source = line.account;
  if ('policy' in source) {
    const id = context.policyAccounts[source.policy];
    if (!id) {
      throw new AppError(
        'POSTING_RULE_MISSING',
        `Line "${line.role}" needs the accounting policy's ${source.policy}, which is not ` +
          'configured for this entity. F-203: every posting rule resolves its accounts through ' +
          'the policy, so an unset mapping is a setup gap, not a posting failure.',
        { details: { role: line.role, policy_field: source.policy } },
      );
    }
    return id;
  }
  if ('code' in source) {
    const id = context.accountsByCode.get(source.code);
    if (!id) {
      throw new AppError(
        'POSTING_RULE_MISSING',
        `Line "${line.role}" names account code ${source.code}, which does not exist in this entity.`,
        { details: { role: line.role, code: source.code } },
      );
    }
    return id;
  }
  const value = read(scope, source.event);
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError(
      'POSTING_RULE_MISSING',
      `Line "${line.role}" takes its account from the event field "${source.event}", which is absent.`,
      { details: { role: line.role, field: source.event } },
    );
  }
  return value;
}

function resolveAmount(
  source: AmountSource,
  scope: Readonly<Record<string, unknown>>,
  role: string,
): Decimal {
  let value: Decimal;
  if ('const' in source) {
    value = D(source.const, MONEY_SCALE);
  } else if ('event' in source) {
    const raw = read(scope, source.event);
    if (raw === undefined || raw === null || raw === '') {
      throw new AppError(
        'POSTING_RULE_MISSING',
        `Line "${role}" takes its amount from "${source.event}", which the event does not carry.`,
        { details: { role, field: source.event } },
      );
    }
    if (typeof raw === 'number') {
      // ADR-0006 §1. A JSON number reaching here has already lost precision; the
      // event contract carries money as decimal strings for exactly this reason.
      throw new AppError(
        'VALIDATION_FAILED',
        `Line "${role}" read "${source.event}" as a JSON number. Money is carried as a decimal ` +
          'string on the wire (ADR-0006); a number has already been through binary floating point.',
        { details: { role, field: source.event } },
      );
    }
    value = D(String(raw), MONEY_SCALE);
  } else {
    return Decimal.zero(MONEY_SCALE);
  }

  const factor = (source as { factor?: string }).factor;
  return factor ? value.mul(D(factor)).rescale(MONEY_SCALE, 'DOWN') : value;
}
