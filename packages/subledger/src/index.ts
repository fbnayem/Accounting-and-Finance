/**
 * @acct/subledger — customers, vendors, tax and the documents between them.
 *
 * Built as a package for the same reason @acct/ledger was: the worker generates
 * recurring invoices and advances dunning stages, and its alternatives were an
 * HTTP call back into its own API or its own INSERT. Every one of these services
 * reaches the general ledger through @acct/ledger's PostingService and none of
 * them writes a journal line, which is doc 21's dependency rule for this phase
 * stated as a build constraint rather than as advice.
 */
export * from './tax.service';
export * from './document-posting.service';
export * from './allocation';
export * from './ar.service';
export * from './sales.service';
export * from './ap.service';
export * from './procurement.service';
export * from './tax-return.service';
export * from './localization.service';
export * from './files.service';
export * from './reports.service';
