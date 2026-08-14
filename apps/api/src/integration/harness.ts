import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Pool } from 'pg';
import { createPool } from '@acct/database';
import { AppModule } from '../app.module';
import { HttpExceptionFilter } from '../common/http-exception.filter';
import { APP_LOGGER, DATABASE_POOL } from '../common/database.module';
import type { AppLogger } from '../common/logger';

/**
 * The real application, over real HTTP, against a real PostgreSQL.
 *
 * Deliberately not a unit test of the guards. The claims Phase 1 has to support —
 * "two tenants cannot access each other's records through UI, API or guessed IDs",
 * "an entity-restricted user cannot query or mutate another entity" — are claims
 * about the assembled system. A test that calls a service method directly proves
 * the service, and every one of those claims has failed historically somewhere
 * between the router and the service.
 */
let app: INestApplication | undefined;

export async function testApp(): Promise<INestApplication> {
  if (app) return app;
  app = await NestFactory.create(AppModule, { logger: false });
  const logger = app.get<AppLogger>(APP_LOGGER);
  app.useGlobalFilters(new HttpExceptionFilter(logger));
  await app.init();
  return app;
}

export async function closeTestApp(): Promise<void> {
  await app?.close();
  app = undefined;
  await ownerPool?.end();
  ownerPool = undefined;
}

/** The runtime pool the application itself uses — `app_runtime`, RLS applies. */
export function runtimePool(): Pool {
  return (app as INestApplication).get<Pool>(DATABASE_POOL);
}

let ownerPool: Pool | undefined;

/** The owner. Fixtures only: it is a superuser, so RLS does not apply to it. */
export function fixturePool(): Pool {
  ownerPool ??= createPool({
    connectionString: process.env.DATABASE_URL!,
    max: 6,
    applicationName: 'acct-api-fixtures',
    statementTimeoutMs: 30_000,
  });
  return ownerPool;
}

