import { Pool } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  D,
  assertEntityPermission,
  assertPermission,
  type TenantPrincipal,
} from '@acct/domain';
import { writeInTenant, readInTenant, recordAudit, publish } from '@acct/database';
import { ArService } from '@acct/subledger';
import { gatherBillableTime, type BillableTimeRow } from './billing';

/**
 * Projects and project billing — doc 10 "Projects" and "Billing proposals".
 *
 * The rule that shapes `createBillingProposal` is doc 10's, verbatim: "Billing
 * proposal gathers approved billable facts ... then creates a normal AR invoice
 * draft. No direct revenue posting from the project module." So this service
 * never touches a journal: the draft it produces goes through the same AR
 * approval and posting life as a hand-entered invoice, and there is one place
 * that decides what invoicing a customer means.
 */

/** Mirrors the CHECK on projects.billing_method in 0014, exactly. */
const BILLING_METHODS = new Set([
  'FIXED_FEE',
  'MILESTONE',
  'TIME_AND_MATERIALS',
  'EXPENSE_REIMBURSEMENT',
  'RETAINER',
  'PROGRESS',
]);

/** Mirrors `project_status` in 0000_extensions_and_types.sql, exactly. */
const PROJECT_STATUSES = new Set(['PLANNED', 'ACTIVE', 'ON_HOLD', 'COMPLETED', 'CLOSED']);

export class ProjectsService {
  constructor(
    private readonly pool: Pool,
    private readonly ar: ArService,
  ) {}

  async createProject(
    principal: TenantPrincipal,
    input: {
      organizationId: string;
      code: string;
      name: string;
      legalEntityId?: string | null | undefined;
      customerId?: string | null | undefined;
      managerUserId?: string | null | undefined;
      startDate?: string | null | undefined;
      endDate?: string | null | undefined;
      contractValue?: string | null | undefined;
      currency?: string | null | undefined;
      billingMethod?: string | null | undefined;
      settings?: Record<string, unknown> | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      // projects.legal_entity_id is nullable by design (0014: a project may span
      // an organization), so an org-wide project has no entity to scope the
      // check by — the tenant-wide grant is the only honest question left.
      if (input.legalEntityId) {
        assertEntityPermission(principal, 'project.create', input.legalEntityId);
      } else {
        assertPermission(principal, 'project.create');
      }

      if (input.billingMethod && !BILLING_METHODS.has(input.billingMethod)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${input.billingMethod}" is not a billing method. doc 10 names: ` +
            `${[...BILLING_METHODS].join(', ')}.`,
        );
      }
      if (input.startDate && input.endDate && input.endDate < input.startDate) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Project ends (${input.endDate}) before it starts (${input.startDate}).`,
        );
      }
      // Parsed before the INSERT so a malformed amount is a 422 naming the
      // field, not a database error dressed as a 500 (F-810's shape).
      const contractValue =
        input.contractValue === null || input.contractValue === undefined
          ? null
          : D(input.contractValue).toString();

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO projects
           (id, tenant_id, organization_id, legal_entity_id, customer_id, manager_user_id,
            code, name, start_date, end_date, contract_value, currency, billing_method, settings)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date,$10::date,$11::numeric,$12,$13,$14)
         RETURNING id, organization_id, legal_entity_id, customer_id, manager_user_id, code, name,
                   start_date::text AS start_date, end_date::text AS end_date,
                   contract_value::text AS contract_value, currency, billing_method,
                   status::text AS status, created_at`,
        [
          id,
          principal.tenantId,
          input.organizationId,
          input.legalEntityId ?? null,
          input.customerId ?? null,
          input.managerUserId ?? null,
          input.code,
          input.name,
          input.startDate ?? null,
          input.endDate ?? null,
          contractValue,
          input.currency ?? null,
          input.billingMethod ?? null,
          JSON.stringify(input.settings ?? {}),
        ],
      );

