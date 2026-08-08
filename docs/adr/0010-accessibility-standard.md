# ADR-0010 — Accessibility standard

**Status:** Accepted · 2026-08-07
**Resolves:** [F-406](../../audit/05_Missing_Requirements.md) — the S2 finding deferred out of
Deliverable 2 and recorded in [contracts/README.md](../../contracts/README.md) as Phase 0 work.

## Context

The specification package names no accessibility standard anywhere. Doc 02 mentions language and
format settings; nothing states a conformance target, and no Release Gate tests one.

That is an S2 rather than an S3 because of who buys this product. An accounting platform is bought by
finance departments, and in most of the markets this product targets — EU (EN 301 549, referencing
WCAG 2.1 AA), US federal and state procurement (Section 508, likewise), UK public sector — an
accessibility conformance statement is a procurement precondition, not a nice-to-have. A deal is lost
at the VPAT stage, long after the code that failed it was written.

The cost curve is the argument for doing it now. Retrofitting keyboard navigation and focus management
into an accounting grid, a period-close workflow and a reconciliation screen is close to a rewrite of
each. Deciding in Phase 0 costs a linter, a CI job and a component-library convention.

## Decision

### 1. Target: WCAG 2.2 Level AA

2.2 rather than 2.1: it is the current W3C Recommendation, it is backward compatible, and its new
success criteria are precisely the ones a dense financial application fails —
**2.4.11 Focus Not Obscured**, **2.5.7 Dragging Movements**, **2.5.8 Target Size (Minimum)**, and
**3.2.6 Consistent Help**. A sticky table header covering the focused row is a 2.4.11 failure and is
exactly what an accounting grid does by default.

AAA is not targeted. Some AAA criteria (contrast 7:1, no images of text) conflict with dense
data presentation, and the W3C itself does not recommend AAA as a blanket policy.

### 2. Enforced in CI, not asserted in a document

F-312's point was that the Definition of Done had no enforcement. The same failure would apply here,
so:

| Check                     | Tool                                                 | When           | Severity                    |
| ------------------------- | ---------------------------------------------------- | -------------- | --------------------------- |
| Static rule violations    | `eslint-plugin-jsx-a11y` (strict)                    | every commit   | blocks                      |
| Rendered-DOM violations   | `axe-core` via `vitest-axe` on every component story | every commit   | blocks (serious + critical) |
| Full-page scan            | `@axe-core/playwright` on the primary flows          | pre-release    | blocks (serious + critical) |
| Keyboard-only walkthrough | manual, scripted                                     | per phase exit | blocks                      |
| Screen reader spot-check  | manual (NVDA + VoiceOver)                            | per release    | recorded, not blocking      |

Automated tooling detects roughly a third of WCAG issues. The manual rows are there because the other
two thirds are where a keyboard trap in the journal-entry grid would live, and no linter finds those.

### 3. Component-library rules

Enforced by convention in `packages/ui` and by review:

- Every interactive element is reachable and operable by keyboard, in a sensible order.
- Focus is **always** visible, with a minimum 3:1 contrast against the adjacent colour, and never
  removed by `outline: none` without an equivalent replacement.
- Colour is never the sole carrier of meaning. A negative balance is red **and** parenthesised or
  signed — which is also ordinary accounting convention, so this costs nothing.
- Text contrast 4.5:1 minimum; 3:1 for large text and for UI component boundaries.
- Every form control has a programmatically associated label; error messages are associated via
  `aria-describedby` and announced.
- Data tables use real `<th>` with `scope`, not styled `<div>`s.
- Any drag interaction (reordering allocations, moving lines) has a keyboard-operable equivalent —
  criterion 2.5.8.
- Targets are at least 24×24 CSS pixels.
- Motion respects `prefers-reduced-motion`.

### 4. Conformance statement

A VPAT 2.5 (WCAG edition) is produced before the first commercial release and republished each major
release. It states what actually conforms, including known exceptions — an overstated VPAT is a
contractual problem, not just an ethical one.

## Consequences

- `packages/ui` carries the accessibility obligations from its first component, and every later screen
  inherits them instead of negotiating them.
- The Phase 6 audit workspace and the Phase 2 accounting grid — the two densest interfaces in the
  product — are designed against a stated target rather than retrofitted to one.
- [F-407](../../audit/05_Missing_Requirements.md) (accounting grid behaviour unspecified) must be
  written to this standard when Phase 2 specifies it. Keyboard navigation in that grid is both an
  accessibility requirement and the thing accountants judge the product by, which makes it the
  cheapest place for this decision to pay for itself.
- CI gets slower by the duration of an axe pass per component. That is the cost.
