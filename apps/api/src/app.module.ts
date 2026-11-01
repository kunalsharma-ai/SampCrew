import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ApprovalsController } from './modules/approvals/approvals.controller';
import { ApprovalsService } from './modules/approvals/approvals.service';
import { AuditController } from './modules/audit/audit.controller';
import { AuthController, MeController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import { BillingController } from './modules/billing/billing.controller';
import { BillingService } from './modules/billing/billing.service';
import { DocumentsController } from './modules/documents/documents.controller';
import { DocumentsService } from './modules/documents/documents.service';
import { DesignationsController, EmployeesController } from './modules/employees/employees.controller';
import { EmployeesService } from './modules/employees/employees.service';
import { HealthController } from './modules/health/health.controller';
import { HrJobsService } from './modules/hr-jobs/hr-jobs.service';
import { LeaveController } from './modules/leave/leave.controller';
import { LeaveService } from './modules/leave/leave.service';
import { MembersController } from './modules/members/members.controller';
import { MembersService } from './modules/members/members.service';
import { DashboardController, DashboardService } from './modules/experience/dashboard.controller';
import { PreferencesController } from './modules/experience/preferences.controller';
import { ViewsController } from './modules/experience/views.controller';
import { BidsController, ProposalsPublicController } from './modules/bids/bids.controller';
import { IqController } from './modules/iq/iq.controller';
import { IqService } from './modules/iq/iq.service';
import { ProposalsPublicService } from './modules/bids/proposals-public.service';
import { BidsService } from './modules/bids/bids.service';
import { UniverseController } from './modules/universe/universe.controller';
import { UniverseService } from './modules/universe/universe.service';
import { NotificationsController } from './modules/notifications/notifications.controller';
import { OnboardingController } from './modules/onboarding/onboarding.controller';
import { OnboardingService } from './modules/onboarding/onboarding.service';
import {
  BusinessUnitsController,
  DepartmentsController,
  LegalEntitiesController,
  LocationsController,
  OrganizationController,
} from './modules/organization/organization.controller';
import { OrganizationService } from './modules/organization/organization.service';
import { PlatformAuthController, PlatformController } from './modules/platform-admin/platform.controller';
import { PlatformAuthService } from './modules/platform-admin/platform-auth.service';
import { PlatformService } from './modules/platform-admin/platform.service';
import { RolesController } from './modules/roles/roles.controller';
import { RolesService } from './modules/roles/roles.service';
import { SupportAccessController, TenancyController } from './modules/tenancy/tenancy.controller';
import { AttendanceController, DevicesController, KioskController, ShiftsController, ZkPushController } from './modules/attendance/attendance.controller';
import { AttendanceDaysService } from './modules/attendance/attendance-days.service';
import { AttendanceService } from './modules/attendance/attendance.service';
import { DevicesService } from './modules/attendance/devices.service';
import { ShiftsService } from './modules/attendance/shifts.service';
import { CandidatesService } from './modules/recruitment/candidates.service';
import { CareersService } from './modules/recruitment/careers.service';
import { InterviewsService } from './modules/recruitment/interviews.service';
import { OffersService } from './modules/recruitment/offers.service';
import { CareersPublicController, RecruitmentController, ResumeFilesController } from './modules/recruitment/recruitment.controller';
import { RequisitionsService } from './modules/recruitment/requisitions.service';
import { ExpensesService } from './modules/payroll/expenses.service';
import { PayrollConfigService } from './modules/payroll/payroll-config.service';
import { PayrollRunsService } from './modules/payroll/payroll-runs.service';
import { ExpensesController, PayrollController, PayslipsController, ReceiptFilesController } from './modules/payroll/payroll.controller';
import { PayslipsService } from './modules/payroll/payslips.service';
import { SalariesService } from './modules/payroll/salaries.service';
import { EngagementService } from './modules/talent/engagement.service';
import { GoalsService } from './modules/talent/goals.service';
import { LearningService } from './modules/talent/learning.service';
import { ReviewsService } from './modules/talent/reviews.service';
import { EngagementController, GoalsController, LearningController, ReviewsController } from './modules/talent/talent.controller';
import { AnnouncementsService } from './modules/helpdesk/announcements.service';
import { AnnouncementsController, HelpdeskController } from './modules/helpdesk/helpdesk.controller';
import { HelpdeskService } from './modules/helpdesk/helpdesk.service';
import { MobileController } from './modules/mobile/mobile.controller';
import { AiController } from './modules/ai/ai.controller';
import { AiGatewayService } from './modules/ai/ai-gateway.service';
import { AiService } from './modules/ai/ai.service';
import { AssistantService } from './modules/ai/assistant.service';
import { AutomationController } from './modules/automation/automation.controller';
import { IntegrationsController } from './modules/integrations/integrations.controller';
import { IdentityController } from './modules/identity/identity.controller';
import { ScimController } from './modules/identity/scim.controller';
import { ScimService } from './modules/identity/scim.service';
import { SsoService } from './modules/identity/sso.service';
import { PrivacyController } from './modules/privacy/privacy.controller';
import { PrivacyService } from './modules/privacy/privacy.service';
import { ApiKeysService } from './modules/integrations/api-keys.service';
import { WebhooksService } from './modules/integrations/webhooks.service';
import { ConnectionsService } from './modules/integrations/connections.service';
import { AutomationService } from './modules/automation/automation.service';
import { WorkflowRunnerService } from './modules/automation/workflow-runner.service';
import { InsightsController } from './modules/insights/insights.controller';
import { InsightsService } from './modules/insights/insights.service';
import { MobileService } from './modules/mobile/mobile.service';
import { AuditService } from './platform/audit/audit.service';
import { AuthGuard } from './platform/auth/auth.guard';
import { TokenService } from './platform/auth/token.service';
import { AuthzService } from './platform/authz/authz.service';
import { APP_CONFIG, loadConfig } from './platform/config/config';
import { DatabaseService } from './platform/database/database.service';
import { EntitlementsService } from './platform/entitlements/entitlements.service';
import { OutboxService } from './platform/events/outbox.service';
import { contextMiddleware } from './platform/http/context.middleware';
import { ErrorEnvelopeFilter } from './platform/http/exception.filter';
import { IdempotencyInterceptor } from './platform/http/idempotency.interceptor';
import { MailerService } from './platform/notify/mailer.service';
import { NotificationService } from './platform/notify/notification.service';
import { PushService } from './platform/notify/push.service';
import { StorageService } from './platform/storage/storage.service';

export const CONTROLLERS = [
  HealthController,
  AuthController,
  MeController,
  TenancyController,
  SupportAccessController,
  OrganizationController,
  LegalEntitiesController,
  BusinessUnitsController,
  LocationsController,
  DepartmentsController,
  MembersController,
  RolesController,
  AuditController,
  BillingController,
  DesignationsController,
  EmployeesController,
  OnboardingController,
  DocumentsController,
  LeaveController,
  ApprovalsController,
  NotificationsController,
  PreferencesController,
  ViewsController,
  BidsController,
  ProposalsPublicController,
  IqController,
  UniverseController,
  DashboardController,
  AttendanceController,
  KioskController,
  ShiftsController,
  DevicesController,
  ZkPushController,
  RecruitmentController,
  CareersPublicController,
  ResumeFilesController,
  PayrollController,
  PayslipsController,
  ExpensesController,
  ReceiptFilesController,
  GoalsController,
  ReviewsController,
  LearningController,
  EngagementController,
  HelpdeskController,
  AnnouncementsController,
  MobileController,
  AiController,
  AutomationController,
  IntegrationsController,
  IdentityController,
  ScimController,
  PrivacyController,
  InsightsController,
  PlatformAuthController,
  PlatformController,
];

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: 60_000, limit: Number(process.env.API_RATE_LIMIT_PER_MINUTE ?? 600) }],
      // Rate limits are in-memory per instance for now; switch to Redis storage before running more than one API replica.
      skipIf: () => process.env.CREW_ENV === 'test',
    }),
  ],
  controllers: CONTROLLERS,
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    DatabaseService,
    TokenService,
    AuditService,
    OutboxService,
    AuthzService,
    EntitlementsService,
    AuthService,
    OrganizationService,
    MembersService,
    RolesService,
    BillingService,
    PlatformAuthService,
    PlatformService,
    NotificationService,
    MailerService,
    StorageService,
    ApprovalsService,
    DashboardService,
    BidsService,
    ProposalsPublicService,
    IqService,
    UniverseService,
    OnboardingService,
    LeaveService,
    EmployeesService,
    DocumentsService,
    AttendanceDaysService,
    AttendanceService,
    ShiftsService,
    DevicesService,
    RequisitionsService,
    CandidatesService,
    InterviewsService,
    OffersService,
    CareersService,
    PayrollConfigService,
    SalariesService,
    PayrollRunsService,
    PayslipsService,
    ExpensesService,
    GoalsService,
    ReviewsService,
    LearningService,
    EngagementService,
    HelpdeskService,
    AnnouncementsService,
    MobileService,
    AiGatewayService,
    AiService,
    AssistantService,
    AutomationService,
    WorkflowRunnerService,
    ApiKeysService,
    SsoService,
    ScimService,
    PrivacyService,
    WebhooksService,
    ConnectionsService,
    InsightsService,
    PushService,
    HrJobsService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: ErrorEnvelopeFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(contextMiddleware).forRoutes('*');
  }
}
