import type { Pool } from 'pg';
import { loadDotenv } from '@acct/config';
import { createPool } from '@acct/database';
import { uuidv7, type Grant, type TenantPrincipal } from '@acct/domain';

loadDotenv();

let pool: Pool | undefined;

export function testPool(): Pool {
  if (!pool) {
    const url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error('TEST_DATABASE_URL is not set — run `pnpm stack:up`');
    pool = createPool({
      connectionString: url,
      max: 10,
      applicationName: 'acct-approvals-test',
      // Short, so a lock-ordering defect fails a test in seconds rather than
      // hanging the suite. Two approvers racing one quorum is a test here.
      lockTimeoutMs: 4_000,
      statementTimeoutMs: 20_000,
    });
  }
  return pool;
}

export async function closeTestPool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}

export interface Actor {
  readonly userId: string;
  readonly sessionId: string;
  readonly principal: TenantPrincipal;
}

export interface ApprovalFixture {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly legalEntityId: string;
  readonly accountingBookId: string;
  readonly journalId: string;
  readonly accountingPeriodId: string;
  readonly accounts: { readonly cash: string; readonly revenue: string };
  readonly roles: {
    readonly approver: string;
    readonly admin: string;
    readonly clerk: string;
  };
  /** Raises documents, approves nothing. */
  readonly preparer: Actor;
  readonly approverA: Actor;
  readonly approverB: Actor;
  readonly approverC: Actor;
  /** Holds task.view only — used to prove the permission half of every control. */
  readonly clerk: Actor;
  readonly admin: Actor;
}

const APPROVER_PERMISSIONS = [
  'approval.view',
  'approval.approve',
  'approval.delegate',
  'task.view',
  'task.complete',
  'workflow.view',
];
const ADMIN_PERMISSIONS = [...APPROVER_PERMISSIONS, 'workflow.manage'];
const CLERK_PERMISSIONS = ['task.view', 'approval.view'];

/** The posting date every fixture document uses, inside the seeded open period. */
export const POSTING_DATE = '2027-03-15';

/**
 * A complete tenant: entity, book, period, chart, policy, roles and six people.
 *
 * Built with raw SQL rather than through the seed profiles because these tests
 * are about who may approve what, and that needs several people with DIFFERENT
 * permissions in one entity — which is the one shape a bulk seeder does not
 * produce.
 */
