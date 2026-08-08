/**
 * A minimal but coherent chart of accounts.
 *
 * Not a product feature — Phase 1 owns the real chart templates. This exists
 * because the ledger cannot be seeded, and Gate H cannot be measured, without one,
 * and because a chart that does not balance produces fixtures that quietly encode
 * a broken ledger.
 *
 * `normalBalance` is stated per account rather than derived from `accountType`.
 * The two do correlate, but contra accounts (accumulated depreciation, sales
 * returns) break the correlation, and having them present from the start keeps the
 * reporting code from assuming the shortcut.
 */

export interface SeedAccount {
  readonly code: string;
  readonly name: string;
  readonly type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  readonly normalBalance: 'DEBIT' | 'CREDIT';
  readonly group: string;
  readonly isControl?: boolean;
  readonly isSystem?: boolean;
  readonly cashFlow?: 'OPERATING' | 'INVESTING' | 'FINANCING' | 'NONE';
  /** The accounting_policies column this account fills, if any. */
  readonly policyRole?: string;
}

export interface SeedAccountGroup {
  readonly code: string;
  readonly name: string;
  readonly sortOrder: number;
}

export const ACCOUNT_GROUPS: readonly SeedAccountGroup[] = [
  { code: 'CA', name: 'Current assets', sortOrder: 10 },
  { code: 'NCA', name: 'Non-current assets', sortOrder: 20 },
  { code: 'CL', name: 'Current liabilities', sortOrder: 30 },
  { code: 'NCL', name: 'Non-current liabilities', sortOrder: 40 },
  { code: 'EQ', name: 'Equity', sortOrder: 50 },
  { code: 'REV', name: 'Revenue', sortOrder: 60 },
  { code: 'COS', name: 'Cost of sales', sortOrder: 70 },
  { code: 'OPX', name: 'Operating expenses', sortOrder: 80 },
  { code: 'FIN', name: 'Finance income and cost', sortOrder: 90 },
];

