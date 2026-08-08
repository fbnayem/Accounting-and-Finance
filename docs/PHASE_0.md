# Phase 0 — Repository, Platform Foundation and Engineering Standards

**Status:** complete · 2026-08-07
**Defined by:** [21_Phased_Implementation_Plan.md](<../project plan/21_Phased_Implementation_Plan.md>) Phase 0

Deliverable 3, first phase. Builds on the corrected [contracts/](../contracts/) and the decisions in
[docs/adr/](adr/) that Deliverable 2 ratified.

## Exit criteria — evidence

Doc 21 states five. Each was verified by running it, not by inspecting the code that implements it.

### 1. Clean checkout starts the full local stack with one documented command

```
pnpm stack:up
```

Verified from destroyed volumes (`pnpm stack:reset`): creates `.env`, starts PostgreSQL 16, a
separate disposable test database, Redis and MinIO, waits for all four health checks, applies all 22
migrations, seeds the `small` profile and asserts the seeded ledger balances.

```
ok   docker engine 29.6.2
ok   postgres healthy · postgres_test healthy · redis healthy · minio healthy
22 migration(s) applied
ok   ledger: 5,000 entries, 20,000 lines in 7.7s (2,607 lines/s)
ok   every seeded entry balances in base currency
```

Host ports are deliberately non-default (55432 / 55433 / 56379 / 9100). A developer machine very
often already runs PostgreSQL on 5432; the container binds anyway, the connection succeeds, and it
reaches somebody else's database. That happened during this build and cost twenty minutes, which is
why it is now a connection refusal instead of a silent wrong-server write.

### 2. CI rejects schema drift, failed tests and type errors

Four independent gates, all wired into [.github/workflows/ci.yml](../.github/workflows/ci.yml):

| Gate               | Command                | Result                                                       |
| ------------------ | ---------------------- | ------------------------------------------------------------ |
| Schema drift       | `pnpm db:verify`       | 22 applied, no edited migration, no structural drift         |
| Guard suite        | `pnpm db:guards`       | 14 scenarios, each asserted against its declared expectation |
| Contract drift     | `pnpm contracts:check` | 11 checks                                                    |
| Definition of Done | `pnpm dod:check`       | 6 mechanical checks (F-312)                                  |

The drift gate compares a fingerprint of the live catalog against
[contracts/schema/schema.lock.json](../contracts/schema/schema.lock.json) — 237 tables, 61 enums,
1477 constraints, 543 indexes, 27 triggers, 288 functions. **Proven to fail**: a hand-made
`CREATE TABLE rogue_manual_table` was detected as one added table plus one added index, and the
command exited non-zero.

### 3. The API writes a sample transaction and outbox event atomically

`POST /_phase0/sample-command` writes an aggregate row, an outbox event and an audit entry in one
transaction. Proven both ways:

- **Commits together** — one organization, one event, one audit row.
- **Rolls back together** — an exception thrown after the event is written leaves neither the row
  nor the event ([outbox.test.ts](../packages/database/src/integration/outbox.test.ts)).

`publish()` takes a `PoolClient`, never a `Pool`. There is no overload that publishes outside a
transaction, so "wrote the row but lost the event" is not a state this codebase can reach.

### 4. Retrying an idempotent command does not duplicate data

Four HTTP calls with one `Idempotency-Key`:

```
first call:  201  body={"id":"019fdc59-4d11-...","name":"Phase 0 Proof Co"}
attempt 1:   201  Idempotent-Replay: true   (identical body)
attempt 2:   201  Idempotent-Replay: true
attempt 3:   201  Idempotent-Replay: true

organizations=1  outbox_events=1  audit_events=1
```

Also covered: eight concurrent requests with the same key produce exactly one execution
([idempotency.test.ts](../packages/database/src/integration/idempotency.test.ts)); the same key with
a different payload is rejected `422 IDEMPOTENCY_KEY_REUSE`; a failed operation releases its key so a
corrected retry is not blocked.

### 5. Logs trace a request across API and worker by correlation ID

One request, correlation ID `phase0-proof-001`, appearing in both processes:

```
api    {"level":"info","req":{"method":"POST","path":"/_phase0/sample-command"},
        "res":{"status":201},"correlation_id":"phase0-proof-001","msg":"request"}
worker {"level":"debug","event_type":"organization.created",
        "correlation_id":"phase0-proof-001","msg":"event published"}
worker {"level":"info","event_type":"organization.created","aggregate_id":"019fdc59-4d11-...",
        "correlation_id":"phase0-proof-001","msg":"domain event consumed"}
```

The ID is carried in `AsyncLocalStorage`, attached by the pino formatter rather than passed at each
call site, written to the outbox envelope, and restored by the worker from that envelope.