export async function createApprovalFixture(label: string): Promise<ApprovalFixture> {
  const db = testPool();
  const tenantId = uuidv7();
  const organizationId = uuidv7();
  const legalEntityId = uuidv7();
  const bookId = uuidv7();
  const journalId = uuidv7();
  const fiscalYearId = uuidv7();
  const periodId = uuidv7();
  const cashId = uuidv7();
  const revenueId = uuidv7();
  const slug = `approvals-${label}-${tenantId}`.toLowerCase();

  await db.query(
    `INSERT INTO currencies (code, name, minor_unit) VALUES ('USD','US Dollar',2)
     ON CONFLICT (code) DO NOTHING`,
  );
  await db.query(`INSERT INTO tenants (id, name, slug) VALUES ($1,$2,$3)`, [
    tenantId,
    `Approvals ${label}`,
    slug,
  ]);
  await db.query(`INSERT INTO organizations (id, tenant_id, name) VALUES ($1,$2,$3)`, [
    organizationId,
    tenantId,
    `Approvals ${label}`,
  ]);
  await db.query(
    `INSERT INTO legal_entities
       (id, tenant_id, organization_id, code, legal_name, country_code, functional_currency,
        timezone, posting_enabled)
     VALUES ($1,$2,$3,$4,$5,'GB','USD','UTC',true)`,
    [legalEntityId, tenantId, organizationId, `LE-${label}`.slice(0, 20), `Entity ${label}`],
  );
  await db.query(
    `INSERT INTO fiscal_years (id, tenant_id, legal_entity_id, name, start_date, end_date)
     VALUES ($1,$2,$3,'FY2027','2027-01-01','2027-12-31')`,
    [fiscalYearId, tenantId, legalEntityId],
  );
  await db.query(
    `INSERT INTO accounting_periods
       (id, tenant_id, legal_entity_id, fiscal_year_id, period_no, name, start_date, end_date, status)
     VALUES ($1,$2,$3,$4,3,'2027-03','2027-03-01','2027-03-31','OPEN')`,
    [periodId, tenantId, legalEntityId, fiscalYearId],
  );
  await db.query(
    `INSERT INTO accounting_books
       (id, tenant_id, legal_entity_id, code, name, base_currency, kind, is_primary)
     VALUES ($1,$2,$3,'PRIMARY','Primary','USD','PRIMARY',true)`,
    [bookId, tenantId, legalEntityId],
  );
  await db.query(
    `INSERT INTO journals (id, tenant_id, legal_entity_id, accounting_book_id, code, name, journal_type)
     VALUES ($1,$2,$3,$4,'GJ','General Journal','GENERAL')`,
    [journalId, tenantId, legalEntityId, bookId],
  );
  await db.query(
    `INSERT INTO accounts
       (id, tenant_id, legal_entity_id, code, name, account_type, normal_balance)
     VALUES ($1,$2,$3,'1000','Cash','ASSET','DEBIT'),
            ($4,$2,$3,'4000','Revenue','REVENUE','CREDIT')`,
    [cashId, tenantId, legalEntityId, revenueId],
  );

  const roleIds = {
    approver: uuidv7(),
    admin: uuidv7(),
    clerk: uuidv7(),
  };
  await db.query(
    `INSERT INTO roles (id, tenant_id, code, name) VALUES
       ($1,$4,'approver','Approver'),
       ($2,$4,'workflow_admin','Workflow admin'),
       ($3,$4,'clerk','Clerk')`,
    [roleIds.approver, roleIds.admin, roleIds.clerk, tenantId],
  );
  await grantRolePermissions(db, roleIds.approver, APPROVER_PERMISSIONS);
  await grantRolePermissions(db, roleIds.admin, ADMIN_PERMISSIONS);
  await grantRolePermissions(db, roleIds.clerk, CLERK_PERMISSIONS);

  const preparer = await createActor(db, {
    tenantId,
    organizationId,
    legalEntityId,
    label: `${label}-preparer`,
    roleId: roleIds.clerk,
    roleCode: 'clerk',
    permissions: CLERK_PERMISSIONS,
  });
  const approverA = await createActor(db, {
    tenantId,
    organizationId,
    legalEntityId,
    label: `${label}-approver-a`,
    roleId: roleIds.approver,
    roleCode: 'approver',
    permissions: APPROVER_PERMISSIONS,
  });
  const approverB = await createActor(db, {
    tenantId,
    organizationId,
    legalEntityId,
    label: `${label}-approver-b`,
    roleId: roleIds.approver,
    roleCode: 'approver',
    permissions: APPROVER_PERMISSIONS,
  });
  const approverC = await createActor(db, {
    tenantId,
    organizationId,
    legalEntityId,
    label: `${label}-approver-c`,
    roleId: roleIds.approver,
    roleCode: 'approver',
    permissions: APPROVER_PERMISSIONS,
  });
  const clerk = await createActor(db, {
    tenantId,
    organizationId,
    legalEntityId,
    label: `${label}-clerk`,
    roleId: roleIds.clerk,
    roleCode: 'clerk',
    permissions: CLERK_PERMISSIONS,
  });
  const admin = await createActor(db, {
    tenantId,
    organizationId,
    legalEntityId,
    label: `${label}-admin`,
    roleId: roleIds.admin,
    roleCode: 'workflow_admin',
    permissions: ADMIN_PERMISSIONS,
  });

  return {
    tenantId,
    organizationId,
    legalEntityId,
    accountingBookId: bookId,
    journalId,
    accountingPeriodId: periodId,
    accounts: { cash: cashId, revenue: revenueId },
    roles: roleIds,
    preparer,
    approverA,
    approverB,
    approverC,
    clerk,
    admin,
  };
}

async function grantRolePermissions(
  db: Pool,
  roleId: string,
  permissions: readonly string[],
): Promise<void> {
  await db.query(
    `INSERT INTO role_permissions (role_id, permission_code)
     SELECT $1, code FROM permissions WHERE code = ANY($2::text[])
     ON CONFLICT DO NOTHING`,
    [roleId, permissions],
  );
  // The seed above is silent when a permission code does not exist, and a
  // silently empty grant would make every authorization test pass by refusing
  // everybody. Assert the count instead.
  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM role_permissions WHERE role_id = $1`,
    [roleId],
  );
  if (rows[0]?.n !== String(permissions.length)) {
    throw new Error(
      `role ${roleId} received ${rows[0]?.n} of ${permissions.length} permissions — a permission ` +
        `code in the fixture is not in the permissions registry`,
    );
  }
}

async function createActor(
  db: Pool,
  params: {
    tenantId: string;
    organizationId: string;
    legalEntityId: string;
    label: string;
    roleId: string;
    roleCode: string;
    permissions: readonly string[];
  },
): Promise<Actor> {
  const userId = uuidv7();
  const sessionId = uuidv7();
  const membershipId = uuidv7();

  await db.query(`INSERT INTO users (id, email, display_name) VALUES ($1,$2,$3)`, [
    userId,
    `${params.label}-${userId}@example.test`,
    params.label,
  ]);
  await db.query(
    `INSERT INTO sessions (id, user_id, tenant_id, expires_at, mfa_satisfied)
     VALUES ($1,$2,$3, now() + interval '1 day', true)`,
    [sessionId, userId, params.tenantId],
  );
  await db.query(
    `INSERT INTO memberships (id, tenant_id, user_id, role_id, organization_id, legal_entity_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [
      membershipId,
      params.tenantId,
      userId,
      params.roleId,
      params.organizationId,
      params.legalEntityId,
    ],
  );

  const grant: Grant = {
    membershipId,
    roleId: params.roleId,
    roleCode: params.roleCode,
    organizationId: params.organizationId,
    legalEntityId: params.legalEntityId,
    branchId: null,
    permissions: new Set(params.permissions),
  };
  const principal: TenantPrincipal = {
    userId,
    sessionId,
    email: `${params.label}@example.test`,
    displayName: params.label,
    tenantId: params.tenantId,
    grants: [grant],
    mfaSatisfied: true,
    mfaVerifiedAt: new Date(),
    impersonatedBy: null,
  };
  return { userId, sessionId, principal };
}

