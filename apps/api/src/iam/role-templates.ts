/**
 * The eleven system roles doc 02 names, expressed as rules over the permission
 * registry rather than as eleven hand-written lists.
 *
 * doc 02: "System roles: Owner, Administrator, Accountant, Finance Manager, AR
 * Clerk, AP Clerk, Procurement, Cashier/Treasury, Inventory Manager, Auditor,
 * Viewer." The registry has 193 permissions today and grows every phase, so eleven
 * literal lists would be eleven things to remember to update — and the failure mode
 * is silent: a Phase 5 permission simply belongs to nobody, and the first person to
 * notice is a customer whose inventory manager cannot do their job.
 *
 * Instead each role is (resource families × the highest action tier it may reach),
 * plus explicit grants and denials where a rule would be wrong. Two properties are
 * then testable rather than asserted, and `role-templates.test.ts` tests both:
 *
 *   - every action in the registry is classified into a tier, so a new phase's
 *     permission cannot fall silently outside the model;
 *   - every permission a template names exists in the registry, which is ADR-0005's
 *     "CI fails if a role references a permission absent from the registry".
 */
import { PERMISSIONS, PERMISSION_DEFINITIONS, type Permission } from '@acct/contracts';

// ---------------------------------------------------------------------------
// Action tiers
// ---------------------------------------------------------------------------

export const TIERS = ['VIEW', 'OPERATE', 'APPROVE', 'ADMINISTER'] as const;
export type Tier = (typeof TIERS)[number];

/**
 * Every action the registry contains, placed in exactly one tier.
 *
 * ADMINISTER is not "the rest". It holds the actions that change what other people
 * can do, move money, or rewrite a determination someone else made — which is why
 * doc 02's seven high-risk categories all land there.
 */
const ACTION_TIER: Record<string, Tier> = {
  view: 'VIEW',
  tenant_view: 'VIEW',

  create: 'OPERATE',
  edit: 'OPERATE',
  edit_draft: 'OPERATE',
  submit: 'OPERATE',
  send: 'OPERATE',
  import: 'OPERATE',
  sync: 'OPERATE',
  categorize: 'OPERATE',
  match: 'OPERATE',
  allocate: 'OPERATE',
  // Phase 3. `apply` puts a credit note against an invoice and `confirm` records
  // that a sales order was accepted or that a payment settled at the bank. Both
  // move an existing document along its own lifecycle rather than deciding
  // anything about someone else's work, which is what separates OPERATE from
  // APPROVE here. Neither can originate the document it acts on: `credit_note.create`
  // and `vendor_payment.pay` are separate permissions, and `pay` is ADMINISTER.
  apply: 'OPERATE',
  confirm: 'OPERATE',
  count: 'OPERATE',
  adjust: 'OPERATE',
  issue: 'OPERATE',
  receive: 'OPERATE',
  transfer: 'OPERATE',
  revise: 'OPERATE',
  complete: 'OPERATE',
  prepare: 'OPERATE',
  snapshot: 'OPERATE',
  calculate: 'OPERATE',
  query: 'OPERATE',
  suggest: 'OPERATE',
  extract: 'OPERATE',
  run: 'OPERATE',
  remeasure: 'OPERATE',
  revalue: 'OPERATE',
  depreciate: 'OPERATE',
  capitalize: 'OPERATE',
  impair: 'OPERATE',
  dispose: 'OPERATE',
  bill: 'OPERATE',
  delegate: 'OPERATE',
  replay: 'OPERATE',
  install: 'OPERATE',
  cutover: 'OPERATE',
  delete: 'OPERATE',
  invite: 'OPERATE',
  post: 'OPERATE',
  reverse: 'OPERATE',
  reconcile: 'OPERATE',
  post_to_adjustment_period: 'OPERATE',

  // Decisions taken about someone else's work.
  approve: 'APPROVE',
  approve_action: 'APPROVE',
  finalize: 'APPROVE',
  certify: 'APPROVE',
  file: 'APPROVE',
  void: 'APPROVE',
  write_off: 'APPROVE',
  soft_close: 'APPROVE',
  hard_close: 'APPROVE',
  suspend: 'APPROVE',
  revoke: 'APPROVE',
  override_duplicate: 'APPROVE',
  // Phase 5. A judgement on work someone else did, which is what separates APPROVE
  // from OPERATE here: approving a stock count releases its variance as an
  // adjustment to inventory and the variance account, and the counter approving
  // their own count is the segregation-of-duties failure doc 08's count workflow
  // exists to prevent. (`reverse` is already classified above, at OPERATE, where
  // journal.reverse put it — correcting by reversal is ordinary accounting work.)
  count_approve: 'APPROVE',
  // Phase 5, F-106. Closing or cancelling a purchase order moves that order along
  // its own lifecycle and releases the commitment it still holds — the same shape
  // as `complete`, and procurement's own work rather than a judgement on anyone
  // else's. It is a separate permission from `purchase_order.approve` because
  // releasing budget is not the authority that committed it (F-921), but it is
  // the same tier.
  close: 'OPERATE',

  // Changes what others may do, moves money, or rewrites a determination.
  manage: 'ADMINISTER',
  configure: 'ADMINISTER',
  export: 'ADMINISTER',
  pay: 'ADMINISTER',
  execute: 'ADMINISTER',
  reopen: 'ADMINISTER',
  reconcile_reopen: 'ADMINISTER',
  override: 'ADMINISTER',
  post_control: 'ADMINISTER',
  // Phase 2. Destroying and rebuilding the balance projection, replacing a posting
  // rule and writing the opening position are all changes to how the ledger reads
  // rather than transactions within it, so they sit with the other ADMINISTER
  // actions rather than with `post`.
  rebuild: 'ADMINISTER',
  change_bank_details: 'ADMINISTER',
  entitlement: 'ADMINISTER',
  feature_flag: 'ADMINISTER',
  support_grant: 'ADMINISTER',
  tenant_manage: 'ADMINISTER',
};

