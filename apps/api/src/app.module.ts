import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { DatabaseModule } from './common/database.module';
import { CorrelationMiddleware } from './common/correlation.middleware';
import { RequestLoggingMiddleware } from './common/request-logging.middleware';
import { AuthGuard } from './common/auth.guard';
import { PermissionGuard } from './common/permission.guard';
import { IdempotencyInterceptor } from './common/idempotency.interceptor';
import { HealthController } from './health/health.controller';
import { AuthController } from './auth/auth.controller';
import { SessionsController } from './auth/sessions.controller';
import { AuthService } from './auth/auth.service';
import { SessionService } from './auth/session.service';
import { OrganizationController } from './organization/organization.controller';
import { OrganizationService } from './organization/organization.service';
import { ConfigurationController } from './organization/configuration.controller';
import { ConfigurationService } from './organization/configuration.service';
import { IamController } from './iam/iam.controller';
import { IamService } from './iam/iam.service';
import { FinanceSetupController } from './finance-setup/finance-setup.controller';
import { FinanceSetupService } from './finance-setup/finance-setup.service';
import { AuditController, PlatformController } from './platform/platform.controller';
import { ChartController } from './ledger/chart.controller';
import { JournalController } from './ledger/journal.controller';
import { LedgerRulesController } from './ledger/rules.controller';
import { LedgerReportsController } from './ledger/reports.controller';
import { LEDGER_PROVIDERS } from './ledger/ledger.providers';
import { ArController } from './subledger/ar.controller';
import { ApController } from './subledger/ap.controller';
import { TaxController } from './subledger/tax.controller';
import { FilesController } from './subledger/files.controller';
import { SubledgerReportsController } from './subledger/reports.controller';
import { BankingController } from './banking/banking.controller';
import { BANKING_PROVIDERS } from './banking/banking.providers';
import { InventoryController } from './inventory/inventory.controller';
import { INVENTORY_PROVIDERS } from './inventory/inventory.providers';
import { AssetsController } from './assets/assets.controller';
import { ASSETS_PROVIDERS } from './assets/assets.providers';
import { ProjectsController } from './projects/projects.controller';
import { PROJECTS_PROVIDERS } from './projects/projects.providers';
import { SUBLEDGER_PROVIDERS } from './subledger/subledger.providers';

/**
 * The three cross-cutting rules are registered globally, in this order:
 *
 *   AuthGuard               who is calling
 *   PermissionGuard         may they call this operation (from the contract)
 *   IdempotencyInterceptor  has this exact call already happened (from the contract)
 *
 * Global rather than per-controller on purpose. A per-route guard is one a new
 * controller can forget; a global one that fails closed on an unmarked route is one
 * a new controller cannot forget. `reconcileRoutes` then checks at boot that every
 * route carries the contract marker they all read.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [
    HealthController,
    AuthController,
    SessionsController,
    OrganizationController,
    ConfigurationController,
    IamController,
    FinanceSetupController,
    ChartController,
    JournalController,
    LedgerRulesController,
    LedgerReportsController,
    ArController,
    ApController,
    TaxController,
    FilesController,
    SubledgerReportsController,
    BankingController,
    InventoryController,
    AssetsController,
    ProjectsController,
    PlatformController,
    AuditController,
  ],
  providers: [
    AuthService,
    SessionService,
    OrganizationService,
    ConfigurationService,
    IamService,
    FinanceSetupService,
    ...LEDGER_PROVIDERS,
    ...SUBLEDGER_PROVIDERS,
    ...BANKING_PROVIDERS,
    ...INVENTORY_PROVIDERS,
    ...ASSETS_PROVIDERS,
    // After SUBLEDGER_PROVIDERS: ProjectsService injects ArService to raise a
    // billing proposal's invoice as a DRAFT. Nest resolves by token rather than
    // by array order, but the ordering keeps the dependency legible.
    ...PROJECTS_PROVIDERS,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Order matters: the correlation context must exist before anything logs.
    consumer.apply(CorrelationMiddleware, RequestLoggingMiddleware).forRoutes('*');
  }
}
