# 01 — Schema Findings

[schema_blueprint.sql](../project%20plan/schema_blueprint.sql) audited table by table against the
module specification that owns it. 74 tables; every one carries a verdict in
[§8](#8-table-by-table-verdict).

The blueprint's header is honest about its status: *"This is an implementation starting blueprint,
not the final migration set."* This audit takes it at its word and identifies what must change
**before** it becomes migration 0001 — with priority on the ledger core, because Phase 2 builds
directly on it and Gate C tests it.

Severity: **S1** blocks correctness · **S2** blocks a gate · **S3** contract debt · **S4** noted.

---

## 1. Ledger core — the highest-stakes findings

### F-001 — S1 — `journal_lines` forbids zero-value lines

`schema_blueprint.sql:311`
```sql
CHECK (base_debit > 0 OR base_credit > 0)
```

Combined with `CHECK (base_debit >= 0 AND base_credit >= 0)` and the mutual-exclusion checks, this
means **every posted line must carry a strictly positive base amount.** Legitimate cases it rejects:

- **Zero-cost inventory issues.** Doc 08 supports free samples, promotional stock and zero-value
  returns; `INVENTORY_ISSUE_FOR_SALE` posts Dr COGS / Cr Inventory at valuation cost, which can be 0.
- **Fully-discounted invoice lines.** Doc 04 supports line and document discounts; a 100% discount
  produces a zero net line that still needs its revenue account and dimensions recorded for reporting.
- **Foreign-currency lines that round to zero in base.** A line with a non-zero `transaction_debit`
  whose base equivalent rounds below the base currency's minor unit. The line is real; its base
  contribution is nil.
- **Memo and statistical lines** that doc 03 permits on manual journals.

The failure mode is bad: the posting service builds a correct, balanced journal and the database
rejects the whole transaction on one zero line. The natural workaround — dropping zero lines —
silently discards dimension and account detail that reporting needs.

**Resolution.** Drop the check. Retain the two mutual-exclusion checks (a line may not hold both a
debit and a credit) and the non-negativity checks. Enforce "a journal must have at least one non-zero
line" at the journal level in the posting service, where it belongs. Add a golden fixture for the
zero-cost issue and the 100%-discount invoice.

### F-002 — S1 — `journal_lines` lacks entity, book, period and posting date

`journal_lines` carries `tenant_id` but **not** `legal_entity_id`, `accounting_book_id`,
`accounting_period_id` or `posting_date`. All four live only on `journal_entries`.

Consequences:

1. **Every ledger read joins.** Trial Balance, General Ledger, P&L, Balance Sheet, account activity
   and every subledger reconciliation filter by entity + book + period and aggregate over lines. All
   of them must join `journal_entries` to do it. Gate H tests "Trial Balance and P&L over
   production-scale journal lines" — this join is on the hot path of the platform's most-run query.
2. **Partitioning is foreclosed.** Blueprint note 6 contemplates partitioning `journal_lines` by
   tenant or date. The partition key must be a column *on the table*; `posting_date` is not.
3. **The tenant column is inconsistent.** If `tenant_id` is denormalised onto lines for scoping, the
   same argument applies with more force to entity and book, which are the actual accounting
   isolation boundaries.
4. **Retrofitting is expensive.** Adding four columns and backfilling them on a table that Gate H
   deliberately grows to production scale is a maintenance-window migration.

**Resolution.** Denormalise `legal_entity_id`, `accounting_book_id`, `accounting_period_id` and
`posting_date` onto `journal_lines` **now**, before migration 0001. The posting service is the only
writer, so it can populate them atomically; immutability (F-004) prevents subsequent divergence. Add
a covering index on `(accounting_book_id, accounting_period_id, account_id)`. See
[D-03](07_Open_Decisions.md).

### F-003 — S1 — Nothing prevents a journal line from pointing at another entity's account

Blueprint note 2 concedes: *"Add tenant/legal-entity consistency checks using composite FKs or
trusted domain constraints."* Today there are none. `journal_lines.account_id` references
`accounts(id)` with no guarantee the account belongs to the same legal entity or book as the parent
`journal_entries` row. The same hole exists on `invoice_lines.revenue_account_id`,
`vendor_bill_lines.destination_account_id`, `tax_codes.payable_account_id`,
`asset_categories.*_account_id`, `items.*_account_id`, `bank_accounts.account_id`,
`budget_lines.account_id` and every `contact_id` reference.

An application bug — a stale cached account list, a mis-scoped lookup, a copy-paste in a posting rule
— posts entity A's transaction to entity B's ledger. The result balances, so no invariant catches it;
it surfaces as an unexplainable control-account difference weeks later, in a period that may be
closed.

Gate B requires "cross-tenant object ID probes return no data". Gate C requires ledger integrity.
Neither is achievable while referential integrity permits cross-entity references.

**Resolution.** Composite foreign keys. Add composite unique keys on parents
(`accounts (id, legal_entity_id, accounting_book_id)`, `contacts (id, organization_id)`, etc.) and
reference them from children using the columns already present after F-002. This makes the invariant
structural rather than aspirational, at the cost of wider FK indexes. Evaluate PostgreSQL RLS as an
**additional** layer only — doc 16 already positions it as defence-in-depth, not primary. See
[D-02](07_Open_Decisions.md).

### F-004 — S1 — No posted-journal immutability mechanism exists

Blueprint note 4 defers it: *"Revoke UPDATE/DELETE on posted journal facts from application runtime
roles and/or add immutable triggers…"*. Doc 01 states posted lines are the source of truth and
"Posted rows are immutable under normal application DB credentials". Doc 03 requires database
privileges and/or triggers as "a second safety layer beyond application code".

Gate C is explicit and binary: *"Posted journal application role cannot UPDATE/DELETE protected
accounting facts."* Phase 2's exit criterion repeats it. **This is the single most-tested property in
the whole specification and the schema does not implement it.**

**Resolution.** Ship it in migration 0001, not later:
1. A `BEFORE UPDATE OR DELETE` trigger on `journal_entries` rejecting any change once
   `status = 'POSTED'`, except the narrow allowed transition to `REVERSED` (which sets only
   `status`); and an unconditional reject on `journal_lines` and `journal_line_dimensions` whose
   parent is posted.
2. `REVOKE UPDATE, DELETE ON journal_lines, journal_line_dimensions FROM <app_role>` with the posting
   path running as a `SECURITY DEFINER` function.

Both layers, because Gate C tests the role and doc 03 asks for the trigger.

### F-005 — S2 — Journal balance is enforced nowhere in the schema

Blueprint note 5 is correct that a `CHECK` cannot express an aggregate over child rows, and delegates
to "a controlled posting function/service plus tests". That is a reasonable primary design — but it
leaves the platform's foundational invariant (doc 01 rule 2, Gate C's first criterion) enforced only
by code the same commit could change.