export function tierOf(permission: string): Tier | null {
  const action = permission.slice(permission.indexOf('.') + 1);
  return ACTION_TIER[action] ?? null;
}

export function unclassifiedActions(): string[] {
  return [
    ...new Set(
      PERMISSIONS.filter((p) => tierOf(p) === null).map((p) => p.slice(p.indexOf('.') + 1)),
    ),
  ].sort();
}

// ---------------------------------------------------------------------------
// Resource families
// ---------------------------------------------------------------------------

export const FAMILIES = {
  ledger: [
    'account',
    'dimension',
    'journal',
    'journal_definition',
    'posting_rule',
    'opening_balance',
    'ledger',
  ],
  setup: [
    'organization',
    'legal_entity',
    'branch',
    'accounting_policy',
    'number_sequence',
    'fiscal_year',
    'accounting_period',
    'accounting_book',
    'currency',
    'exchange_rate',
    'localization',
  ],
  iam: ['user', 'role', 'session'],
  ar: [
    'customer',
    'quote',
    'sales_order',
    'invoice',
    'credit_note',
    'customer_receipt',
    'customer_refund',
    'dunning',
    'ar',
  ],
  ap: [
    'vendor',
    'vendor_bill',
    'vendor_credit',
    'vendor_payment',
    'payment_run',
    'payment_hold',
    'expense_claim',
  ],
  procurement: ['purchase_requisition', 'purchase_order', 'goods_receipt'],
  // `settlement` is banking rather than a family of its own: doc 06 puts processor
  // clearing inside cash management, and whoever reconciles the bank is who
  // reconciles the processor — the batch arrives as a bank line like any other.
  banking: ['bank', 'bank_account', 'bank_connection', 'bank_rule', 'bank_transfer', 'settlement'],
  inventory: ['item', 'warehouse', 'inventory'],
  // `asset_category` sits with `asset` rather than in setup: it carries the cost,
  // accumulated-depreciation, expense and disposal accounts every asset under it
  // posts to, so granting it is granting a say in the asset postings themselves.
  // Its `manage` action lands in ADMINISTER for the same reason `account.manage`
  // does — it decides where other people's transactions go.
  assets: ['asset', 'asset_category'],
  projects: ['project', 'budget', 'forecast'],
  tax: ['tax', 'tax_code', 'tax_period', 'tax_return', 'einvoice'],
  reporting: ['report', 'close', 'reconciliation', 'consolidation', 'fx'],
  workflow: ['approval', 'task', 'workflow'],
  ai: ['ai'],
  integration: ['integration', 'webhook', 'migration'],
  files: ['file'],
  audit: ['audit'],
  platform: ['platform'],
} as const;

export type Family = keyof typeof FAMILIES;

const RESOURCE_FAMILY = new Map<string, Family>(
  Object.entries(FAMILIES).flatMap(([family, resources]) =>
    resources.map((r) => [r, family as Family] as const),
  ),
);

export function familyOf(permission: string): Family | null {
  return RESOURCE_FAMILY.get(permission.slice(0, permission.indexOf('.'))) ?? null;
}

export function unclassifiedResources(): string[] {
  return [
    ...new Set(
      PERMISSIONS.filter((p) => familyOf(p) === null).map((p) => p.slice(0, p.indexOf('.'))),
    ),
  ].sort();
}