      // project.created is entity-scoped in events.yaml, so an org-wide project
      // (legal_entity_id NULL, legitimate per 0014) has no envelope to publish
      // on. The audit row below still records the creation either way.
      if (input.legalEntityId) {
        await publish(client, context, {
          eventType: 'project.created',
          aggregateType: 'project',
          aggregateId: id,
          tenantId: principal.tenantId,
          organizationId: input.organizationId,
          legalEntityId: input.legalEntityId,
          payload: { code: input.code, name: input.name },
        });
      }
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'project.created',
        resourceType: 'project',
        resourceId: id,
        after: rows[0] as Record<string, unknown>,
      });

      return rows[0];
    });
  }

  /** F-814: `{ data }`, never a bare array — see BankAccountsService.listAccounts. */
  async listProjects(
    principal: TenantPrincipal,
    query: {
      legalEntityId?: string | undefined;
      customerId?: string | undefined;
      status?: string | undefined;
    },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      if (query.status && !PROJECT_STATUSES.has(query.status)) {
        // Validated here because an unknown value would fail the enum cast in
        // the database and surface as a 500 instead of naming the mistake.
        throw new AppError(
          'VALIDATION_FAILED',
          `"${query.status}" is not a project status: ${[...PROJECT_STATUSES].join(', ')}.`,
        );
      }
      const { rows } = await client.query(
        `SELECT id, organization_id, legal_entity_id, customer_id, manager_user_id, code, name,
                start_date::text AS start_date, end_date::text AS end_date,
                contract_value::text AS contract_value, currency, billing_method,
                status::text AS status, closed_at, created_at
           FROM projects
          WHERE ($1::uuid IS NULL OR legal_entity_id = $1)
            AND ($2::uuid IS NULL OR customer_id = $2)
            AND ($3::project_status IS NULL OR status = $3::project_status)
          ORDER BY code`,
        [query.legalEntityId ?? null, query.customerId ?? null, query.status ?? null],
      );
      return { data: rows };
    });
  }

  /**
   * doc 10's billing hand-off, in one transaction: gather the approved unbilled
   * billable time, price it, create the AR invoice DRAFT, and record the
   * proposal that explains where the draft came from.
   *
   * The project row is locked first so two concurrent proposals serialize —
   * without the lock both would gather the same hours before either marks them
   * billed, and the customer would be invoiced twice for one timesheet.
   */
  async createBillingProposal(
    principal: TenantPrincipal,
    projectId: string,
    input: {
      accountingBookId: string;
      revenueAccountId: string;
      postingDate: string;
      documentDate?: string | undefined;
      periodStart?: string | undefined;
      periodEnd?: string | undefined;
      dueDate?: string | undefined;
      taxCodeId?: string | undefined;
      notes?: string | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: projects } = await client.query<{
        id: string;
        legal_entity_id: string | null;
        organization_id: string;
        customer_id: string | null;
        currency: string | null;
        code: string;
        name: string;
        status: string;
        closed_at: string | null;
      }>(
        `SELECT id, legal_entity_id, organization_id, customer_id, currency, code, name,
                status::text AS status, closed_at
           FROM projects WHERE id = $1 FOR UPDATE`,
        [projectId],
      );
      const project = projects[0];
      if (!project) throw notFound('project', projectId);

      if (!project.legal_entity_id) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Project ${project.code} belongs to no legal entity, and only a legal entity can ` +
            'issue an invoice. Assign the project to an entity first.',
        );
      }
      assertEntityPermission(principal, 'project.bill', project.legal_entity_id);

      if (!project.customer_id) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Project ${project.code} has no customer, so there is nobody to invoice.`,
        );
      }
      // doc 10: "closing blocks new ordinary cost/billing unless reopened."
      if (project.status === 'CLOSED' || project.closed_at !== null) {
        throw new AppError(
          'VALIDATION_FAILED',
          `Project ${project.code} is closed; reopen it before billing (doc 10).`,
        );
      }

      // Locked alongside the project: these rows are about to be marked billed,
      // and a concurrent approval flipping one mid-gather would price hours the
      // proposal then fails to claim.
      const { rows: entries } = await client.query<BillableTimeRow>(
        `SELECT id, hours::text AS hours, billing_rate::text AS billing_rate, currency,
                entry_date::text AS entry_date
           FROM time_entries
          WHERE project_id = $1
            AND billable AND NOT billed AND approved_at IS NOT NULL
            AND ($2::date IS NULL OR entry_date >= $2::date)
            AND ($3::date IS NULL OR entry_date <= $3::date)
          ORDER BY entry_date, id
          FOR UPDATE`,
        [projectId, input.periodStart ?? null, input.periodEnd ?? null],
      );

      const gathered = gatherBillableTime(entries, project.currency);

      const { rows: prior } = await client.query<{ total: string }>(
        `SELECT coalesce(sum(proposed_amount), 0)::text AS total
           FROM billing_proposals
          WHERE project_id = $1 AND status IN ('APPROVED','INVOICED')`,
        [projectId],
      );

      // The draft goes through ArService so numbering, tax, credit limit and the
      // calculation snapshot are AR's — asserting `invoice.create` inside is
      // deliberate: producing an invoice draft IS creating an invoice.
      const invoice = (await this.ar.createInvoiceInTransaction(client, context, principal, {
        accountingBookId: input.accountingBookId,
        customerId: project.customer_id,
        documentDate: input.documentDate ?? input.postingDate,
        postingDate: input.postingDate,
        dueDate: input.dueDate,
        currency: gathered.currency,
        notes: input.notes,
        lines: gathered.lines.map((line, index) => ({
          lineNo: index + 1,
          description:
            `${project.name}: professional services` +
            (input.periodStart || input.periodEnd
              ? ` ${input.periodStart ?? '…'} to ${input.periodEnd ?? '…'}`
              : ''),
          quantity: line.hours,
          unitPrice: line.billingRate,
          revenueAccountId: input.revenueAccountId,
          taxCodeId: input.taxCodeId,
        })),
      })) as unknown as {
        id: string;
        invoice_number: string | null;
        status: string;
        total: string;
      };

      // Each time entry is linked to the invoice line that priced it, and marked
      // billed at gather time — that mark is the only thing preventing a second
      // proposal from billing the same hours. Releasing hours from an abandoned
      // draft is an explicit un-bill decision this method cannot guess at.
      const { rows: invoiceLines } = await client.query<{ id: string; line_no: number }>(
        `SELECT id, line_no FROM invoice_lines WHERE invoice_id = $1`,
        [invoice.id],
      );
      for (const [index, line] of gathered.lines.entries()) {
        const invoiceLine = invoiceLines.find((l) => Number(l.line_no) === index + 1);
        await client.query(
          `UPDATE time_entries SET billed = true, invoice_line_id = $2 WHERE id = ANY($1::uuid[])`,
          [line.entryIds, invoiceLine?.id ?? null],
        );
      }

      const proposalId = uuidv7();
      const { rows: proposal } = await client.query(
        `INSERT INTO billing_proposals
           (id, tenant_id, project_id, legal_entity_id, period_start, period_end, currency,
            proposed_amount, previously_billed, unbilled_amount, status, invoice_id)
         VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8::numeric,$9::numeric,$10::numeric,
                 'INVOICED',$11)
         RETURNING id, project_id, legal_entity_id, period_start::text AS period_start,
                   period_end::text AS period_end, currency, proposed_amount::text AS proposed_amount,
                   previously_billed::text AS previously_billed,
                   unbilled_amount::text AS unbilled_amount, status, invoice_id, created_at`,
        [
          proposalId,
          principal.tenantId,
          projectId,
          project.legal_entity_id,
          input.periodStart ?? null,
          input.periodEnd ?? null,
          gathered.currency,
          gathered.totalAmount,
          prior[0]?.total ?? '0',
          // What was unbilled at gathering is exactly what this proposal
          // proposes; the two columns diverge only for proposal flows that cap
          // or split, which this single-route flow does not.
          gathered.totalAmount,
          invoice.id,
        ],
      );

      await publish(client, context, {
        eventType: 'billing_proposal.created',
        aggregateType: 'billing_proposal',
        aggregateId: proposalId,
        tenantId: principal.tenantId,
        organizationId: project.organization_id,
        legalEntityId: project.legal_entity_id,
        accountingBookId: input.accountingBookId,
        payload: {
          project_id: projectId,
          invoice_id: invoice.id,
          proposed_amount: gathered.totalAmount,
          currency: gathered.currency,
        },
      });
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'billing_proposal.created',
        resourceType: 'billing_proposal',
        resourceId: proposalId,
        after: proposal[0] as Record<string, unknown>,
      });

      return {
        ...proposal[0],
        time_entry_count: entries.length,
        invoice: {
          id: invoice.id,
          invoice_number: invoice.invoice_number,
          status: invoice.status,
          total: invoice.total,
        },
      };
    });
  }
}
