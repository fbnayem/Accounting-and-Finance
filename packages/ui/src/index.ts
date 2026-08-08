/**
 * @acct/ui — the shared component layer.
 *
 * Phase 0 ships the parts every later screen depends on and that are expensive to
 * retrofit: the token palette, the WCAG 2.2 AA contrast checks that keep it
 * conformant (ADR-0010), and the money/date formatting rules that keep the
 * presentation layer from disagreeing with the ledger (ADR-0006).
 *
 * Components arrive in Phase 2, with the accounting grid, once F-407 specifies
 * its behaviour.
 */
export * from './contrast';
export * from './format';
