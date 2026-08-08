# 06 — Package Integrity

Audit of the delivered package as an artifact: is it authentic, and is it complete?

Source: `d:\accounting_system\project plan\`
Audited: 2026-08-07

---

## 1. Authenticity — PASS

[MANIFEST.md](../project%20plan/MANIFEST.md) publishes a SHA-256 for every file. All eight content
files present on disk were hashed and compared.

| File | Manifest bytes | Result |
|---|---:|---|
| `Accounting_Platform_Master_Specification.md` | 131,871 | **MATCH** |
| `00_Module_Function_Matrix.md` | 3,641 | **MATCH** |
| `21_Phased_Implementation_Plan.md` | 19,334 | **MATCH** |
| `22_Release_Gates.md` | 5,557 | **MATCH** |
| `schema_blueprint.sql` | 44,916 | **MATCH** |
| `event_catalog.json` | 4,501 | **MATCH** |
| `api_route_catalog.yaml` | 6,530 | **MATCH** |
| `posting_rule_catalog.md` | 7,326 | **MATCH** |

Method: `Get-FileHash -Algorithm SHA256`, lowercased, compared against the manifest table.
`MANIFEST.md` is not self-hashed, so it is trusted rather than verified.

**Conclusion:** the files are byte-identical to what the manifest describes. Nothing has been
truncated, re-saved, or edited in transit. Where this audit disagrees with the specification, it is
disagreeing with the author's intent, not with a corrupted copy.

---

## 2. Completeness — FAIL (partial extraction)

The manifest describes a package of **39 files** across three subfolders. The delivered folder is
**flat with 9 files**.

| Manifest group | Expected | Present | Missing |
|---|---:|---:|---:|
| Root (`README.md`, master spec) | 2 | 1 | 1 |
| `docs/` | 25 | 3 | 22 |
| `phases/` | 12 | 0 | 12 |
| `blueprints/` | 4 | 4 | 0 |
| **Total** | **43\*** | **8** | **35** |

\* The manifest table lists 43 rows; the package layout section describes them as ~39 logical files.
Either count is materially larger than what arrived. `MANIFEST.md` itself is present but not listed
in its own table.

### F-501 — S4 — Twenty-two `docs/*.md` files are absent but their content is not lost

**Finding.** `docs/01`–`docs/20`, `docs/23`, `docs/24` and `docs/98` are missing as standalone files.

**Assessment: not material.** The master specification inlines every one of them. Section-boundary
parsing of `Accounting_Platform_Master_Specification.md` recovers 25 document sections (00–24 plus
98), and the three docs that *were* delivered standalone (00, 21, 22) are byte-for-byte identical to
their inlined copies. No content is missing.

**Resolution:** none required. Treat the master specification as the canonical source for docs 01–20,
23, 24 and 98.

### F-502 — S3 — Twelve `phases/*.md` handoff files are absent, content unverified

**Finding.** All 12 `phases/Phase_NN_*.md` files are missing. Unlike the docs, these are **not**
inlined anywhere in the master specification.

**Assessment.** Their manifest byte sizes (652–1,929 bytes) are small — collectively ~17 KB against
the 19 KB of doc 21, which covers the same 12 phases. The overwhelming likelihood is that they are
per-phase extracts of doc 21 formatted as individual developer handoffs, carrying no unique
requirements. But this is inference from file size, not verification.

**Risk if wrong:** a phase file could carry a task list or constraint absent from doc 21. Given that
doc 21 already supplies Build lists and Exit criteria for every phase, the exposure is low.

**Resolution:** request the complete original package from whoever produced it, primarily to close
this gap. If unavailable, proceed on doc 21 and record the assumption. **Do not block on this** —
doc 21 is self-sufficient for Phase 0 and Phase 1 planning.

### F-503 — S4 — `README.md` absent

**Finding.** A 2,697-byte `README.md` is listed and missing.

**Assessment.** Orientation material. The master specification's own "Technology baseline" and
"Non-negotiable platform rules" sections (lines 10–31) serve the same purpose and are present.

**Resolution:** none required.

---

## 3. Internal consistency of the manifest

### F-504 — S4 — Manifest paths do not match the delivered layout

The manifest references `docs/00_Module_Function_Matrix.md`; the file sits at
`project plan\00_Module_Function_Matrix.md`. Likewise for `blueprints/*`. The master specification's
own "Documents" list (lines 34–63) uses the same subfoldered paths.

**Resolution.** When Deliverable 2 establishes `contracts/`, restore the subfolder structure so
cross-references in the specification resolve. Keep `project plan/` itself unmodified as the
immutable v1.0 handoff; create the structured copy elsewhere.

---

## 4. Scale of the delivered specification

Measured, for sizing the audit and the build:

| Measure | Count |
|---|---:|
| Specification sections (docs 00–24, 98) | 25 |
| Master specification lines | 3,079 |
| Tables in `schema_blueprint.sql` | 74 |
| Distinct events in `event_catalog.json` | 136 |
| Route entries in `api_route_catalog.yaml` | 192 (150 distinct paths) |
| Posting rules in `posting_rule_catalog.md` | 44 |
| Data objects named across doc "Data objects" sections | 199 |
| Acceptance bullets across docs 01–24 | 105 |
| Release gate criteria (Gates A–L) | 81 |
| Definition-of-Done items | 18 |
| Phase exit criteria (Phases 0–11) | 56 |
| Phase "Build" bullets | 319 |

**Total distinct pass/fail obligations: 260** (105 acceptance + 81 gate + 56 exit + 18 DoD).
This is the number that Deliverable 3 must eventually satisfy. It is used in
[04_Unquantified_Requirements.md](04_Unquantified_Requirements.md) as the denominator for
testability classification.

---

## Verdict

**Authentic, materially complete, structurally mis-extracted.** The one real gap is the 12
`phases/*.md` files, and the evidence strongly suggests they are redundant with doc 21. Nothing here
blocks starting the audit or the build.