PostgreSQL *can* express it: a `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` fires at commit,
after all lines are inserted, and can assert
`SUM(base_debit) = SUM(base_credit)` per posted entry.

**Resolution.** Add the deferred constraint trigger as a second layer behind the posting service.
Measure its cost under Gate H's high-volume posting test; if it proves material, keep it enabled in
CI and staging and make it a monitored assertion in production. Gate C's property test ("Property
tests cannot create an unbalanced POSTED journal") is far stronger when the database also refuses.

### F-006 — S2 — `journal_entries.currency` has undefined semantics

`journal_entries.currency char(3) NOT NULL` sits above lines that each carry both
`transaction_currency` and `base_currency`. The header's meaning is never specified.

If it is the transaction currency, it is wrong for legitimately mixed journals — a foreign-currency
receipt with a local bank fee, an FX remeasurement run touching several currencies, a consolidation
elimination. If it is the base currency, it duplicates `accounting_books.base_currency` and can drift
from it.

**Resolution.** Rename to `base_currency`, define it as "the book's base currency at posting time,
snapshotted", and add a check that every line's `base_currency` equals the header's. Mixed
transaction currencies within one entry then remain valid, which they must be.

### F-007 — S3 — Chart of accounts is book-scoped while its neighbours are entity-scoped

`accounts` is keyed `UNIQUE (accounting_book_id, code)` and carries `accounting_book_id NOT NULL`.
But `account_groups`, `dimensions` and `tax_codes` are keyed on `legal_entity_id`. So an account
belongs to a book, while the group it rolls up to belongs to an entity.

Two consequences. First, Phase 10 multi-book duplicates the **entire chart per book** — doc 11 wants
"book-specific journal adjustments" and "chart mapping", not a wholesale copy, and every
`account_id` reference in AR, AP, tax, inventory and assets would need to resolve per book. Second,
it is the mechanism behind F-019: `invoice_lines.revenue_account_id` points at a book-scoped account
while `invoices` has no `accounting_book_id`, so **the book is unresolvable from the invoice**.

**Resolution.** Make `accounts` entity-scoped (`UNIQUE (legal_entity_id, code)`) and introduce a
separate `account_book_settings` table for the genuinely book-specific attributes Phase 10 needs.
This restores a consistent grain and removes the chart duplication. Decide before Phase 2 — every
later module references `accounts`. See [D-04](07_Open_Decisions.md).

### F-008 — S2 — `journal_entries` has no `branch_id`

Doc 02 models branches as an operational unit with user scoping and optional sequence overrides;
doc 03 lists Branch among the standard dimensions. But branch is reachable only via
`journal_line_dimensions` — which requires a `dimensions` row named "Branch" to have been configured,
per entity, by the customer.

Branch-scoped users (doc 02: "Role assignment is scoped to organization/entity/branch") therefore have
no reliable server-side filter on ledger data. Gate B requires "Entity scope is enforced server-side";
branch scope has the same requirement and no mechanism.

**Resolution.** Add `branch_id` to `journal_entries` (nullable) and to the source document tables.
Keep Branch available as a dimension for analysis, but make the scoping column first-class.

### F-009 — S3 — Three incompatible representations of dimensions coexist

- `journal_line_dimensions` — a proper join table with FKs to `dimensions` and `dimension_values`.
- `invoice_lines.dimensions jsonb`, `vendor_bill_lines.dimensions jsonb`, `budget_lines.dimensions
  jsonb`, `fixed_assets.dimensions jsonb` — untyped JSON.
- `projects`, `warehouses.branch_id` — dedicated columns.

The JSON forms have no referential integrity, cannot enforce doc 03's per-account dimension rules
(REQUIRED / OPTIONAL / PROHIBITED / DEFAULTED), and cannot be indexed for the dimensional reporting
doc 12 requires without bespoke GIN indexes and query paths.

**Resolution.** One representation: a polymorphic `document_line_dimensions` table mirroring
`journal_line_dimensions`. Validate against the dimension rules at document save, not at posting —
a draft invoice with a missing required dimension should fail early, and doc 12's "Reporting by
dimensions" needs indexable source-document dimensions too, not just ledger ones.

### F-010 — S2 — Overlapping posting rule versions can both be effective

`posting_rule_versions` is `UNIQUE (accounting_book_id, event_type, version)` with `valid_from` /
`valid_to`. Nothing prevents two versions of the same `event_type` having overlapping validity. Rule
resolution (doc 03 step 5) would then be non-deterministic — and doc 01 rule 7 makes versioned,
effective-dated posting rules non-negotiable.

The same hole exists in `tax_rates` (F-025), `approval_workflows`, `consolidation_account_mappings`
and `consolidation_group_entities`.

**Resolution.** `EXCLUDE USING gist (accounting_book_id WITH =, event_type WITH =,
tstzrange(valid_from, valid_to) WITH &&)` — requires `btree_gist`. Apply the same pattern to all five
effective-dated tables. This turns "rules are versioned and effective-dated" from prose into a
constraint.

---

## 2. Tenancy, setup and IAM

### F-011 — S2 — Periods can overlap, and adjustment periods are unmodelled

