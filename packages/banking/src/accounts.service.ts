import { Pool } from 'pg';
import {
  AppError,
  notFound,
  uuidv7,
  D,
  assertEntityPermission,
  type TenantPrincipal,
} from '@acct/domain';
import { writeInTenant, readInTenant, recordAudit } from '@acct/database';

/**
 * Bank/cash account masters, connections, rules and cash position — doc 06
 * "Bank/cash account setup", "Bank rules", "Cash position".
 *
 * The connection half carries the one constraint the plan states as absolute:
 * "no connector receives database credentials". `bank_connections` stores a
 * secret-manager *reference* and this service never accepts a credential field,
 * so there is no code path by which one could be persisted even by mistake.
 */

const ACCOUNT_KINDS = new Set(['BANK', 'CREDIT_CARD', 'CASH', 'WALLET', 'PROCESSOR_CLEARING']);

export class BankAccountsService {
  constructor(private readonly pool: Pool) {}

  async createAccount(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      accountId: string;
      name: string;
      currency: string;
      kind?: string | undefined;
      bankConnectionId?: string | null | undefined;
      branchId?: string | null | undefined;
      bankName?: string | null | undefined;
      maskedAccountNumber?: string | null | undefined;
      iban?: string | null | undefined;
      swiftBic?: string | null | undefined;
      routingNumber?: string | null | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'bank_account.create', input.legalEntityId);

      const kind = input.kind ?? 'BANK';
      if (!ACCOUNT_KINDS.has(kind)) {
        throw new AppError(
          'VALIDATION_FAILED',
          `"${kind}" is not a bank account type. doc 06 names: ${[...ACCOUNT_KINDS].join(', ')}.`,
        );
      }

