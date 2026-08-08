import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import { SubledgerReportsService, TaxService } from '@acct/subledger';
import { Operation } from '../common/operation';
import { isoDate, parse, uuid } from '../common/validation';
import type { AuthenticatedRequest } from '../common/auth.guard';
import { tenantPrincipal } from '../common/request';

/**
 * doc 04's AR Aging, doc 05's AP Aging, doc 07's tax report.
 *
 * `as_of` is required rather than defaulted to today. An aging report is a
 * statement about a date, and one that silently uses the server's clock cannot be
 * reproduced tomorrow — which is the first thing anyone asks of it.
 */

const AgingQuery = z.object({
  legal_entity_id: uuid,
  as_of: isoDate,
  contact_id: uuid.optional(),
  // doc 04 allows the tenant to choose its own ladder; the default is 30/60/90.
  // Ascending is checked here rather than left to SQL: out-of-order boundaries
  // produce overlapping columns, which double-counts silently instead of failing.
  buckets: z
    .string()
    .trim()
    .regex(/^\d{1,4}(,\d{1,4}){2}$/, 'three day counts, e.g. "30,60,90"')
    .refine(
      (value) => {
        const days = value.split(',').map(Number);
        return days.every((d, i) => i === 0 || d > (days[i - 1] ?? 0));
      },
      { message: 'bucket boundaries must ascend, e.g. "30,60,90"' },
    )
    .optional(),
});

@Controller()
export class SubledgerReportsController {
  constructor(
    @Inject(SubledgerReportsService) private readonly reports: SubledgerReportsService,
    @Inject(TaxService) private readonly tax: TaxService,
  ) {}

  @Get('reports/ar-aging')
  @Operation('getArAging')
  async arAging(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.reports.aging(tenantPrincipal(request), 'AR', agingFilter(query));
  }

  @Get('reports/ap-aging')
  @Operation('getApAging')
  async apAging(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    return this.reports.aging(tenantPrincipal(request), 'AP', agingFilter(query));
  }

  @Get('reports/tax')
  @Operation('getTaxReport')
  async taxReport(@Req() request: AuthenticatedRequest, @Query() query: unknown) {
    const parsed = parse(z.object({ legal_entity_id: uuid, from: isoDate, to: isoDate }), query);
    return this.tax.report(tenantPrincipal(request), {
      legalEntityId: parsed.legal_entity_id,
      from: parsed.from,
      to: parsed.to,
    });
  }
}

function agingFilter(query: unknown) {
  const parsed = parse(AgingQuery, query);
  const buckets = parsed.buckets?.split(',').map(Number);
  return {
    legalEntityId: parsed.legal_entity_id,
    asOf: parsed.as_of,
    contactId: parsed.contact_id,
    ...(buckets ? { buckets } : {}),
  };
}