// ---------------------------------------------------------------------------
// The templates
// ---------------------------------------------------------------------------

export interface RoleTemplate {
  readonly code: string;
  readonly name: string;
  readonly description: string;
  /** Family → the highest tier this role reaches within it. Absent when `everything`. */
  readonly reach?: Partial<Record<Family, Tier>>;
  /** Everything, except what `deny` removes. Only the Owner uses this. */
  readonly everything?: boolean;
  readonly grant?: readonly string[];
  readonly deny?: readonly string[];
}

const TIER_ORDER: Record<Tier, number> = { VIEW: 0, OPERATE: 1, APPROVE: 2, ADMINISTER: 3 };

/**
 * The permissions doc 02 calls high-risk *for segregation of duties*: they move
 * money out of the business, change where it goes, or rewrite a control.
 *
 * The Administrator template denies these deliberately. An administrator manages
 * access; letting the same role also approve a payment run means one compromised
 * account can grant itself a vendor and pay it, and the audit trail will show a
 * perfectly ordinary sequence of authorised actions.
 */
export const SEGREGATION_SENSITIVE: readonly string[] = [
  'payment_run.approve',
  'payment_run.execute',
  'vendor_payment.pay',
  'vendor.change_bank_details',
  'tax.override',
  'journal.post_control',
  'accounting_period.reopen',
];

