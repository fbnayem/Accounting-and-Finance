/**
 * @acct/approvals — doc 21 Phase 6's approval engine.
 *
 * "Versioned workflow definitions. Conditions based on amount, entity, account,
 * vendor/customer, department, risk and source type. Serial/parallel approvals.
 * Delegation, escalation and expiry. Maker/checker and segregation-of-duties
 * rules. Approval task inbox and audit history."
 *
 * The tables (0017) and their isolation (0050) were already there and nothing had
 * ever written to them: no route set a document to PENDING_APPROVAL, so the state
 * was in the enum, in the contract, and unreachable. This package is what writes
 * them — and, more to the point, what makes the guards that already existed above
 * those states fire for the first time.
 *
 * `assertApprovalSatisfied` is the export a posting or payment path calls. It is
 * the difference between an engine that records approvals and an engine that
 * prevents postings, and it is only as good as its call sites.
 */
export * from './conditions';
export * from './definition';
export * from './steps';
export * from './resources';
export * from './workflows.service';
export * from './engine.service';
export * from './tasks.service';
