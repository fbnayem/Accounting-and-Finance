/**
 * @acct/assets — categories, the asset register, capitalization, depreciation
 * runs, impairment/revaluation, disposal and the asset reports of doc 09.
 *
 * A package for the same reason @acct/banking is: the depreciation run is a
 * period-close job as much as a route, and a scheduler that needed it would
 * otherwise call back into its own API. Framework-free, plain classes over a
 * `Pool`; everything posts through DocumentPostingService, and nothing here
 * ever rewrites a historical cost or accumulated value — carrying amounts are
 * derived, and correction is by reversal.
 */
export * from './categories.service';
export * from './register.service';
export * from './capitalization.service';
export * from './depreciation.service';
export * from './valuation.service';
export * from './disposal.service';
export * from './reports.service';