## What was built

| Module                                       | Contents                                                                                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| [packages/config](../packages/config/)       | Typed environment validation; refuses to start on an invalid configuration, and refuses the Phase 0 sample route in production                      |
| [packages/domain](../packages/domain/)       | Decimal arithmetic on `bigint`, the ADR-0006 rounding chain, accounting dates, error taxonomy, cursor pagination, UUIDv7, request context           |
| [packages/database](../packages/database/)   | Pool with corrective type parsers, transaction helper with ADR-0004 lock ordering, migrator and drift gate, outbox, idempotency, hash-chained audit |
| [packages/contracts](../packages/contracts/) | Generated constants from `events.yaml` / `openapi.yaml`, plus the 11-check drift gate                                                               |
| [packages/testing](../packages/testing/)     | The three ADR-0009 seed profiles and the Gate H benchmark harness                                                                                   |
| [packages/ui](../packages/ui/)               | Design tokens, WCAG 2.2 AA contrast enforcement, money formatting                                                                                   |
| [apps/api](../apps/api/)                     | NestJS shell: correlation, structured logging, error filter, health, sample command                                                                 |
| [apps/worker](../apps/worker/)               | Outbox drainer and idempotent event consumer                                                                                                        |
| [apps/web](../apps/web/)                     | Next.js shell with the health view                                                                                                                  |
| [infra](../infra/)                           | Docker Compose on PostgreSQL 16, Redis 7, MinIO                                                                                                     |

**157 tests**, all passing: 62 domain · 43 database (integration, against a real PostgreSQL) ·
24 UI · 13 testing · 8 contracts · 7 config.

## Decisions taken during this phase

**[ADR-0010 — Accessibility standard](adr/0010-accessibility-standard.md)** closes F-406, the S2
finding deferred out of Deliverable 2. WCAG 2.2 AA, enforced in CI rather than asserted in a document.
The contrast checks caught a real defect immediately: `--border-strong` was 2.84:1 against the page
surface, below the 3:1 that criterion 1.4.11 requires for UI component boundaries.

**F-312 — the Definition of Done now has enforcement.** Six of doc 98's eighteen items are
mechanically checkable and are checked by [scripts/definition-of-done.mjs](../scripts/definition-of-done.mjs);
the remaining thirteen are printed as the reviewer's list, so the boundary between "the machine
checked this" and "a person must check this" is explicit rather than assumed.

## Defects found and fixed while building

Worth recording, because each was found by a check rather than by reading:

| Found by           | Defect                                                                                                                                                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Integration test   | `pg_advisory_xact_lock(bigint, bigint)` does not exist — the two-argument form takes `int4`                                                                                                                                                                                |
| Integration test   | A business-rule error thrown inside a transaction was being relabelled "Database operation failed", turning an actionable 422 into an opaque 500                                                                                                                           |
| Contract test      | The `forbidden:` mapping direction was inverted in the generator — `bill.posted` is the superseded name, `vendor_bill.posted` the canonical one                                                                                                                            |
| Contract check     | Five `/auth/*` mutations carried no `x-permission`; four are legitimately `security: []` and `logout` is self-service, so both exemptions are now declared in the contract and the check enforces that they appear nowhere else                                            |
| Seed unit test     | The seeder posted to GRNI, a system account the posting engine resolves from `accounting_policies`                                                                                                                                                                         |
| Contrast test      | `--border-strong` failed WCAG 1.4.11 at 2.84:1                                                                                                                                                                                                                             |
| Clean-database run | **The guard runner reported "12 rejected, 4 accepted" and exited 0 while its fixtures had silently failed.** A gate that cannot fail is the exact defect the audit exists to prevent. It now runs in a throwaway database and asserts each scenario's declared expectation |

## Deferred to a later phase, deliberately

- **F-407** — accounting grid behaviour. Phase 2 product design work; ADR-0010 §3 states the
  accessibility constraints it must satisfy.
- **Gate H workloads for phases 3–8** are declared in
  [workloads.ts](../packages/testing/src/bench/workloads.ts) with their ADR-0009 targets and report
  `skipped` with a reason. A benchmark that quietly measures nothing is worse than one that is
  absent, because it reports green.
- **`single-journal-post-10-lines`** cannot be measured until Phase 2 builds the posting service.
  It is the one Gate H target that matters most, and it is declared and skipped rather than faked.

## Next

Phase 1 — Tenant, Organization, Legal Entity, IAM and Finance Setup. The Phase 0 sample command is
replaced by the real `createOrganization` from `contracts/openapi.yaml`, which does the same four
things (transaction, outbox, audit, idempotency) for a real aggregate.