/** An accounting policy version carrying a journal approval threshold. */
export async function setJournalApprovalThreshold(
  fx: ApprovalFixture,
  threshold: string | null,
): Promise<void> {
  const db = testPool();
  await db.query(
    `INSERT INTO accounting_policies
       (id, tenant_id, legal_entity_id, version, valid_from, journal_approval_threshold)
     VALUES ($1,$2,$3,1,'2027-01-01',$4::numeric)`,
    [uuidv7(), fx.tenantId, fx.legalEntityId, threshold],
  );
}

/**
 * A balanced DRAFT journal for `amount`.
 *
 * Balanced because `journal_entries_balanced` is a deferred constraint trigger
 * and would refuse it at COMMIT otherwise — which is worth saying out loud: a
 * fixture in this schema cannot produce a corrupt ledger even by accident.
 */
export async function createDraftJournal(
  fx: ApprovalFixture,
  params: { amount: string; preparedBy: string | null; description?: string },
): Promise<string> {
  const db = testPool();
  const id = uuidv7();
  await db.query(
    `INSERT INTO journal_entries
       (id, tenant_id, legal_entity_id, accounting_book_id, journal_id, accounting_period_id,
        posting_date, document_date, description, source_type, base_currency, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::date,$7::date,$8,'MANUAL','USD','DRAFT',$9)`,
    [
      id,
      fx.tenantId,
      fx.legalEntityId,
      fx.accountingBookId,
      fx.journalId,
      fx.accountingPeriodId,
      POSTING_DATE,
      params.description ?? 'fixture journal',
      params.preparedBy,
    ],
  );
  await db.query(
    `INSERT INTO journal_lines
       (id, tenant_id, journal_entry_id, legal_entity_id, accounting_book_id, accounting_period_id,
        posting_date, line_no, account_id, transaction_currency, transaction_debit,
        transaction_credit, base_currency, base_debit, base_credit)
     VALUES
       ($1,$2,$3,$4,$5,$6,$7::date,1,$8,'USD',$10::numeric,0,'USD',$10::numeric,0),
       ($9,$2,$3,$4,$5,$6,$7::date,2,$11,'USD',0,$10::numeric,'USD',0,$10::numeric)`,
    [
      uuidv7(),
      fx.tenantId,
      id,
      fx.legalEntityId,
      fx.accountingBookId,
      fx.accountingPeriodId,
      POSTING_DATE,
      fx.accounts.cash,
      uuidv7(),
      params.amount,
      fx.accounts.revenue,
    ],
  );
  return id;
}

export interface PostAttempt {
  readonly posted: boolean;
  readonly message: string;
}

/**
 * Attempts to post a journal by the shortest possible route: a direct UPDATE.
 *
 * Deliberately NOT through `JournalService.post`. The claim under test is that a
 * bypass fails at the DOMAIN layer — so the test has to bypass the application
 * entirely and see whether anything still refuses. What refuses is 0049's
 * DEFERRABLE INITIALLY DEFERRED constraint trigger, which fires at COMMIT of
 * this transaction.
 */
export async function attemptPost(
  journalId: string,
  postedBy: string,
  entryNumber: string,
): Promise<PostAttempt> {
  const db = testPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE journal_entries
          SET status = 'POSTED', entry_number = $2, posted_at = now(), posted_by = $3
        WHERE id = $1`,
      [journalId, entryNumber, postedBy],
    );
    await client.query('COMMIT');
    return { posted: true, message: '' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    return { posted: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    client.release();
  }
}

export async function journalRow(
  id: string,
): Promise<{ status: string; approval_state: string; approved_by: string | null } | undefined> {
  const { rows } = await testPool().query<{
    status: string;
    approval_state: string;
    approved_by: string | null;
  }>(
    `SELECT status::text AS status, approval_state::text AS approval_state, approved_by
       FROM journal_entries WHERE id = $1`,
    [id],
  );
  return rows[0];
}

/** A published workflow, in one call. */
export interface WorkflowSeed {
  readonly code: string;
  readonly conditions?: Record<string, unknown>;
  readonly definition: Record<string, unknown>;
  readonly resourceType?: string;
  readonly entityScoped?: boolean;
}