export function http() {
  return request((app as INestApplication).getHttpServer());
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export interface TenantFixture {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly email: string;
  readonly accessToken: string;
  readonly auth: { Authorization: string };
}

let counter = 0;

/**
 * Creates a tenant through the public signup route rather than through SQL.
 *
 * A fixture built with INSERTs can produce a state the application cannot: a
 * tenant with no Owner role, an entity with no primary book. Going through the
 * front door means the fixture is only ever a state a customer could reach.
 */
export async function createTenant(name = 'Fixture'): Promise<TenantFixture> {
  const unique = `${Date.now().toString(36)}-${counter++}`;
  const email = `owner-${unique}@example.test`;
  const response = await http()
    .post('/auth/signup')
    .send({
      email,
      password: 'fixture-password-1234',
      display_name: `${name} Owner`,
      tenant_name: `${name} ${unique}`,
      organization_name: `${name} Trading`,
    })
    .expect(201);

  return {
    tenantId: response.body.tenant_id,
    organizationId: response.body.organization_id,
    userId: response.body.user_id,
    email,
    accessToken: response.body.access_token,
    auth: { Authorization: `Bearer ${response.body.access_token}` },
  };
}

export async function createLegalEntity(
  tenant: TenantFixture,
  code: string,
  currency = 'GBP',
): Promise<{ id: string }> {
  const response = await http()
    .post('/legal-entities')
    .set(tenant.auth)
    .send({
      organization_id: tenant.organizationId,
      code,
      legal_name: `${code} Ltd`,
      country_code: 'GB',
      functional_currency: currency,
      timezone: 'Europe/London',
    })
    .expect(201);
  return { id: response.body.id };
}

/**
 * A second user in the same tenant, restricted to one legal entity.
 *
 * Built through invite + accept, so the membership is exactly the one the invite
 * flow produces. Phase 1 exit criterion 2 is about this user.
 */
export async function createEntityRestrictedUser(
  tenant: TenantFixture,
  legalEntityId: string,
  roleCode = 'accountant',
): Promise<{ auth: { Authorization: string }; userId: string; email: string }> {
  const roles = await http().get('/roles').set(tenant.auth).expect(200);
  const role = roles.body.data.find((r: { code: string }) => r.code === roleCode);
  if (!role) throw new Error(`no ${roleCode} role in the seeded templates`);

  const email = `restricted-${Date.now().toString(36)}-${counter++}@example.test`;
  const invite = await http()
    .post('/users/invite')
    .set(tenant.auth)
    .send({ email, role_id: role.id, legal_entity_id: legalEntityId })
    .expect(201);

  const accepted = await http()
    .post('/auth/invitations/accept')
    .send({
      token: invite.body.invitation_token,
      display_name: 'Restricted User',
      password: 'restricted-password-1234',
    })
    .expect(200);

  return {
    auth: { Authorization: `Bearer ${accepted.body.access_token}` },
    userId: accepted.body.user_id,
    email,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: a posting-ready entity
// ---------------------------------------------------------------------------

export interface PeriodFixture {
  readonly id: string;
  readonly name: string;
  readonly period_no: number;
  readonly start_date: string;
  readonly end_date: string;
  readonly is_adjustment: boolean;
}

export interface LedgerFixture {
  readonly legalEntityId: string;
  readonly accountingBookId: string;
  readonly fiscalYearId: string;
  readonly generalJournalId: string;
  readonly openingJournalId: string;
  readonly periods: readonly PeriodFixture[];
  /** Codes are stable so a test can say `accounts.cash` and mean 1000. */
  readonly accounts: Readonly<Record<AccountKey, string>>;
}

export type AccountKey =
  | 'cash'
  | 'bank'
  | 'ar'
  | 'equity'
  | 'revenue'
  | 'expense'
  | 'rounding'
  | 'heading'
  // Phase 3. A subledger document cannot post without these, and the exit
  // criterion is that its aging reconciles to a control account — so the fixture
  // has to have a real AP control account rather than borrowing the AR one.
  | 'ap'
  | 'outputTax'
  | 'inputTax'
  | 'badDebt'
  | 'grni'
  | 'customerAdvance'
  | 'vendorAdvance'
  | 'fxGain'
  | 'fxLoss'
  // Phase 4. A transfer needs two bank accounts, and processor clearing needs a
  // clearing account distinct from the bank — mapping it at the bank account
  // would make the settlement journal debit and credit the same account, and
  // "the clearing account clears exactly" would then be true of nothing.
  | 'bank2'
  | 'paymentClearing'
  | 'processingFee';

const CHART: readonly {
  key: AccountKey;
  code: string;
  name: string;
  type: string;
  control?: boolean;
  posting?: boolean;
}[] = [
  { key: 'cash', code: '1000', name: 'Cash', type: 'ASSET' },
  { key: 'bank', code: '1010', name: 'Bank', type: 'ASSET' },
  // The control account. Every "posting to a control account requires
  // journal.post_control" assertion needs one that really is flagged.
  { key: 'ar', code: '1100', name: 'Accounts receivable', type: 'ASSET', control: true },
  { key: 'equity', code: '3000', name: 'Opening balance equity', type: 'EQUITY' },
  { key: 'revenue', code: '4000', name: 'Revenue', type: 'REVENUE' },
  { key: 'expense', code: '6000', name: 'Operating expense', type: 'EXPENSE' },
  { key: 'rounding', code: '7999', name: 'Rounding gain or loss', type: 'EXPENSE' },
  // doc 03: "parent/reporting accounts cannot receive journal lines if non-posting."
  { key: 'heading', code: '9000', name: 'Reporting heading', type: 'EXPENSE', posting: false },
  { key: 'ap', code: '2100', name: 'Accounts payable', type: 'LIABILITY', control: true },
  { key: 'outputTax', code: '2200', name: 'Output tax payable', type: 'LIABILITY' },
  { key: 'inputTax', code: '1200', name: 'Input tax recoverable', type: 'ASSET' },
  { key: 'badDebt', code: '6100', name: 'Bad debt expense', type: 'EXPENSE' },
  { key: 'grni', code: '2150', name: 'Goods received not invoiced', type: 'LIABILITY' },
  { key: 'customerAdvance', code: '2300', name: 'Customer advances', type: 'LIABILITY' },
  { key: 'vendorAdvance', code: '1300', name: 'Vendor advances', type: 'ASSET' },
  { key: 'fxGain', code: '4900', name: 'Realized FX gain', type: 'REVENUE' },
  { key: 'fxLoss', code: '6900', name: 'Realized FX loss', type: 'EXPENSE' },
  { key: 'bank2', code: '1020', name: 'Bank - savings', type: 'ASSET' },
  { key: 'paymentClearing', code: '1150', name: 'Payment clearing', type: 'ASSET' },
  { key: 'processingFee', code: '6200', name: 'Payment processing fees', type: 'EXPENSE' },
];

/**
 * An entity that can actually post: chart, calendar, policy, sequence, journals,
 * activation.
 *
 * Built entirely through the API, like `createTenant`, so it is a state a customer
 * can reach. That matters more here than anywhere else — Gate C's claims are about
 * the posting path, and a fixture that INSERTed its way to a posting-ready entity
 * would be testing the posting path against a starting state the posting path
 * cannot produce.
 */
export async function createLedger(
  tenant: TenantFixture,
  options: { code?: string; currency?: string; year?: number } = {},
): Promise<LedgerFixture> {
  const code = options.code ?? `LED${counter++}`;
  const currency = options.currency ?? 'GBP';
  const year = options.year ?? 2027;

  const entity = await createLegalEntity(tenant, code, currency);

  const books = await http()
    .get('/accounting-books')
    .query({ legal_entity_id: entity.id })
    .set(tenant.auth)
    .expect(200);
  const bookId = books.body.data[0].id as string;

  const fiscalYear = await http()
    .post('/fiscal-years')
    .set(tenant.auth)
    .send({
      legal_entity_id: entity.id,
      name: `FY${year}`,
      start_date: `${year}-01-01`,
      end_date: `${year}-12-31`,
      period_length: 'MONTHLY',
      adjustment_periods: 1,
    })
    .expect(201);

  const accounts: Partial<Record<AccountKey, string>> = {};
  for (const account of CHART) {
    const created = await http()
      .post('/accounts')
      .set(tenant.auth)
      .send({
        legal_entity_id: entity.id,
        code: account.code,
        name: account.name,
        account_type: account.type,
        ...(account.control ? { is_control: true } : {}),
        ...(account.posting === false ? { is_posting: false } : {}),
      })
      .expect(201);
    accounts[account.key] = created.body.id;
  }

  await http()
    .post('/accounting-policies')
    .set(tenant.auth)
    .send({
      legal_entity_id: entity.id,
      valid_from: `${year}-01-01`,
      rounding_account_id: accounts.rounding,
      ar_control_account_id: accounts.ar,
      cash_clearing_account_id: accounts.cash,
      retained_earnings_account_id: accounts.equity,
      // Every Phase 3 posting rule resolves its accounts through this row. Mapping
      // them in the fixture rather than per test means a rule that silently
      // resolves to nothing fails as a missing-mapping error naming the column,
      // instead of as a journal that quietly omits a line.
      ap_control_account_id: accounts.ap,
      payment_clearing_account_id: accounts.paymentClearing,
      bad_debt_account_id: accounts.badDebt,
      grni_account_id: accounts.grni,
      customer_advance_account_id: accounts.customerAdvance,
      vendor_advance_account_id: accounts.vendorAdvance,
      realized_fx_gain_account_id: accounts.fxGain,
      realized_fx_loss_account_id: accounts.fxLoss,
    })
    .expect(201);

  await http()
    .post('/number-sequences')
    .set(tenant.auth)
    .send({
      legal_entity_id: entity.id,
      document_type: 'JOURNAL',
      prefix: `${code}-`,
      padding: 5,
    })
    .expect(201);

  const general = await http()
    .post('/journal-definitions')
    .set(tenant.auth)
    .send({
      accounting_book_id: bookId,
      code: 'GEN',
      name: 'General journal',
      journal_type: 'GENERAL',
    })
    .expect(201);

  const opening = await http()
    .post('/journal-definitions')
    .set(tenant.auth)
    .send({
      accounting_book_id: bookId,
      code: 'OPN',
      name: 'Opening journal',
      journal_type: 'OPENING',
    })
    .expect(201);

  await http().post(`/legal-entities/${entity.id}/activate`).set(tenant.auth).expect(200);

  return {
    legalEntityId: entity.id,
    accountingBookId: bookId,
    fiscalYearId: fiscalYear.body.id,
    generalJournalId: general.body.id,
    openingJournalId: opening.body.id,
    periods: fiscalYear.body.periods,
    accounts: accounts as Record<AccountKey, string>,
  };
}

// ---------------------------------------------------------------------------
// Phase 3: a subledger that can transact
// ---------------------------------------------------------------------------

export interface SubledgerFixture extends LedgerFixture {
  readonly customerId: string;
  readonly vendorId: string;
  /** VAT at 20%, one component, output and input accounts mapped. */
  readonly taxCodeId: string;
  readonly taxComponentId: string;
}

/**
 * A customer, a vendor and a working tax code on top of a posting-ready entity.
 *
 * Built through the API for the same reason `createLedger` is: the exit criteria
 * are claims about what the system does, and a fixture that INSERTs its way to a
 * transactable state would test those claims against a starting position the
 * system cannot itself produce.
 */
export async function createSubledger(
  tenant: TenantFixture,
  ledger: LedgerFixture,
  options: { year?: number } = {},
): Promise<SubledgerFixture> {
  const year = options.year ?? 2027;
  // tax_code.manage is high-risk (ADR-0005 §3), so the session has to have
  // satisfied MFA before it can configure tax at all.
  await satisfyMfa(tenant.userId);

  await http()
    .post('/tax-codes')
    .set(tenant.auth)
    .send({
      legal_entity_id: ledger.legalEntityId,
      code: 'VAT20',
      name: 'VAT 20%',
      kind: 'VAT',
      payable_account_id: ledger.accounts.outputTax,
      receivable_account_id: ledger.accounts.inputTax,
      nonrecoverable_account_id: ledger.accounts.expense,
      components: [{ code: 'VAT', name: 'VAT', sequence: 1 }],
    })
    .expect(201);

  // The component id comes from the list rather than the create response: the
  // create returns the code, and the rate hangs off the component.
  const codes = await http()
    .get('/tax-codes')
    .query({ legal_entity_id: ledger.legalEntityId })
    .set(tenant.auth)
    .expect(200);
  const code = codes.body.data.find((c: { code: string }) => c.code === 'VAT20');
  const componentId = code.components[0].id as string;

  await http()
    .post('/tax-rates')
    .set(tenant.auth)
    .send({
      tax_component_id: componentId,
      rate: '0.20',
      valid_from: `${year}-01-01`,
    })
    .expect(201);

  const customer = await http()
    .post('/customers')
    .set(tenant.auth)
    .send({
      organization_id: tenant.organizationId,
      legal_entity_id: ledger.legalEntityId,
      legal_name: 'Customer One Ltd',
      default_currency: 'GBP',
      payment_terms_days: 30,
      revenue_account_id: ledger.accounts.revenue,
    })
    .expect(201);

  const vendor = await http()
    .post('/vendors')
    .set(tenant.auth)
    .send({
      organization_id: tenant.organizationId,
      legal_entity_id: ledger.legalEntityId,
      legal_name: 'Vendor One Ltd',
      default_currency: 'GBP',
      payment_terms_days: 30,
      expense_account_id: ledger.accounts.expense,
    })
    .expect(201);

  return {
    ...ledger,
    customerId: customer.body.id,
    vendorId: vendor.body.id,
    taxCodeId: code.id,
    taxComponentId: componentId,
  };
}

/**
 * The closing balance of one account, read from the trial balance.
 *
 * Deliberately `source: 'journal_lines'` rather than the cached projection. The
 * exit criterion is that the subledger agrees with the ledger, and comparing it
 * against a read model that a worker maintains would leave "the projection is
 * stale" as an explanation for a disagreement that is really an accounting one.
 */
export async function accountBalance(
  tenant: TenantFixture,
  ledger: LedgerFixture,
  accountId: string,
): Promise<number> {
  const response = await http()
    .get('/reports/trial-balance')
    .query({ book_id: ledger.accountingBookId, source: 'journal_lines' })
    .set(tenant.auth)
    .expect(200);
  const row = response.body.data.find((r: { account_id: string }) => r.account_id === accountId);
  if (!row) return 0;
  return Number(row.closing_debit) - Number(row.closing_credit);
}

export function periodContaining(ledger: LedgerFixture, date: string): PeriodFixture {
  const period = ledger.periods.find(
    (p) => !p.is_adjustment && p.start_date <= date && date <= p.end_date,
  );
  if (!period) throw new Error(`no period contains ${date}`);
  return period;
}

/** A balanced two-line draft, posted. Returns the posted entry. */
export async function postJournal(
  tenant: TenantFixture,
  ledger: LedgerFixture,
  input: {
    postingDate: string;
    debitAccountId: string;
    creditAccountId: string;
    amount: string;
    description?: string;
  },
): Promise<{ id: string; entry_number: string }> {
  const draft = await http()
    .post('/journals')
    .set(tenant.auth)
    .send({
      accounting_book_id: ledger.accountingBookId,
      journal_id: ledger.generalJournalId,
      posting_date: input.postingDate,
      description: input.description ?? 'fixture journal',
      lines: [
        { account_id: input.debitAccountId, debit: input.amount },
        { account_id: input.creditAccountId, credit: input.amount },
      ],
    })
    .expect(201);

  const posted = await http()
    .post(`/journals/${draft.body.id}/post`)
    .set(tenant.auth)
    .set('Idempotency-Key', `post-${draft.body.id}`)
    .send({})
    .expect(200);

  return { id: posted.body.id, entry_number: posted.body.entry_number };
}

/**
 * A second session for the same user, with MFA already satisfied.
 *
 * Not `satisfyMfa`, which elevates every session the user has. The authorization
 * suite needs both states at once: an elevated session to build fixtures that
 * require high-risk permissions, and the original un-elevated one to prove those
 * same permissions demand re-authentication. Elevating in place would make the
 * second assertion pass for the wrong reason.
 */
export async function elevatedSession(tenant: TenantFixture): Promise<{ Authorization: string }> {
  const { createHash, randomUUID } = await import('node:crypto');
  const secret = randomUUID();
  const { rows } = await fixturePool().query<{ id: string }>(
    `INSERT INTO sessions (user_id, tenant_id, expires_at, access_expires_at, mfa_satisfied,
                           mfa_verified_at, access_token_hash)
     VALUES ($1, $2, now() + interval '1 hour', now() + interval '1 hour', true, now(), $3)
     RETURNING id`,
    [
      tenant.userId,
      tenant.tenantId,
      createHash('sha256').update(secret, 'utf8').digest('base64url'),
    ],
  );
  return { Authorization: `Bearer ${rows[0]!.id}.${secret}` };
}

/**
 * Marks a session as having satisfied MFA recently.
 *
 * The 19 high-risk permissions require it (ADR-0005 §3), and driving a real TOTP
 * enrolment through the API for every such test would test the clock rather than
 * the permission. `credentials.test.ts` covers the TOTP algorithm itself.
 */
export async function satisfyMfa(userId: string): Promise<void> {
  await fixturePool().query(
    `UPDATE sessions SET mfa_satisfied = true, mfa_verified_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
}
