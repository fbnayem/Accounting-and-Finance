/**
 * The journal line as it crosses the wire.
 *
 * Shared by the manual journal, the recurring template and the opening balance
 * import, because all three produce the same thing and a second definition would
 * eventually accept a field the first rejects.
 *
 * Money is a decimal string, never a JSON number (ADR-0006 §1 — a JSON number has
 * already been through binary floating point by the time it is parsed). The
 * dimension map is `{dimension_id: dimension_value_id}`, which is the shape the
 * posting engine takes, so nothing between here and the ledger reshapes it.
 */
import { z } from 'zod';
import { currencyCode, decimalString, isoDate, uuid } from '../common/validation';

export const LineBody = z.object({
  account_id: uuid,
  description: z.string().trim().max(500).optional(),
  debit: decimalString.optional(),
  credit: decimalString.optional(),
  transaction_currency: currencyCode.optional(),
  exchange_rate: decimalString.optional(),
  exchange_rate_date: isoDate.optional(),
  exchange_rate_source: z.string().trim().max(80).optional(),
  branch_id: uuid.optional(),
  contact_id: uuid.optional(),
  dimensions: z.record(uuid, uuid).optional(),
});

export type LineBodyInput = z.infer<typeof LineBody>;

export const toLine = (l: LineBodyInput) => ({
  accountId: l.account_id,
  description: l.description,
  debit: l.debit,
  credit: l.credit,
  transactionCurrency: l.transaction_currency,
  exchangeRate: l.exchange_rate,
  exchangeRateDate: l.exchange_rate_date,
  exchangeRateSource: l.exchange_rate_source,
  branchId: l.branch_id,
  contactId: l.contact_id,
  dimensions: l.dimensions,
});
