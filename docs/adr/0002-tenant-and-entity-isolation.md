# ADR-0002 — Tenant and entity isolation

**Status:** Accepted · 2026-08-07
**Resolves:** [D-02](../../audit/07_Open_Decisions.md#d-02--tenant-and-entity-isolation-mechanism) ·
[F-003](../../audit/01_Schema_Findings.md), [F-040](../../audit/01_Schema_Findings.md)

## Context

The blueprint has `tenant_id` on almost every table and **no mechanism enforcing that a row's
references stay inside its own tenant or legal entity**. `journal_lines.account_id` could reference
another entity's account; the same hole exists on every account, contact and document reference in
the schema. Blueprint note 2 acknowledged the gap and deferred it.

An application bug — a stale cached account list, a mis-scoped lookup, a copy-paste in a posting rule
— posts entity A's transaction into entity B's ledger. The journal still balances, so no invariant
catches it. It surfaces weeks later as an unexplainable control-account difference, possibly in a
closed period.

Gate B requires "cross-tenant object ID probes return no data" and "entity scope is enforced
server-side". Gate C requires ledger integrity. Neither is achievable while referential integrity
permits cross-entity references.

## Decision

**Composite foreign keys are the primary mechanism.** RLS is added in Phase 1 as defence-in-depth,
not as the primary control.

Parents carry a composite unique key alongside their primary key:

```sql
-- example: accounts
ALTER TABLE accounts ADD CONSTRAINT accounts_scope_uq
  UNIQUE (id, legal_entity_id, accounting_book_id);
```

Children reference the composite, using scope columns they already carry (which ADR-0003 guarantees
for `journal_lines`):

```sql
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_account_scope_fk
  FOREIGN KEY (account_id, legal_entity_id, accounting_book_id)
  REFERENCES accounts (id, legal_entity_id, accounting_book_id);
```

A cross-entity reference then fails at insert, in every code path, including migrations, background
workers, bulk imports and the report engine.

### Scope columns by grain

| Grain           | Scope columns propagated                         |
| --------------- | ------------------------------------------------ |
| Platform        | `tenant_id`                                      |
| Organization    | `tenant_id, organization_id`                     |
| Legal entity    | `tenant_id, legal_entity_id`                     |
| Accounting book | `tenant_id, legal_entity_id, accounting_book_id` |

A child never references a parent of finer grain than itself.

### Polymorphic references

Composite FKs cannot express `(source_type, source_id)`. For those
([F-050](../../audit/01_Schema_Findings.md)) the controls are: the `*_type` column is an enum, the
owning service validates existence on write, the row carries its own scope columns, and a nightly
orphan-detection job reports into the Gate D reconciliation suite.

## Consequences

- Every child table must carry its parent's scope columns. This is why ADR-0003's denormalisation of
  `journal_lines` is a prerequisite, not an independent optimisation.
- Wider foreign key indexes and slightly larger rows. Measure under Gate H (ADR-0009); the cost is
  paid on write, and posting is not the platform's highest-volume operation.
- **RLS is deliberately not primary.** It depends on connection-level session state, and background
  workers, migrations, the report engine and bulk importers all connect differently — exactly the
  paths where setting the context is easiest to forget. Composite FKs need no session state and
  cannot be bypassed.
- RLS is still added in Phase 1 on the highest-value tables (`journal_entries`, `journal_lines`,
  `invoices`, `vendor_bills`, `contacts`, `files`) as a second layer, consistent with doc 16
  positioning it as defence-in-depth.
- Gate B gains a specific structural test: attempt to insert a journal line whose account belongs to
  another entity, and assert the database rejects it.
- `intercompany_transactions` is the one legitimate cross-**entity** table. Both entity references
  are constrained to the same `tenant_id`; crossing entities within a tenant is the point.