export const CHART_OF_ACCOUNTS: readonly SeedAccount[] = [
  // --- assets ---
  {
    code: '1000',
    name: 'Cash on hand',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    group: 'CA',
    cashFlow: 'OPERATING',
  },
  {
    code: '1010',
    name: 'Bank current account',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    group: 'CA',
    cashFlow: 'OPERATING',
  },
  {
    code: '1020',
    name: 'Bank savings account',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    group: 'CA',
    cashFlow: 'OPERATING',
  },
  {
    code: '1030',
    name: 'Cash clearing',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    group: 'CA',
    isSystem: true,
    policyRole: 'cash_clearing_account_id',
  },
  {
    code: '1040',
    name: 'Payment clearing',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    group: 'CA',
    isSystem: true,
    policyRole: 'payment_clearing_account_id',
  },
  {
    code: '1100',
    name: 'Accounts receivable',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    group: 'CA',
    isControl: true,
    policyRole: 'ar_control_account_id',
  },
  {
    code: '1110',
    name: 'Allowance for doubtful debts',
    type: 'ASSET',
    normalBalance: 'CREDIT',
    group: 'CA',
  },
  {
    code: '1150',
    name: 'Vendor advances',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    group: 'CA',
    policyRole: 'vendor_advance_account_id',
  },
  {
    code: '1200',
    name: 'Inventory',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    group: 'CA',
    isControl: true,
  },
  {
    code: '1210',
    name: 'Inventory in transit',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    group: 'CA',
  },
  { code: '1300', name: 'Prepayments', type: 'ASSET', normalBalance: 'DEBIT', group: 'CA' },
  {
    code: '1310',
    name: 'Input tax recoverable',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    group: 'CA',
  },
  {
    code: '1400',
    name: 'Suspense',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    group: 'CA',
    isSystem: true,
    policyRole: 'suspense_account_id',
  },
  {
    code: '1500',
    name: 'Property, plant and equipment',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    group: 'NCA',
    cashFlow: 'INVESTING',
  },
  // Contra: an ASSET with a CREDIT normal balance.
  {
    code: '1510',
    name: 'Accumulated depreciation',
    type: 'ASSET',
    normalBalance: 'CREDIT',
    group: 'NCA',
    cashFlow: 'INVESTING',
  },
  {
    code: '1600',
    name: 'Intangible assets',
    type: 'ASSET',
    normalBalance: 'DEBIT',
    group: 'NCA',
    cashFlow: 'INVESTING',
  },
  {
    code: '1610',
    name: 'Accumulated amortisation',
    type: 'ASSET',
    normalBalance: 'CREDIT',
    group: 'NCA',
    cashFlow: 'INVESTING',
  },

  // --- liabilities ---
  {
    code: '2000',
    name: 'Accounts payable',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    group: 'CL',
    isControl: true,
    policyRole: 'ap_control_account_id',
  },
  {
    code: '2010',
    name: 'Goods received not invoiced',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    group: 'CL',
    isSystem: true,
    policyRole: 'grni_account_id',
  },
  {
    code: '2050',
    name: 'Customer advances',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    group: 'CL',
    policyRole: 'customer_advance_account_id',
  },
  {
    code: '2100',
    name: 'Output tax payable',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    group: 'CL',
    isControl: true,
  },
  {
    code: '2110',
    name: 'Withholding tax payable',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    group: 'CL',
  },
  { code: '2200', name: 'Accruals', type: 'LIABILITY', normalBalance: 'CREDIT', group: 'CL' },
  {
    code: '2300',
    name: 'Payroll liabilities',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    group: 'CL',
  },
  {
    code: '2500',
    name: 'Long-term borrowings',
    type: 'LIABILITY',
    normalBalance: 'CREDIT',
    group: 'NCL',
    cashFlow: 'FINANCING',
  },

  // --- equity ---
  {
    code: '3000',
    name: 'Share capital',
    type: 'EQUITY',
    normalBalance: 'CREDIT',
    group: 'EQ',
    cashFlow: 'FINANCING',
  },
  {
    code: '3100',
    name: 'Retained earnings',
    type: 'EQUITY',
    normalBalance: 'CREDIT',
    group: 'EQ',
    isSystem: true,
    policyRole: 'retained_earnings_account_id',
  },
  {
    code: '3110',
    name: 'Current year earnings',
    type: 'EQUITY',
    normalBalance: 'CREDIT',
    group: 'EQ',
    isSystem: true,
    policyRole: 'current_year_earnings_account_id',
  },
  {
    code: '3200',
    name: 'Revaluation surplus',
    type: 'EQUITY',
    normalBalance: 'CREDIT',
    group: 'EQ',
  },
  {
    code: '3300',
    name: 'Foreign currency translation reserve',
    type: 'EQUITY',
    normalBalance: 'CREDIT',
    group: 'EQ',
  },

  // --- revenue ---
  {
    code: '4000',
    name: 'Product revenue',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
    group: 'REV',
    cashFlow: 'OPERATING',
  },
  {
    code: '4010',
    name: 'Service revenue',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
    group: 'REV',
    cashFlow: 'OPERATING',
  },
  {
    code: '4090',
    name: 'Sales returns and allowances',
    type: 'REVENUE',
    normalBalance: 'DEBIT',
    group: 'REV',
  },
  { code: '4100', name: 'Other income', type: 'REVENUE', normalBalance: 'CREDIT', group: 'REV' },

  // --- cost of sales ---
  {
    code: '5000',
    name: 'Cost of goods sold',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    group: 'COS',
    cashFlow: 'OPERATING',
  },
  {
    code: '5010',
    name: 'Inventory adjustments',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    group: 'COS',
  },
  {
    code: '5020',
    name: 'Landed cost variance',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    group: 'COS',
  },

  // --- operating expenses ---
  {
    code: '6000',
    name: 'Salaries and wages',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    group: 'OPX',
    cashFlow: 'OPERATING',
  },
  {
    code: '6010',
    name: 'Rent',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    group: 'OPX',
    cashFlow: 'OPERATING',
  },
  {
    code: '6020',
    name: 'Utilities',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    group: 'OPX',
    cashFlow: 'OPERATING',
  },
  {
    code: '6030',
    name: 'Professional fees',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    group: 'OPX',
    cashFlow: 'OPERATING',
  },
  {
    code: '6040',
    name: 'Travel',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    group: 'OPX',
    cashFlow: 'OPERATING',
  },
  {
    code: '6050',
    name: 'Software and subscriptions',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    group: 'OPX',
    cashFlow: 'OPERATING',
  },
  { code: '6060', name: 'Depreciation', type: 'EXPENSE', normalBalance: 'DEBIT', group: 'OPX' },
  { code: '6070', name: 'Amortisation', type: 'EXPENSE', normalBalance: 'DEBIT', group: 'OPX' },
  {
    code: '6080',
    name: 'Bad debt expense',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    group: 'OPX',
    policyRole: 'bad_debt_account_id',
  },
  {
    code: '6090',
    name: 'Rounding adjustment',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    group: 'OPX',
    isSystem: true,
    policyRole: 'rounding_account_id',
  },

  // --- finance ---
  {
    code: '7000',
    name: 'Interest income',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
    group: 'FIN',
    cashFlow: 'FINANCING',
  },
  {
    code: '7010',
    name: 'Interest expense',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    group: 'FIN',
    cashFlow: 'FINANCING',
  },
  {
    code: '7100',
    name: 'Realised FX gain',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
    group: 'FIN',
    isSystem: true,
    policyRole: 'realized_fx_gain_account_id',
  },
  {
    code: '7110',
    name: 'Realised FX loss',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    group: 'FIN',
    isSystem: true,
    policyRole: 'realized_fx_loss_account_id',
  },
  {
    code: '7120',
    name: 'Unrealised FX gain',
    type: 'REVENUE',
    normalBalance: 'CREDIT',
    group: 'FIN',
    isSystem: true,
    policyRole: 'unrealized_fx_gain_account_id',
  },
  {
    code: '7130',
    name: 'Unrealised FX loss',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    group: 'FIN',
    isSystem: true,
    policyRole: 'unrealized_fx_loss_account_id',
  },
  {
    code: '7200',
    name: 'Bank charges',
    type: 'EXPENSE',
    normalBalance: 'DEBIT',
    group: 'FIN',
    cashFlow: 'OPERATING',
  },
];

/**
 * Account pairs an ordinary general-journal entry may hit.
 *
 * System accounts are excluded: clearing, suspense, GRNI, retained earnings and
 * the FX accounts are resolved by the posting engine from `accounting_policies`,
 * and a seeder that posts to them directly would produce a dataset in which those
 * balances mean nothing.
 *
 * Control accounts are included. Real general journals do reach AR and AP control
 * accounts, and a trial balance in which the control accounts are always zero
 * would not exercise the Gate D subledger-to-control reconciliation at all.
 */
export const POSTABLE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['6000', '1010'], // payroll paid from the bank
  ['6010', '1010'], // rent
  ['6020', '2000'], // utilities on account
  ['6030', '2000'], // professional fees on account
  ['6040', '1000'], // travel from petty cash
  ['6050', '1010'], // subscriptions
  ['1100', '4000'], // product sale on credit
  ['1100', '4010'], // service sale on credit
  ['5000', '1200'], // cost of goods sold
  ['1010', '1100'], // customer receipt
  ['2000', '1010'], // vendor payment
  ['1200', '2000'], // inventory purchased on account
  ['6060', '1510'], // depreciation
  ['7010', '1010'], // interest paid
  ['1010', '7000'], // interest received
  ['7200', '1010'], // bank charges
];
