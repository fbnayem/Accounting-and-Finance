import { z } from 'zod';
import { validationFailed } from '@acct/domain';

/**
 * One place where a Zod failure becomes the contract's error shape.
 *
 * contracts/openapi.yaml's `Error` schema requires `code`, `message` and
 * `correlation_id`, with `field_errors` carrying the detail. Letting each handler
 * translate its own Zod error would produce a different shape per route, which is
 * exactly the "no new ad-hoc error shapes" line in doc 98's Definition of Done.
 */
export function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw validationFailed(
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      code: issue.code,
      message: issue.message,
    })),
  );
}

export const uuid = z.string().uuid();
export const code = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'letters, digits, dot, dash and underscore only');
export const name = z.string().trim().min(1).max(200);
export const email = z.string().trim().toLowerCase().email().max(320);
export const countryCode = z.string().trim().toUpperCase().length(2, 'ISO 3166-1 alpha-2, e.g. GB');
export const currencyCode = z.string().trim().toUpperCase().length(3, 'ISO 4217, e.g. USD');
/** ADR-0006 §1: money crosses the wire as a decimal string, never a JSON number. */
export const decimalString = z
  .string()
  .trim()
  .regex(/^-?\d{1,20}(\.\d{1,12})?$/, 'a decimal string, e.g. "1234.56" — never a JSON number');
export const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
/** IANA zone. Validated against the runtime's own database rather than a list. */
export const timezone = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'not a recognised IANA time zone, e.g. Europe/London');

/** doc 02 requires a reason on close, reopen and every override. Long enough to mean something. */
export const reason = z.string().trim().min(3).max(1000);

export const pageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