export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    code: 'owner',
    name: 'Owner',
    description:
      'Full control of the tenant, including roles and every high-risk permission. Created for the person who signs up and is never left as the only administrator by design.',
    everything: true,
    // The SaaS operator's surface (doc 23), not the customer's. An Owner who could
    // grant themselves platform.tenant_manage could suspend other people's tenants.
    deny: PERMISSIONS.filter((p) => p.startsWith('platform.')),
  },
  {
    code: 'administrator',
    name: 'Administrator',
    description:
      'Configures the organization, entities, users and roles. Deliberately cannot approve or execute payments, change vendor bank details, override tax, post to control accounts or reopen periods — doc 02 marks those high-risk and separating them from user administration is the point of the separation.',
    reach: {
      setup: 'ADMINISTER',
      iam: 'ADMINISTER',
      ledger: 'APPROVE',
      ar: 'APPROVE',
      ap: 'APPROVE',
      procurement: 'APPROVE',
      banking: 'APPROVE',
      inventory: 'ADMINISTER',
      assets: 'APPROVE',
      projects: 'ADMINISTER',
      tax: 'APPROVE',
      reporting: 'ADMINISTER',
      workflow: 'ADMINISTER',
      ai: 'ADMINISTER',
      integration: 'ADMINISTER',
      files: 'ADMINISTER',
      audit: 'ADMINISTER',
    },
    // Chart-of-accounts plumbing and projection recovery are administration, not
    // accounting judgement, and `reach.ledger: APPROVE` stops one tier short of them.
    grant: ['journal_definition.manage', 'ledger.rebuild'],
    deny: SEGREGATION_SENSITIVE,
  },
  {
    code: 'accountant',
    name: 'Accountant',
    description:
      'Maintains the ledger and the subledgers: journals, invoices, bills, banking, tax and reports. Prepares work; does not approve it and does not pay.',
    reach: {
      ledger: 'OPERATE',
      ar: 'OPERATE',
      ap: 'OPERATE',
      banking: 'OPERATE',
      tax: 'OPERATE',
      reporting: 'OPERATE',
      assets: 'OPERATE',
      projects: 'OPERATE',
      inventory: 'VIEW',
      procurement: 'VIEW',
      setup: 'VIEW',
      workflow: 'OPERATE',
      files: 'OPERATE',
      audit: 'VIEW',
      ai: 'VIEW',
    },
    grant: ['accounting_period.soft_close'],
    deny: SEGREGATION_SENSITIVE,
  },
  {
    code: 'finance_manager',
    name: 'Finance Manager',
    description:
      'Everything an Accountant does, plus the approvals and the period close. Approves payment runs but does not execute them, so the maker/checker split survives contact with a busy month end.',
    reach: {
      ledger: 'APPROVE',
      ar: 'APPROVE',
      ap: 'APPROVE',
      banking: 'APPROVE',
      tax: 'APPROVE',
      reporting: 'ADMINISTER',
      assets: 'APPROVE',
      projects: 'APPROVE',
      procurement: 'APPROVE',
      inventory: 'VIEW',
      setup: 'OPERATE',
      workflow: 'APPROVE',
      files: 'OPERATE',
      audit: 'VIEW',
      ai: 'OPERATE',
    },
    // posting_rule.manage and opening_balance.manage are accounting-policy decisions
    // — which accounts a future automatic journal touches, and what the ledger
    // started from — so they belong to the person who signs off the numbers, not to
    // whoever administers the user list.
    grant: [
      'payment_run.approve',
      'accounting_period.hard_close',
      'journal.post_control',
      'posting_rule.manage',
      'opening_balance.manage',
      'ledger.rebuild',
    ],
    deny: ['payment_run.execute', 'vendor_payment.pay', 'vendor.change_bank_details'],
  },
  {
    code: 'ar_clerk',
    name: 'AR Clerk',
    description:
      'Raises quotes, orders, invoices and credit notes and records receipts. Cannot approve, void or write off — those are the checks on the person who creates the document.',
    reach: { ar: 'OPERATE', files: 'OPERATE', ledger: 'VIEW', tax: 'VIEW', reporting: 'VIEW' },
    deny: ['ar.write_off', 'invoice.void'],
  },
  {
    code: 'ap_clerk',
    name: 'AP Clerk',
    description:
      'Enters vendor bills and credits, matches them to receipts and prepares payment runs. Cannot approve, pay, or change a vendor bank account.',
    reach: {
      ap: 'OPERATE',
      procurement: 'VIEW',
      files: 'OPERATE',
      ledger: 'VIEW',
      tax: 'VIEW',
      reporting: 'VIEW',
    },
    deny: ['vendor.change_bank_details', 'vendor_payment.pay', 'payment_run.execute'],
  },
  {
    code: 'procurement',
    name: 'Procurement',
    description:
      'Raises requisitions and purchase orders and records goods receipts. Sees vendors and items; does not see the money that follows.',
    reach: { procurement: 'OPERATE', inventory: 'VIEW' },
    grant: ['vendor.view', 'item.view', 'warehouse.view'],
    deny: ['purchase_order.approve'],
  },
  {
    code: 'treasury',
    name: 'Cashier / Treasury',
    description:
      'Runs the bank: imports, categorises, reconciles, and executes approved payments. Executes but does not approve, which is the other half of the maker/checker split.',
    reach: { banking: 'OPERATE' },
    grant: [
      'vendor_payment.pay',
      'vendor_payment.view',
      'vendor_payment.allocate',
      'payment_run.execute',
      'payment_run.view',
      'customer_receipt.create',
      'customer_receipt.view',
      'customer_receipt.allocate',
      'bank_transfer.create',
      'ledger.view',
      'report.view',
    ],
    deny: ['payment_run.approve', 'vendor.change_bank_details'],
  },
  {
    code: 'inventory_manager',
    name: 'Inventory Manager',
    description: 'Items, warehouses, stock movements, counts and adjustments.',
    reach: { inventory: 'OPERATE', procurement: 'VIEW' },
    grant: ['ledger.view', 'report.view'],
  },
  {
    code: 'auditor',
    name: 'Auditor',
    description:
      'Reads everything and changes nothing, including the audit trail and financial exports. The only read-only role that may export, because that is what an audit is.',
    reach: Object.fromEntries(
      (Object.keys(FAMILIES) as Family[])
        .filter((f) => f !== 'platform')
        .map((f) => [f, 'VIEW' as Tier]),
    ),
    grant: ['audit.view', 'report.export'],
  },
  {
    code: 'viewer',
    name: 'Viewer',
    description: 'Reads. No export, no audit trail.',
    reach: Object.fromEntries(
      (Object.keys(FAMILIES) as Family[])
        .filter((f) => f !== 'platform' && f !== 'audit')
        .map((f) => [f, 'VIEW' as Tier]),
    ),
  },
];

/** Resolves a template to the concrete permission codes it grants. */
export function permissionsFor(template: RoleTemplate): Permission[] {
  const denied = new Set(template.deny ?? []);
  const granted = new Set<string>();

  for (const permission of PERMISSIONS) {
    if (denied.has(permission)) continue;
    if (template.everything) {
      granted.add(permission);
      continue;
    }
    const family = familyOf(permission);
    const tier = tierOf(permission);
    if (!family || !tier) continue;
    const reach = template.reach?.[family];
    if (reach && TIER_ORDER[tier] <= TIER_ORDER[reach]) granted.add(permission);
  }

  for (const permission of template.grant ?? []) {
    if (!denied.has(permission)) granted.add(permission);
  }

  return [...granted].sort() as Permission[];
}

export function highRiskIn(template: RoleTemplate): Permission[] {
  return permissionsFor(template).filter((p) => PERMISSION_DEFINITIONS[p]?.isHighRisk);
}

export function templateByCode(code: string): RoleTemplate | undefined {
  return ROLE_TEMPLATES.find((t) => t.code === code);
}