Doc 02: *"Create monthly standard periods and optional adjustment periods. Validate no overlap."*
`accounting_periods` is `UNIQUE (legal_entity_id, fiscal_year_id, period_no)` — which prevents
duplicate numbers, not overlapping dates — and has no adjustment-period flag.

Period resolution from `posting_date` (doc 01: "posting_date determines accounting period") is
ambiguous the moment an adjustment period shares a date range with period 12, which is exactly what
adjustment periods are for.

**Resolution.** Add `is_adjustment boolean NOT NULL DEFAULT false`. Add an `EXCLUDE` constraint
preventing overlap **among non-adjustment periods only**. Specify resolution explicitly: posting
resolves to the regular period unless the caller names an adjustment period and holds the permission.
The same `EXCLUDE` treatment applies to `fiscal_years` (F-015).

### F-012 — S2 — Number sequences cannot express their specified scope options

Doc 02: *"Sequence scope options: legal entity, branch, document type, fiscal year."*
`number_sequences` is `UNIQUE (legal_entity_id, scope)` with `scope text` — every dimension beyond
entity has to be string-encoded into `scope`, so branch and fiscal-year resets become a naming
convention rather than a model. `reset_rule text` is likewise unconstrained.

More seriously, **the allocation protocol is undefined.** `next_number bigint` plus a `version`
column suggests optimistic concurrency, but doc 02 demands "Concurrency-safe" and "Never reuse
posted/voided numbers", and Gate G tests "duplicate number allocation" under concurrency. Optimistic
retry under contention on a hot invoice sequence is the wrong tool.

**Resolution.** Model the scope: nullable `branch_id`, `document_type`, `fiscal_year_id` columns with
a unique index over the populated set. Allocate via `SELECT … FOR UPDATE` on the sequence row inside
the posting transaction (a gapless sequence is a business requirement here — PostgreSQL sequences are
gap-tolerant and therefore unsuitable). Document that this serialises concurrent posting per sequence
and size sequences accordingly. See [D-05](07_Open_Decisions.md).

### F-013 — S3 — Nothing enforces exactly one primary accounting book per entity

`accounting_books.is_primary boolean NOT NULL DEFAULT false`. Doc 21 Phase 1 requires an
"Accounting book record and default primary book"; posting rule resolution assumes one.

**Resolution.** `CREATE UNIQUE INDEX ON accounting_books (legal_entity_id) WHERE is_primary`.

### F-014 — S3 — Two currency fields with an undefined relationship

`legal_entities.functional_currency` and `accounting_books.base_currency` both exist. Doc 01 requires
storing "transaction amount/currency and base amount/currency"; doc 11 distinguishes transaction,
functional/base and reporting currency. Which of the two governs `journal_lines.base_currency` is
never stated.

