# Accounting Platform

Multi-tenant SaaS accounting and ERP platform. Tenant → Organization → Legal Entity → Branch →
Accounting Book → Ledger.

## Start here

```bash
pnpm stack:up     # containers, migrations, seed data — one command, clean checkout
pnpm dev          # api :3001 · worker · web :3000
```

Requires Docker and Node 22+. `pnpm stack:up` creates `.env` from `.env.example` on first run.

| Command                                        | Does                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `pnpm stack:up` / `stack:down` / `stack:reset` | local stack (`reset` destroys volumes)                             |
| `pnpm dev`                                     | run api, worker and web together                                   |
| `pnpm verify`                                  | everything CI runs: format, lint, typecheck, contracts, DoD, tests |
| `pnpm db:migrate` / `db:verify` / `db:guards`  | apply migrations · drift gate · guard suite                        |
| `pnpm db:runtime-role`                         | create the login role the application connects as                  |
| `pnpm db:seed -- --profile reference`          | seed a Gate H measurement dataset                                  |
| `pnpm bench`                                   | Gate H benchmark against the stored baseline                       |

Two database roles, and the difference is load-bearing. `DATABASE_URL` is the owner and runs
migrations, seeding and benchmarks. `APP_DATABASE_URL` is `app_runtime`, which the API and worker
connect as: not a superuser, so the row-level security policies actually apply, and without the
privileges Gate C requires be revoked. Pointing both at the same role is rejected at boot.

## Layout

```
apps/
  api        NestJS. Contract-driven auth, permissions and idempotency; the Phase 1–5 domain.
  worker     Outbox drainer, idempotent event consumer, scheduled reversals and recurring journals.
  web        Next.js. Administration screens, the journal grid, ledger, subledger, banking,
             inventory, fixed assets, projects and budgets.
packages/
  config     Typed environment validation. Fails at boot, not at first use.
  domain     Decimal money, the rounding chain, the posting engine, the posting-rule language.
  database   Pool, transactions and lock ordering, migrator, outbox, idempotency, audit.
  ledger     The accounting kernel. Framework-free, so the API and the worker post the same way.
  subledger  AR, AP, tax, sales, procurement and documents. Posts through ledger, never into it.
  banking    Feed import, matching, reconciliation, treasury. Consumes AR/AP; never settles a document itself.
  contracts  Generated from contracts/*.yaml, plus the drift gate.
  testing    Seed profiles and the benchmark harness.
  ui         Design tokens, WCAG 2.2 AA contrast enforcement, money formatting.
infra/       Docker Compose: PostgreSQL 16, Redis 7, MinIO.
```

## Where the rules live

Three directories, in order of authority. Where they disagree, the earlier one wins and the audit
finding explains why.

**[contracts/](contracts/)** — the single source of truth for schema, events and API.
48 migrations · 246 tables · 177 events · 331 operations · 227 permissions. Supersedes the
blueprints in the handoff package.

**[docs/adr/](docs/adr/)** — ten ratified decisions. The ones that change day-to-day code:

| ADR                                                                 | Decision                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [0001](docs/adr/0001-accounting-framework-and-retained-earnings.md) | IFRS; both retained-earnings methods, tenant chooses per book     |
| [0003](docs/adr/0003-ledger-physical-design.md)                     | Denormalised scope on `journal_lines`, guaranteed by composite FK |
| [0004](docs/adr/0004-concurrency-protocols.md)                      | Pessimistic locks, in a documented order                          |
| [0006](docs/adr/0006-money-precision-and-rounding.md)               | The rounding boundary chain — normative                           |
| [0008](docs/adr/0008-platform-baseline.md)                          | PostgreSQL 16 minimum; where raw SQL is mandatory                 |
| [0009](docs/adr/0009-performance-baselines.md)                      | Seed profiles and Gate H targets                                  |
| [0010](docs/adr/0010-accessibility-standard.md)                     | WCAG 2.2 AA, enforced in CI                                       |

**[audit/](audit/)** — 97 findings against the original specification, and why each artifact above
looks the way it does. Read a finding before changing something it explains.

**[project plan/](<project plan/>)** — the immutable v1.0 handoff. **Never modified.**

## Rules that the tooling enforces

Not conventions — each of these fails a build.

1. **Money is never a binary float.** `numeric(24,8)` in storage, decimal strings on the wire,
   `bigint` arithmetic in `@acct/domain`. `pnpm dod:check` fails on `parseFloat` or `Number()`
   applied to a monetary value.
2. **Rounding happens only at the ADR-0006 boundaries.** `sumRounded` accepts only already-rounded
   values and does not round its result, so a document total cannot disagree with its own lines.
3. **An event type must exist in `contracts/events.yaml`** before it can be published. The outbox
   writer rejects unknown names at runtime; CI rejects them at commit.
4. **Migrations are forward-only.** Editing an applied migration fails `pnpm db:verify`. Rollback is
   a new forward migration.
5. **Posted accounting facts are immutable.** Enforced by database trigger, not by application code.
   Correct posted history by reversal, credit note or adjustment.
6. **Every mutation route declares a permission**, or declares an exemption that the contract check
   restricts to the auth and inbound-webhook surfaces.
7. **A route handler declares only which contract operation it is.** The permission, the
   authentication requirement, the idempotency rule and the success status all come from
   `contracts/openapi.yaml` at request time, so a route cannot enforce the wrong one. The API
   refuses to start if a route carries no operation, or if a delivered operation has no handler.
8. **The application never connects to the database as the owner.** The owner is a superuser and a
   superuser bypasses row-level security entirely, which would make the ADR-0002 policies
   decorative. `@acct/config` refuses to boot and `pnpm db:verify` fails.
9. **Row-level security is declared in a table, not in a list in a script.** `rls_protected_tables`
   is the registry; `pnpm db:verify` joins the catalog against it in both directions, so a table
   that is registered but unprotected _and_ a table that is protected but unregistered each fail
   the build. Before this, the check was a hardcoded list of six, and every table added afterwards
   was unprotected while being reported as covered (F-618).

## Progress

| Phase                                                    | State                                                                                   |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Deliverable 1 — specification audit                      | complete · 97 findings                                                                  |
| Deliverable 2 — canonical contracts                      | complete · all 14 S1 findings resolved                                                  |
| **Phase 0** — repository and platform foundation         | **complete** · [evidence](docs/PHASE_0.md)                                              |
| **Phase 1** — tenant, IAM, finance setup                 | **complete** · [evidence](docs/PHASE_1.md)                                              |
| **Phase 2** — accounting kernel and general ledger       | **complete** · [evidence](docs/PHASE_2.md)                                              |
| **Phase 3** — customers, vendors, AR, AP, tax, documents | **complete** · [evidence](docs/PHASE_3.md)                                              |
| **Phase 4** — banking, cash, clearing and reconciliation | **complete** · [evidence](docs/PHASE_4.md)                                              |
| **Phase 5** — inventory, fixed assets, projects, budgets | **complete** · [evidence](docs/PHASE_5.md)                                              |
| Phase 6 — reporting, approvals, period close, audit      | next                                                                                    |
| Phases 6–11                                              | per [21_Phased_Implementation_Plan.md](<project plan/21_Phased_Implementation_Plan.md>) |