      // doc 06: "map each to GL account". A bank account with no GL account is a
      // record of an institution, not something a reconciliation can use — the
      // book balance in every session comes from this link.
      const { rows: accounts } = await client.query<{ id: string; is_posting: boolean }>(
        `SELECT id, is_posting FROM accounts WHERE id = $1 AND legal_entity_id = $2`,
        [input.accountId, input.legalEntityId],
      );
      const gl = accounts[0];
      if (!gl) throw notFound('account', input.accountId);
      if (!gl.is_posting) {
        throw new AppError(
          'ACCOUNT_NOT_POSTABLE',
          `Account ${input.accountId} is a heading. A bank account must map to a posting account.`,
        );
      }

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO bank_accounts
           (id, tenant_id, legal_entity_id, account_id, bank_connection_id, branch_id, kind,
            name, bank_name, masked_account_number, iban, swift_bic, routing_number, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING id, legal_entity_id, account_id, kind::text AS kind, name, bank_name,
                   masked_account_number, iban, swift_bic, routing_number, currency,
                   status::text AS status, created_at`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          input.accountId,
          input.bankConnectionId ?? null,
          input.branchId ?? null,
          kind,
          input.name,
          input.bankName ?? null,
          input.maskedAccountNumber ?? null,
          input.iban ?? null,
          input.swiftBic ?? null,
          input.routingNumber ?? null,
          input.currency,
        ],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'bank_account.created',
        resourceType: 'bank_account',
        resourceId: id,
        after: rows[0] as Record<string, unknown>,
      });

      return rows[0];
    });
  }

  /**
   * F-814 applies to every list in this package: the envelope is `{ data }`.
   *
   * These seven returned a bare JSON array until the Phase 4 screens were built
   * against them. The contract declares every 200 body as `{type: object}`, so
   * an array was a response the contract forbids; every other collection in the
   * system is enveloped; and an array has nowhere to put the `next_cursor` the
   * contract already defines for "all large collections" — which makes adding
   * pagination later a breaking change rather than an additive one.
   */
  async listAccounts(principal: TenantPrincipal, query: { legalEntityId?: string | undefined }) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT id, legal_entity_id, account_id, bank_connection_id, kind::text AS kind, name,
                bank_name, masked_account_number, currency, status::text AS status, created_at
           FROM bank_accounts
          WHERE ($1::uuid IS NULL OR legal_entity_id = $1)
          ORDER BY name`,
        [query.legalEntityId ?? null],
      );
      return { data: rows };
    });
  }

  /**
   * doc 16 and the plan's Phase 9 rule: a connector never receives database
   * credentials. What is stored is a reference into a secret manager, and this
   * method takes no credential parameter at all — the reference is created out
   * of band and named here.
   */
  async createConnection(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      provider: string;
      externalId?: string | null | undefined;
      encryptedConfigRef?: string | null | undefined;
      consentExpiresAt?: string | null | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'bank_connection.manage', input.legalEntityId);

      if (input.encryptedConfigRef && /[:/]{2}|password|secret=/i.test(input.encryptedConfigRef)) {
        throw new AppError(
          'VALIDATION_FAILED',
          'This looks like a credential or a connection string rather than a secret-manager ' +
            'reference. The platform stores references only — doc 16, and the standing rule that ' +
            'no connector receives database credentials.',
        );
      }

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO bank_connections
           (id, tenant_id, legal_entity_id, provider, external_id, encrypted_config_ref,
            consent_expires_at, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'DISCONNECTED')
         RETURNING id, legal_entity_id, provider, external_id, status::text AS status,
                   consent_expires_at, last_sync_at, created_at`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          input.provider,
          input.externalId ?? null,
          input.encryptedConfigRef ?? null,
          input.consentExpiresAt ?? null,
        ],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'bank_connection.expiring',
        resourceType: 'bank_connection',
        resourceId: id,
        after: rows[0] as Record<string, unknown>,
      });

      return rows[0];
    });
  }

  async listConnections(principal: TenantPrincipal, query: { legalEntityId?: string | undefined }) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT id, legal_entity_id, provider, external_id, status::text AS status,
                consent_expires_at, last_sync_at, next_sync_at, last_error, created_at
           FROM bank_connections
          WHERE ($1::uuid IS NULL OR legal_entity_id = $1)
          ORDER BY provider`,
        [query.legalEntityId ?? null],
      );
      // Never returns encrypted_config_ref. It is a pointer at a secret, and a
      // pointer in a response body is a pointer in a log.
      return { data: rows };
    });
  }

  // -------------------------------------------------------------------------
  // Bank rules — doc 06 "Bank rules", ordered and versioned (F-806).
  // -------------------------------------------------------------------------

  async createRule(
    principal: TenantPrincipal,
    input: {
      legalEntityId: string;
      name: string;
      conditions: Record<string, unknown>;
      actions: Record<string, unknown>;
      priority?: number | undefined;
      bankAccountId?: string | null | undefined;
      autoApply?: boolean | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      assertEntityPermission(principal, 'bank_rule.manage', input.legalEntityId);

      const id = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO bank_rules
           (id, tenant_id, legal_entity_id, bank_account_id, name, priority, version,
            conditions, actions, auto_apply)
         VALUES ($1,$2,$3,$4,$5,$6,1,$7,$8,$9)
         RETURNING id, legal_entity_id, name, priority, version, conditions, actions,
                   auto_apply, status::text AS status, created_at`,
        [
          id,
          principal.tenantId,
          input.legalEntityId,
          input.bankAccountId ?? null,
          input.name,
          input.priority ?? 100,
          JSON.stringify(input.conditions),
          JSON.stringify(input.actions),
          input.autoApply ?? false,
        ],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'bank_transaction.categorized',
        resourceType: 'bank_rule',
        resourceId: id,
        after: rows[0] as Record<string, unknown>,
      });

      return rows[0];
    });
  }

  async listRules(principal: TenantPrincipal, query: { legalEntityId?: string | undefined }) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query(
        `SELECT id, legal_entity_id, bank_account_id, name, priority, version, conditions,
                actions, auto_apply, status::text AS status, created_at
           FROM bank_rules
          WHERE ($1::uuid IS NULL OR legal_entity_id = $1)
            AND status = 'ACTIVE'
          ORDER BY priority, created_at`,
        [query.legalEntityId ?? null],
      );
      // doc 06: rules are ordered and conflict resolution is visible. Returned in
      // evaluation order, so the order is a fact of the response rather than
      // something each caller has to know to sort by.
      return { data: rows };
    });
  }

  /**
   * F-806. Priority and auto-apply are edited in place; conditions and actions
   * supersede the rule with a new version, because the old one is the
   * explanation for every transaction it already classified.
   */
  async updateRule(
    principal: TenantPrincipal,
    id: string,
    input: {
      priority?: number | undefined;
      autoApply?: boolean | undefined;
      conditions?: Record<string, unknown> | undefined;
      actions?: Record<string, unknown> | undefined;
      name?: string | undefined;
    },
  ) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: existing } = await client.query<{
        id: string;
        legal_entity_id: string;
        bank_account_id: string | null;
        name: string;
        priority: number;
        version: number;
        conditions: Record<string, unknown>;
        actions: Record<string, unknown>;
        auto_apply: boolean;
      }>(
        `SELECT id, legal_entity_id, bank_account_id, name, priority, version, conditions,
                actions, auto_apply
           FROM bank_rules WHERE id = $1 AND status = 'ACTIVE' FOR UPDATE`,
        [id],
      );
      const rule = existing[0];
      if (!rule) throw notFound('bank_rule', id);
      assertEntityPermission(principal, 'bank_rule.manage', rule.legal_entity_id);

      const logicChanged =
        (input.conditions !== undefined &&
          JSON.stringify(input.conditions) !== JSON.stringify(rule.conditions)) ||
        (input.actions !== undefined &&
          JSON.stringify(input.actions) !== JSON.stringify(rule.actions));

      if (!logicChanged) {
        const { rows } = await client.query(
          `UPDATE bank_rules
              SET priority = coalesce($2, priority),
                  auto_apply = coalesce($3, auto_apply),
                  name = coalesce($4, name)
            WHERE id = $1
          RETURNING id, name, priority, version, conditions, actions, auto_apply,
                    status::text AS status`,
          [id, input.priority ?? null, input.autoApply ?? null, input.name ?? null],
        );
        await recordAudit(client, context, {
          tenantId: principal.tenantId,
          action: 'bank_transaction.categorized',
          resourceType: 'bank_rule',
          resourceId: id,
          before: rule as unknown as Record<string, unknown>,
          after: rows[0] as Record<string, unknown>,
        });
        return { ...rows[0], superseded: false };
      }

      // Superseded: the old version is archived, not rewritten. doc 01 rule 7's
      // shape — a transaction categorised in March must still be explainable by
      // March's rule in December.
      await client.query(`UPDATE bank_rules SET status = 'ARCHIVED' WHERE id = $1`, [id]);
      const newId = uuidv7();
      const { rows } = await client.query(
        `INSERT INTO bank_rules
           (id, tenant_id, legal_entity_id, bank_account_id, name, priority, version,
            conditions, actions, auto_apply)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, name, priority, version, conditions, actions, auto_apply,
                   status::text AS status`,
        [
          newId,
          principal.tenantId,
          rule.legal_entity_id,
          rule.bank_account_id,
          input.name ?? rule.name,
          input.priority ?? rule.priority,
          rule.version + 1,
          JSON.stringify(input.conditions ?? rule.conditions),
          JSON.stringify(input.actions ?? rule.actions),
          input.autoApply ?? rule.auto_apply,
        ],
      );

      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'bank_transaction.categorized',
        resourceType: 'bank_rule',
        resourceId: newId,
        before: rule as unknown as Record<string, unknown>,
        after: rows[0] as Record<string, unknown>,
      });

      return { ...rows[0], superseded: true, supersedes: id };
    });
  }

  /** Archived, never deleted — see F-806. */
  async archiveRule(principal: TenantPrincipal, id: string) {
    return writeInTenant(this.pool, principal, async ({ client, context }) => {
      const { rows: existing } = await client.query<{ legal_entity_id: string }>(
        `SELECT legal_entity_id FROM bank_rules WHERE id = $1`,
        [id],
      );
      const rule = existing[0];
      if (!rule) throw notFound('bank_rule', id);
      assertEntityPermission(principal, 'bank_rule.manage', rule.legal_entity_id);

      await client.query(`UPDATE bank_rules SET status = 'ARCHIVED' WHERE id = $1`, [id]);
      await recordAudit(client, context, {
        tenantId: principal.tenantId,
        action: 'bank_transaction.categorized',
        resourceType: 'bank_rule',
        resourceId: id,
        after: { status: 'ARCHIVED' },
      });
      return undefined;
    });
  }

  /**
   * doc 06 "Cash position": per entity and currency, book balance, latest
   * imported bank balance, unreconciled amount and clearing balance — with
   * "values clearly distinguish bank-source vs book-source timestamps".
   *
   * That last clause is why every row carries two timestamps rather than one.
   * A cash figure whose provenance is unstated is the one people act on and then
   * discover was six hours stale.
   */
  async cashPosition(
    principal: TenantPrincipal,
    query: { legalEntityId?: string | undefined; asOf?: string | undefined },
  ) {
    return readInTenant(this.pool, principal, async ({ client }) => {
      const { rows } = await client.query<{
        bank_account_id: string;
        name: string;
        currency: string;
        kind: string;
        book_balance: string;
        book_balance_as_of: string | null;
        bank_balance: string | null;
        bank_balance_as_of: string | null;
        unreconciled: string;
        unreconciled_count: string;
      }>(
        `SELECT ba.id AS bank_account_id, ba.name, ba.currency, ba.kind::text AS kind,
                coalesce((
                  SELECT sum(l.base_debit - l.base_credit)
                    FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
                   WHERE l.account_id = ba.account_id AND e.status = 'POSTED'
                     AND ($2::date IS NULL OR l.posting_date <= $2::date)
                ), 0)::text AS book_balance,
                (SELECT max(l.posting_date)::text
                   FROM journal_lines l JOIN journal_entries e ON e.id = l.journal_entry_id
                  WHERE l.account_id = ba.account_id AND e.status = 'POSTED') AS book_balance_as_of,
                (SELECT s.bank_balance::text FROM bank_balance_snapshots s
                  WHERE s.bank_account_id = ba.id AND s.source <> 'COMPUTED'
                  ORDER BY s.as_of DESC LIMIT 1) AS bank_balance,
                (SELECT s.as_of::text FROM bank_balance_snapshots s
                  WHERE s.bank_account_id = ba.id AND s.source <> 'COMPUTED'
                  ORDER BY s.as_of DESC LIMIT 1) AS bank_balance_as_of,
                coalesce((
                  SELECT sum(t.amount) FROM bank_transactions t
                   WHERE t.bank_account_id = ba.id
                     AND t.reconciliation_state NOT IN ('RECONCILED','IGNORED','SPLIT')
                ), 0)::text AS unreconciled,
                (SELECT count(*) FROM bank_transactions t
                  WHERE t.bank_account_id = ba.id
                    AND t.reconciliation_state NOT IN ('RECONCILED','IGNORED','SPLIT')
                )::text AS unreconciled_count
           FROM bank_accounts ba
          WHERE ($1::uuid IS NULL OR ba.legal_entity_id = $1)
            AND ba.status = 'ACTIVE'
          ORDER BY ba.currency, ba.name`,
        [query.legalEntityId ?? null, query.asOf ?? null],
      );

      const byCurrency = new Map<
        string,
        { book: ReturnType<typeof D>; unreconciled: ReturnType<typeof D> }
      >();
      for (const r of rows) {
        const bucket = byCurrency.get(r.currency) ?? { book: D('0'), unreconciled: D('0') };
        byCurrency.set(r.currency, {
          book: bucket.book.add(D(r.book_balance)),
          unreconciled: bucket.unreconciled.add(D(r.unreconciled)),
        });
      }

      const { rows: clearing } = await client.query<{ currency: string; amount: string }>(
        `SELECT currency, coalesce(sum(gross_amount), 0)::text AS amount
           FROM payment_clearing_items
          WHERE ($1::uuid IS NULL OR legal_entity_id = $1) AND status = 'PENDING'
          GROUP BY currency`,
        [query.legalEntityId ?? null],
      );

      return {
        as_of: query.asOf ?? null,
        accounts: rows.map((r) => ({
          ...r,
          // Named rather than implied: doc 06 requires the reader be able to tell
          // which number came from the bank and which from our own books.
          book_balance_source: 'BOOK',
          bank_balance_source: r.bank_balance === null ? null : 'BANK_FEED',
        })),
        by_currency: [...byCurrency.entries()].map(([currency, totals]) => ({
          currency,
          book_balance: totals.book.toString(),
          unreconciled: totals.unreconciled.toString(),
          clearing_balance: clearing.find((c) => c.currency === currency)?.amount ?? '0',
        })),
      };
    });
  }
}