**Resolution.** Define `accounting_books.base_currency` as authoritative for posting (it is the
ledger's currency, and Phase 10 multi-book may legitimately differ per book). Keep
`legal_entities.functional_currency` as the statutory default that seeds the primary book, and add a
check that the primary book matches it.

### F-015 — S3 — `fiscal_years` permits overlapping years

`UNIQUE (legal_entity_id, start_date, end_date)` prevents exact duplicates only.
**Resolution:** `EXCLUDE` constraint over `daterange(start_date, end_date)`, per F-010.

### F-016 — S2 — Permissions are an untyped JSON array

`roles.permissions jsonb NOT NULL DEFAULT '[]'`. Doc 02 requires atomic permissions, names six
high-risk permissions needing distinct handling, and specifies `GET /permissions`. A JSON array gives
no referential integrity (a typo'd permission silently grants nothing), no way to answer "which roles
hold this permission", and no way to flag one high-risk. Gate B's "authorization tests cover every
mutation route" needs an enumerable registry to test against.

**Resolution.** Add a `permissions` registry table plus a `role_permissions` join, and generate the
registry from `contracts/openapi.yaml` (per [F-108](02_Contract_Drift.md), each route declares its
required permission) so the two cannot drift. Full argument in [F-207](03_Coverage_Gaps.md).

### F-017 — S3 — Nullable columns in UNIQUE keys defeat the constraint

PostgreSQL treats `NULL` as distinct in unique constraints, so any key containing a nullable column
silently permits duplicates. Affected:

| Table | Constraint | Nullable members |
|---|---|---|
| `memberships` | `UNIQUE (tenant_id, user_id, role_id, organization_id, legal_entity_id, branch_id)` | org, entity, branch |
| `approval_steps` | `UNIQUE (approval_request_id, step_no, approver_user_id, approver_role_id)` | both approver columns |
| `integrations` | `UNIQUE (tenant_id, legal_entity_id, provider, integration_type, external_account_id)` | entity, external id |
| `exchange_rates` | see F-036 — same defect, worse blast radius |

A tenant-wide membership (all three scope columns NULL) can be inserted unboundedly.

**Resolution.** `UNIQUE NULLS NOT DISTINCT` (PostgreSQL 15+) on each, or partial unique indexes per
null-pattern. Pin the minimum PostgreSQL version accordingly — see [D-10](07_Open_Decisions.md).

### F-018 — S2 — `users.email` is globally unique across all tenants

`email citext NOT NULL UNIQUE`. One person cannot hold accounts in two tenants under the same
address. This directly conflicts with Phase 9's accountant portal — doc 09/doc 21 require "Multi-client
accountant dashboard" and "Permission switching without cross-client leakage", which presumes one
identity spanning tenants. It also blocks the common case of a bookkeeper serving two customers.

The schema does support one user having memberships in many tenants (`memberships.tenant_id`), so the
intent appears to be a global identity — but then the global-unique email is correct and the *real*
problem is that nothing else is tenant-scoped about `users`. Either reading needs a decision.

**Resolution.** Keep users global (it supports the accountant portal) and confirm it explicitly:
document that `users` is a platform-level table, that tenant membership is the only scoping
mechanism, and that authentication is therefore cross-tenant with per-tenant authorization. Then add
the Gate B test that proves a user with memberships in tenants A and B cannot read B's data while
acting in A. See [D-06](07_Open_Decisions.md).

### F-019 — S1 — `invoices` cannot determine its own accounting period or book

`invoices` has `issue_date` and `due_date`. It has **no** `posting_date`, no `document_date`, no
`accounting_book_id`, no `branch_id`.

Doc 01: *"Financial documents use `document_date`, `posting_date`, `due_date` where relevant.
`posting_date` determines accounting period."* Doc 04 lists both dates as invoice fields.

So: the period an invoice posts to cannot be derived from the invoice. Worse,
`invoice_lines.revenue_account_id` references a **book-scoped** account (F-007) while the invoice
does not know its book — the reference is unresolvable without an out-of-band assumption that the
entity has exactly one book, which Phase 10 breaks by design.

`vendor_bills` has the same shape (`bill_date`, `due_date`, no posting date or book).

**Resolution.** Add `document_date`, `posting_date`, `accounting_book_id`, `branch_id` to `invoices`
and `vendor_bills`, and to every other posting source document. Make `posting_date` the sole input to
period resolution across all modules.

### F-020 — S1 — The duplicate-bill override workflow is impossible to execute

`vendor_bills UNIQUE (legal_entity_id, vendor_id, vendor_invoice_number)`.

Doc 05 specifies duplicate **detection** across four signals (exact number, normalised number,
same vendor/date/amount, file hash) and then states: *"Override requires permission and reason."*
A hard unique constraint makes override impossible — the insert fails at the database regardless of
permission.

The cases are real: vendors reissue numbers across years; some vendors number per-branch; credit and
debit documents occasionally share a reference.

**Resolution.** Drop the constraint. Implement detection as a service-layer check that returns a
`DUPLICATE_SUSPECTED` error with the matching bill IDs, overridable by a permission with a recorded
reason and an audit event. Add a **partial** unique index that still blocks the truly
unambiguous case (same vendor, same number, same amount, same date, no override flag) so accidental
double-entry is still caught by the database.

### F-021 — S1 — Nothing prevents over-allocation of a payment

`payment_allocations` has `UNIQUE (payment_id, target_type, target_id)` and
`CHECK (amount > 0)`. There is **no** constraint that `SUM(amount) <= payments.amount`, and none
that allocations against an invoice do not exceed its balance.

Gate G tests exactly this: *"two receipts allocated to last invoice balance"* and *"two vendor
payments on same bill"*, expecting "no duplicate posting … or inconsistent subledger state". Doc 04
requires that "concurrent allocation cannot overpay an invoice or consume the same available receipt
twice".

Two concurrent transactions each read `invoices.amount_due = 100`, each allocate 100, each commit.
Nothing in the schema notices.

**Resolution.** Three layers:
1. `SELECT … FOR UPDATE` on both the payment row and the target document row before allocating,
   inside the allocation transaction.
2. Persist `amount_paid` / `amount_due` on the target and update them in the same transaction, with
   `CHECK (amount_paid <= total)` and `CHECK (amount_due >= 0)`.
3. A deferred constraint trigger asserting
   `SUM(payment_allocations.amount) <= payments.amount` per payment at commit.

The `UNIQUE (payment_id, target_type, target_id)` constraint also forbids two partial allocations
from one payment to one invoice at different times, which doc 04's partial-allocation flow may
legitimately need — replace with a surrogate key and rely on the sum constraint. See
[D-07](07_Open_Decisions.md).

### F-022 — S2 — `payments` is too thin for foreign-currency settlement

One table serves customer receipts and vendor payments via `payment_type text`. It has `currency` and
`amount` but **no** `exchange_rate`, no base amount, and no realized-FX fields.

Doc 11 requires: *"invoice creates AR at original base value; receipt settles AR at original carrying
value; bank is posted at current translated value; difference posts to realized FX gain/loss"*, with
partial settlements "each retaining remaining foreign amount and carrying base amount". Phase 7's
exit criterion and the `REALIZED_FX_ON_SETTLEMENT` posting rule both depend on this.

None of the inputs are storable. Realized FX cannot be computed, let alone reproduced for audit.

**Resolution.** Add `exchange_rate`, `exchange_rate_date`, `exchange_rate_source`, `base_amount` to
payments, and `allocated_base_amount` + `realized_fx_amount` to `payment_allocations` — FX is realized
per allocation, not per payment, because one receipt may settle invoices booked at different rates.
See also F-206 in the coverage audit on splitting the table.

### F-023 — S2 — `ON DELETE CASCADE` on posted document lines

`invoice_lines` and `vendor_bill_lines` both declare `ON DELETE CASCADE` on their parent. Doc 01 is
categorical: *"No destructive cascade may delete posted history."* The ledger tables correctly use
`ON DELETE RESTRICT`; the source documents do not.

**Resolution.** Change both to `ON DELETE RESTRICT`. Deleting a draft becomes an explicit two-step
service operation; deleting a posted document remains impossible, which is the intent.

### F-024 — S3 — `tax_transactions` is not book-aware and links backwards

No `accounting_book_id`, and the only tie to the ledger is `journal_lines.tax_transaction_id` —
pointing from the ledger to the tax subledger. Gate D requires "Tax detail = tax control accounts"
per book; doc 07 requires return-to-GL reconciliation.

**Resolution.** Add `accounting_book_id` and `journal_entry_id`. Keep the reverse link for line-level
attribution.

### F-025 — S3 — `tax_rates` has no unique or overlap constraint

No constraint at all. Duplicate or overlapping `(tax_code_id, component_name, valid_from)` rows are
insertable, making rate resolution non-deterministic — the same class of defect as F-010, on the table
where it produces wrong tax on customer invoices.

**Resolution.** `EXCLUDE` over `(tax_code_id, component_name, daterange(valid_from, valid_to))`.

### F-026 — S3 — Contacts are organization-scoped with no sharing policy

`contacts.organization_id` — every entity in an organization implicitly shares every customer and
vendor. Doc 11 specifies "Shared master-data policy options" as a configurable choice; the schema
hardcodes one option.

**Resolution.** Acceptable for the first release. Add `legal_entity_id` (nullable = shared) so the
policy becomes expressible later without a data migration.

### F-027 — S3 — Denormalised balances have no supporting constraints

`invoices.amount_paid` / `amount_due` and `vendor_bills.amount_paid` / `amount_due` are stored with
no checks tying them to `total` or to `payment_allocations`.

**Resolution.** Add `CHECK (amount_due = total - amount_paid)`, `CHECK (amount_paid >= 0)`,
`CHECK (amount_paid <= total)`. Reconcile against allocations in the Gate D suite.

---

## 3. Banking

### F-028 — S1 — Bank deduplication implements only the fallback, not the primary key

Doc 06: *"Primary key: provider transaction ID per connection/account. Fallback fingerprint uses
account + date/value date + amount + normalized reference/description + source-file context."*

The schema has `UNIQUE (bank_account_id, fingerprint)` and leaves `provider_transaction_id` entirely
unconstrained. So the weaker heuristic is enforced and the strong identifier is not.

This inverts the intended behaviour in both directions. Two genuinely distinct transactions with
identical amount, date and description — two identical £20 card payments to the same merchant on the
same day, which is ordinary — collide on fingerprint and one is **silently rejected**. Meanwhile a
re-import carrying the same `provider_transaction_id` with a normalised description is **accepted as
new**. Phase 4's exit criterion ("Same imported/feed transaction cannot create a duplicate canonical
transaction") fails in the second case; real data is lost in the first.

**Resolution.**
```sql
CREATE UNIQUE INDEX ON bank_transactions (bank_account_id, provider_transaction_id)
  WHERE provider_transaction_id IS NOT NULL;
```
and make `fingerprint` a non-unique index used by a service-layer *suspected-duplicate* check that
surfaces a review item rather than rejecting the row. Add an `import_sequence` column so
legitimately identical same-day transactions are distinguishable.

### F-029 — S2 — `bank_matches` has no integrity constraints

No unique constraint, no FK to `bank_reconciliations`, no check that `matched_amount` is positive or
that matches against one transaction sum to its amount. Doc 06 requires split transaction handling —
so partial matches are expected — but nothing bounds them.

**Resolution.** Add `reconciliation_session_id`, `CHECK (matched_amount <> 0)`, a partial unique index
on `(bank_transaction_id, target_type, target_id)` for confirmed matches, and a deferred trigger
asserting the sum of confirmed matches does not exceed the transaction amount.

### F-030 — S2 — Completed reconciliations are not locked

`bank_reconciliations.status text NOT NULL DEFAULT 'IN_PROGRESS'` — free text, no enum, and nothing
prevents mutation after `completed_at` is set. Doc 06: *"Finalized session is locked; correction uses
reopen permission."* Gate F requires locked periods to reject posting; the same reasoning applies
here.

**Resolution.** Enum the status, add a trigger rejecting updates once `COMPLETED` except a permissioned
reopen that writes an audit event, and add `CHECK (difference = 0)` gating the transition to
`COMPLETED` (with a configurable tolerance from the accounting policy).

---

## 4. Inventory and fixed assets

### F-031 — S2 — Serial numbers are not unique and quantity direction is implicit

`inventory_movements.serial_number text` with no constraint. Doc 08: *"Prevent duplicate active
serial ownership."* Nothing does.

`quantity numeric(24,8) NOT NULL` with no check — direction is encoded in the sign by convention,
undocumented, and combined with nullable `from_location_id` / `to_location_id` there is no structural
guarantee that a receipt has a destination and an issue has a source.

**Resolution.** Add a `serial_units` table with a partial unique index on active ownership. Add
`CHECK (quantity <> 0)` and a check tying `movement_type` to the required location columns. Document
the sign convention in the migration.

### F-032 — S2 — Cost layers can go negative and have no concurrency protocol

`inventory_cost_layers.remaining_quantity` has no `CHECK (>= 0)`. Doc 08 defaults to blocking
negative stock; Phase 5's exit criterion requires "Negative stock behavior follows configured policy
**under concurrent sales/issues**"; Gate G tests "two stock issues consume last quantity/cost layer".

FIFO consumption reads open layers, decrements them, and writes the COGS amount. Two concurrent
issues will both read the same layer and both consume it.

**Resolution.** `CHECK (remaining_quantity >= 0)` — this alone converts a silent corruption into a
loud failure. Then `SELECT … FOR UPDATE` over the item's open layers ordered by `received_date`,
inside the issue transaction. Where policy permits negative stock, an explicit provisional layer with
a settlement flag, so the exception is visible rather than implicit.

### F-033 — S3 — Item accounting mappings cross a grain boundary

`items` is organization-scoped; `items.inventory_account_id`, `cogs_account_id`, `revenue_account_id`,
`purchase_account_id` all point at **book-scoped** `accounts`. An item shared across two entities
cannot have correct per-entity account mappings. The same defect affects `tax_codes` (entity-scoped →
book-scoped accounts) and `asset_categories`.

Resolving F-007 (accounts entity-scoped) reduces this to an entity-vs-organization mismatch, which
still needs handling.

**Resolution.** Move item account mappings into a per-entity `item_accounting_settings` table.

### F-034 — S3 — Depreciation idempotency is correct; partial disposal is not modelled

`depreciation_schedule_lines UNIQUE (asset_book_id, accounting_period_id)` — **this is right**, and it
satisfies Phase 5's "Depreciation rerun is idempotent for same asset/book/period" structurally.
Noted as a positive.

Partial and component disposal are absent; doc 09 explicitly defers them ("Support partial
disposal/component disposal later"). **S4, no action.**

`status text` should be an enum, and there is no `DisposalRecord`, `AssetTransaction`,
`DepreciationRun` or custodian/location assignment table (see
[03_Coverage_Gaps](03_Coverage_Gaps.md)).

### F-035 — S3 — `fixed_assets.dimensions jsonb`

Fourth instance of the F-009 pattern.

---

## 5. FX, intercompany, consolidation, close

### F-036 — S1 — Global exchange rates can be duplicated without limit

```sql
tenant_id uuid REFERENCES tenants(id),          -- nullable
UNIQUE (tenant_id, rate_date, from_currency, to_currency, rate_type, source)
```

`tenant_id` is nullable, evidently so platform-wide rates can be shared. But PostgreSQL treats NULLs
as distinct in unique constraints, so **every platform-global rate row is unconstrained** — a
provider sync that runs twice inserts two rows for the same date and pair.

Rate resolution then returns an arbitrary row. Doc 11: *"Never update historical rate row in place"* —
the schema honours that, but silently permits contradictory duplicates instead, which is worse:
re-running a report can produce different numbers with no visible cause.

**Resolution.** `UNIQUE NULLS NOT DISTINCT (…)` on PostgreSQL 15+, or two partial unique indexes
(one `WHERE tenant_id IS NULL`, one `WHERE tenant_id IS NOT NULL`). Combine with the F-010 overlap
treatment for rate validity.

### F-037 — S2 — Only one FX remeasurement run per period is possible, ever

`fx_remeasurement_runs UNIQUE (legal_entity_id, accounting_book_id, accounting_period_id)`.

Doc 11 requires "Produce preview per account/currency/open item" and Phase 7's exit criterion is
*"Period-end remeasurement is reversible/repeatable without duplication"*. A single-row constraint
makes preview-then-post, correct-and-rerun, and reverse-and-redo all impossible. The intent —
preventing double-posting — is right; the mechanism is too blunt.

**Resolution.** Add `version integer` and `status`, move the uniqueness to a partial index over
*posted* runs only:
```sql
CREATE UNIQUE INDEX ON fx_remeasurement_runs (legal_entity_id, accounting_book_id, accounting_period_id)
  WHERE status = 'POSTED';
```
Drafts and previews then coexist freely, and exactly one posts. `close_runs` carries the identical
defect (F-038) and takes the identical fix.

### F-038 — S2 — Only one close run per period is possible, ever

`close_runs UNIQUE (legal_entity_id, accounting_book_id, accounting_period_id)`. Doc 12 requires a
reopen workflow ("Reopen workflow with privileged approval/audit") and Gate F requires reopen to be
tested. After reopening, a second close cannot be recorded.

**Resolution.** As F-037: version the run, make uniqueness partial over the completed state.

### F-039 — S3 — Consolidation maps to a group chart that does not exist

`consolidation_account_mappings.group_account_code text` — a free string with no group chart table
behind it. Doc 11 requires "Missing required mapping blocks final consolidation and appears in
exception report", which needs an enumerable target set to detect missing entries.

**Resolution.** Add a `group_accounts` table keyed to `consolidation_groups` and make the mapping an
FK. Add the F-010 overlap constraint to both mapping tables and to
`consolidation_group_entities`.

### F-040 — S3 — Intercompany pairs are not tenant-checked

`intercompany_transactions.source_entity_id` and `counterparty_entity_id` both reference
`legal_entities` with no guarantee they share the `tenant_id` on the same row. Phase 7's exit
criterion requires reconciliation "without cross-tenant/entity leakage". Covered structurally by the
F-003 composite-FK fix.

---

## 6. Platform infrastructure

### F-041 — S1 — `outbox_events` cannot carry the required event envelope

`tenant_id` only; the envelope requires `organization_id` and `legal_entity_id`. Full argument in
[F-103](02_Contract_Drift.md).

**Resolution.** Add both as indexed columns. Also add `event_id uuid UNIQUE` — the envelope requires
"event_id is globally unique" and the table's surrogate `id` is not the same thing once replay and
webhook delivery both reference it.

### F-042 — S2 — No consumer checkpoint mechanism

Doc 01: *"Consumers are idempotent and record checkpoints/event IDs."* No table exists. Phase 0's exit
criteria include atomic write-plus-outbox and idempotent retry; doc 16 requires an "outbox unpublished
age" metric.

**Resolution.** Add `outbox_consumer_checkpoints (consumer, last_event_id, updated_at)` and a
`processed_events (consumer, event_id)` dedupe table. Both are Phase 0 deliverables.

### F-043 — S2 — The audit log is not immutable

Doc 16: *"Audit log: immutable business/security history."* `audit_events` has no trigger, no
privilege restriction, and no hash chain. Gate B requires audit of sensitive changes; an audit trail
the application can rewrite does not satisfy an auditor.

**Resolution.** `REVOKE UPDATE, DELETE` from the application role plus a rejecting trigger, mirroring
F-004. Consider a per-tenant hash chain (`prev_hash`, `row_hash`) for the Phase 6 audit workspace and
doc 12's "Exportable audit trail" — cheap to add now, impossible to backfill.

### F-044 — S3 — Idempotency protocol is unspecified

`idempotency_keys` has `locked_until` and `expires_at`, implying a lease protocol that is never
described. No index on `expires_at` for reaping. `request_hash` exists but the required behaviour on
mismatch (same key, different payload → 409) is not stated.

**Resolution.** Specify the protocol in an ADR — insert-or-lock, in-flight → 409 `IN_PROGRESS`,
completed → replay stored response, hash mismatch → 422. Add the reaping index. Phase 0 deliverable
per doc 21.

### F-045 — S3 — No `sessions` table

Doc 02 requires "Session list/revocation"; doc 16 requires "Session/device management and revocation"
and reauthentication for high-risk actions; Gate B requires MFA/session policy enforcement and the
F-102 event `user.suspended` must revoke live sessions. Stateless JWTs alone cannot satisfy
revocation.

**Resolution.** Add `sessions` (user, tenant, device, issued/expires, revoked_at, ip, user_agent) in
Phase 1.

### F-046 — S3 — Webhook delivery history is overwritten

`webhook_deliveries UNIQUE (webhook_endpoint_id, outbox_event_id)` with a scalar `attempt integer`.
Doc 15 requires retry with backoff, dead-lettering after a limit, and manual replay — all of which
want per-attempt rows. One row per (endpoint, event) means each retry overwrites the previous
response.

**Resolution.** Keep the delivery row as the aggregate and add `webhook_delivery_attempts` as the
history.

### F-047 — S3 — `webhook_endpoints.subscribed_events` is unvalidated

`text[]` with no reference to the event catalog. A typo subscribes to nothing, silently.
**Resolution.** Validate against `contracts/events.yaml` at write time; seed an `event_types`
reference table from the same source.

### F-048 — S3 — Tenant-scoped object keys are not enforced

Doc 16 requires "S3 signed URLs/tenant-scoped object keys". `files.storage_key text UNIQUE` is global
with no structural relationship to `tenant_id`.

**Resolution.** `CHECK (storage_key LIKE tenant_id::text || '/%')`. Cheap, and it makes a
cross-tenant key impossible rather than merely discouraged.

### F-049 — S3 — Status is an enum on 12 tables and free text on 21

`record_status`, `document_status`, `journal_status`, `period_status` and `approval_status` are proper
enums. Then `status text` appears on `fixed_assets`, `asset_books`, `depreciation_schedule_lines`,
`projects`, `budgets`, `bank_matches`, `bank_reconciliations`, `inventory_cost_layers`,
`fx_remeasurement_runs`, `intercompany_transactions`, `consolidation_runs`, `close_runs`,
`close_tasks`, `integrations`, `sync_jobs`, `webhook_deliveries`, `migration_jobs`, `ai_decisions`,
`anomalies`, `files.scan_status` and `bank_transactions.reconciliation_status`.

Free-text status columns are how state machines rot: a typo creates a state no code handles, and
doc 21's Definition of Done item 3 ("State machine/status transitions where applicable") becomes
unverifiable.

**Resolution.** Enum every one, per its documented state machine. Where a state set is genuinely
open-ended, use a lookup table with an FK — not free text.

### F-050 — S3 — Polymorphic references have no integrity strategy

`(source_type, source_id)` on `journal_entries`, `inventory_documents`, `inventory_movements`,
`fixed_assets`; `(target_type, target_id)` on `payment_allocations`, `bank_matches`;
`(resource_type, resource_id)` on `audit_events`, `approval_requests`, `file_links`, `ai_decisions`,
`anomalies`. None can be a foreign key.

**Resolution.** Accept the pattern — the alternatives are worse — but constrain it: enum the `*_type`
columns, add a nightly orphan-detection job reporting into the Gate D reconciliation suite, and
require the owning service to validate existence on write. Record as an explicit decision, not an
accident.

### F-051 — S3 — Numeric precision varies and rounding boundaries are undefined

Money is `numeric(24,8)`; rates `numeric(28,12)`; tax rates `numeric(18,10)`; recoverable and
ownership percentages `numeric(9,6)`; confidence `numeric(8,6)`; close readiness `numeric(7,4)`.

The storage precision is defensible. The gap is doc 01's *"Rounding occurs at defined calculation
boundaries"* — **the boundaries are never defined.** Nor is per-currency presentation precision
(`Currency` has no table, per [03_Coverage_Gaps](03_Coverage_Gaps.md)), nor cash-rounding behaviour,
despite doc 01 requiring "Currency metadata defines precision and cash-rounding behavior".

Every golden fixture in Gate C encodes a rounding decision. Leaving them undefined means the fixtures
define the behaviour by accident, and each new module rediscovers it differently.

**Resolution.** Write the rounding specification **before** the first golden fixture: a `currencies`
table with `minor_unit` and `cash_rounding`; an explicit ordered list of rounding boundaries (line
net → line tax → document tax total → base conversion → journal line); half-up as the documented
default with per-tax-component override; and the `ROUNDING_ADJUSTMENT` posting rule wired to the
accounting policy's rounding account. See [D-08](07_Open_Decisions.md).

---

## 7. What the blueprint gets right

Recording these so the audit is not read as a rejection. These are good decisions worth preserving:

- **`journal_entries_source_event_uq`** — a partial unique index on
  `(legal_entity_id, accounting_book_id, source_event_id)`. This is the structural guarantee behind
  "Duplicate accounting event cannot double-post" (Phase 2 exit criterion, Gate C). Correctly scoped,
  correctly partial.
- **`journal_lines` mutual exclusion** — `CHECK (NOT (transaction_debit > 0 AND transaction_credit > 0))`
  and the base equivalent. Directly implements doc 03's "Validate each line has debit XOR credit".
- **`ON DELETE RESTRICT` on `journal_lines` and `journal_line_dimensions`** — posted history cannot be
  cascade-deleted. (Undermined by F-023 on the source documents, but right where it matters most.)
- **`depreciation_schedule_lines UNIQUE (asset_book_id, accounting_period_id)`** — depreciation
  idempotency enforced structurally rather than by convention.
- **`outbox_unpublished_idx`** — a partial index on `WHERE published_at IS NULL`, which is exactly the
  right shape for a drain query and directly supports doc 16's "outbox unpublished age" metric.
- **Dual amount storage** — `transaction_*` and `base_*` on every line, with rate, rate date and rate
  source. Multi-currency is designed in from the start rather than retrofitted.
- **`numeric` throughout, no float anywhere.** Doc 01's acceptance criterion "Money schema contains no
  float/double columns" passes as written.
- **`rule_snapshot jsonb NOT NULL` on `tax_transactions`** — the tax calculation is frozen at
  transaction time, which is what makes doc 07's "Historical posted transaction retains same tax
  snapshot after rule upgrade" achievable.
- **Blueprint notes 1–7** — the author documented what was deferred and why. Notes 5 and 6 in
  particular show real judgement: no premature partitioning, and an honest statement that a `CHECK`
  cannot express the balance invariant.

---

## 8. Table-by-table verdict

All 74 tables. "Conforms" means no finding against the owning module spec at this stage.

| # | Table | Owning doc | Verdict |
|---:|---|---|---|
| 1 | `tenants` | 02 | Conforms |
| 2 | `organizations` | 02 | Conforms |
| 3 | `legal_entities` | 02 | F-014 |
| 4 | `branches` | 02 | Conforms (F-003 tenant consistency) |
| 5 | `users` | 02 | **F-018**, F-045 |
| 6 | `roles` | 02 | **F-016** |
| 7 | `memberships` | 02 | F-017 |
| 8 | `fiscal_years` | 02 | F-015 |
| 9 | `accounting_periods` | 02 | **F-011** |
| 10 | `accounting_books` | 02 | F-013, F-014 |
| 11 | `number_sequences` | 02 | **F-012** |
| 12 | `account_groups` | 03 | F-007 (grain); no unique on `code` |
| 13 | `accounts` | 03 | **F-007** |
| 14 | `dimensions` | 03 | Conforms |
| 15 | `dimension_values` | 03 | Conforms |
| 16 | `journals` | 03 | Conforms |
| 17 | `posting_rule_versions` | 03 | **F-010** |
| 18 | `journal_entries` | 03 | **F-004**, **F-006**, **F-008** |
| 19 | `journal_lines` | 03 | **F-001**, **F-002**, **F-003**, F-005 |
| 20 | `journal_line_dimensions` | 03 | Conforms — reference implementation for F-009 |
| 21 | `contacts` | 02 | F-026 |
| 22 | `tax_codes` | 07 | F-033 (grain) |
| 23 | `tax_rates` | 07 | **F-025** |
| 24 | `tax_transactions` | 07 | F-024 |
| 25 | `invoices` | 04 | **F-019**, F-027 |
| 26 | `invoice_lines` | 04 | **F-023**, F-009 |
| 27 | `vendor_bills` | 05 | **F-020**, F-019, F-027 |
| 28 | `vendor_bill_lines` | 05 | **F-023**, F-009 |
| 29 | `payments` | 04, 05 | **F-022**, F-206 |
| 30 | `payment_allocations` | 04, 05 | **F-021** |
| 31 | `bank_accounts` | 06 | Conforms |
| 32 | `bank_transactions` | 06 | **F-028** |
| 33 | `bank_matches` | 06 | **F-029** |
| 34 | `bank_reconciliations` | 06 | **F-030** |
| 35 | `approval_workflows` | 14 | F-010 (overlap) |
| 36 | `approval_requests` | 14 | Conforms |
| 37 | `approval_steps` | 14 | F-017 |
| 38 | `files` | 13 | F-048 |
| 39 | `file_links` | 13 | F-050 |
| 40 | `audit_events` | 16 | **F-043**, F-050 |
| 41 | `outbox_events` | 01 | **F-041**, F-042 |
| 42 | `idempotency_keys` | 01 | F-044 |
| 43 | `items` | 08 | **F-033** |
| 44 | `warehouses` | 08 | Conforms |
| 45 | `warehouse_locations` | 08 | Conforms |
| 46 | `inventory_documents` | 08 | F-206 (generic), F-049 |
| 47 | `inventory_movements` | 08 | **F-031**, F-050 |
| 48 | `inventory_cost_layers` | 08 | **F-032**, F-049 |
| 49 | `asset_categories` | 09 | F-033 (grain) |
| 50 | `fixed_assets` | 09 | F-035, F-049, F-050 |
| 51 | `asset_books` | 09 | F-049 |
| 52 | `depreciation_schedule_lines` | 09 | Conforms — idempotency correct |
| 53 | `projects` | 10 | F-049 |
| 54 | `budgets` | 10 | F-049 |
| 55 | `budget_lines` | 10 | F-009 |
| 56 | `exchange_rates` | 11 | **F-036**, F-010 |
| 57 | `fx_remeasurement_runs` | 11 | **F-037** |
| 58 | `consolidation_groups` | 11 | Conforms |
| 59 | `consolidation_group_entities` | 11 | F-010 (overlap) |
| 60 | `consolidation_account_mappings` | 11 | **F-039**, F-010 |
| 61 | `intercompany_transactions` | 11 | F-040, F-049 |
| 62 | `consolidation_runs` | 11 | F-049 |
| 63 | `consolidation_adjustments` | 11 | Conforms |
| 64 | `close_runs` | 12 | **F-038** |
| 65 | `close_tasks` | 12 | F-049 |
| 66 | `financial_snapshots` | 12 | Conforms (needs report-definition FK — F-204) |
| 67 | `integrations` | 15 | F-017, F-049 |
| 68 | `sync_jobs` | 15 | F-049 |
| 69 | `webhook_endpoints` | 15 | **F-047** |
| 70 | `webhook_deliveries` | 15 | **F-046** |
| 71 | `migration_jobs` | 17 | F-049 |
| 72 | `ai_decisions` | 13 | F-206 (generic), F-049 |
| 73 | `anomalies` | 13 | F-049, F-050 |
| 74 | `automation_policies` | 13 | F-010 (versioning without overlap constraint) |

**Cross-cutting** (apply to many tables, counted once): F-003 tenant consistency, F-009 dimensions,
F-049 status typing, F-050 polymorphic references, F-051 precision and rounding.

---

## Summary — severity counts

| Severity | Count | IDs |
|---|---:|---|
| **S1** | 10 | F-001, F-002, F-003, F-004, F-019, F-020, F-021, F-028, F-036, F-041 |
| **S2** | 18 | F-005, F-006, F-008, F-010, F-011, F-012, F-016, F-018, F-022, F-023, F-029, F-030, F-031, F-032, F-037, F-038, F-042, F-043 |
| **S3** | 22 | F-007, F-009, F-013, F-014, F-015, F-017, F-024, F-025, F-026, F-027, F-033, F-035, F-039, F-040, F-044, F-045, F-046, F-047, F-048, F-049, F-050, F-051 |
| **S4** | 1 | F-034 (partial disposal, explicitly deferred by doc 09) |

**Ten S1 findings, of which six sit in the ledger core or its immediate source documents.** All ten
must be resolved in migration 0001 — every one of them is either impossible to retrofit
(F-002 denormalisation, F-004 immutability) or produces silently wrong accounting if built as written
(F-001, F-003, F-019, F-020, F-021, F-028, F-036, F-041).
