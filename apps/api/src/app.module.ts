import { Logger, type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { SharedRateLimitStorage } from './platform/http/rate-limit-storage';
import { ApprovalsController } from './modules/approvals/approvals.controller';
import { ApprovalsService } from './modules/approvals/approvals.service';
import { AuditController } from './modules/audit/audit.controller';
import { AuthController, MeController, PasswordResetsController } from './modules/auth/auth.controller';
import { PasswordResetService } from './modules/auth/password-reset.service';
import { AuthService } from './modules/auth/auth.service';
import { BillingController, BillingWebhooksController } from './modules/billing/billing.controller';
import { BillingService } from './modules/billing/billing.service';
import { BillingEngine } from './modules/billing/billing-engine.service';
import { BillingJobsService } from './modules/billing/billing-jobs.service';
import { PlatformBillingController } from './modules/billing/platform-billing.controller';
import { PlatformBillingService } from './modules/billing/platform-billing.service';
import { DocumentsController } from './modules/documents/documents.controller';
import { DocumentsService } from './modules/documents/documents.service';
import { DesignationsController, EmployeesController } from './modules/employees/employees.controller';
import { AssetsController, AssetsEmployeeController } from './modules/assets/assets.controller';
import { AssetsService } from './modules/assets/assets.service';
import { BgvController, BgvEmployeeController, BgvPortalController } from './modules/bgv/bgv.controller';
import { BgvService } from './modules/bgv/bgv.service';
import { CustomFieldFilesController, CustomFieldsController } from './modules/custom-fields/custom-fields.controller';
import { CustomFieldsService } from './modules/custom-fields/custom-fields.service';
import { EmployeeImportController, HrAdminController } from './modules/hr-admin/hr-admin.controller';
import { EmployeeImportService } from './modules/hr-admin/employee-import.service';
import { HrAdminService } from './modules/hr-admin/hr-admin.service';
import { HierarchyController } from './modules/hierarchy/hierarchy.controller';
import { WorkspaceLimitsController } from './modules/workspace-limits/workspace-limits.controller';
import { WorkspaceLimitsService } from './modules/workspace-limits/workspace-limits.service';
import { HierarchyService } from './modules/hierarchy/hierarchy.service';
import { FeatureLevelsService } from './modules/hierarchy/feature-levels.service';
import { EmployeesService } from './modules/employees/employees.service';
import { HealthController } from './modules/health/health.controller';
import { HrJobsService } from './modules/hr-jobs/hr-jobs.service';
import { CandidateCrmController } from './modules/candidate-crm/crm.controller';
import { CrmAccessService } from './modules/candidate-crm/crm-access.service';
import { CrmFieldsService } from './modules/candidate-crm/crm-fields.service';
import { CrmImportService } from './modules/candidate-crm/crm-import.service';
import { CrmJobsService } from './modules/candidate-crm/crm-jobs.service';
import { CrmWorkService } from './modules/candidate-crm/crm-work.service';
import { CrmService } from './modules/candidate-crm/crm.service';
import { LateComingController, LeavePenaltiesController } from './modules/discipline/discipline.controller';
import { DisciplineService } from './modules/discipline/discipline.service';
import { LeaveController } from './modules/leave/leave.controller';
import { LeaveService } from './modules/leave/leave.service';
import { MembersController } from './modules/members/members.controller';
import { MembersService } from './modules/members/members.service';
import { DashboardController, DashboardService } from './modules/experience/dashboard.controller';
import { OverviewController, OverviewService } from './modules/experience/overview.controller';
import { PreferencesController } from './modules/experience/preferences.controller';
import { ViewsController } from './modules/experience/views.controller';
import { BidsController, ProposalsPublicController } from './modules/bids/bids.controller';
import { IqController } from './modules/iq/iq.controller';
import { IqService } from './modules/iq/iq.service';
import { ProposalsPublicService } from './modules/bids/proposals-public.service';
import { BidsService } from './modules/bids/bids.service';
import { LensesController } from './modules/universe/lenses.controller';
import { LensesService } from './modules/universe/lenses.service';
import { SkillCatalogueService } from './modules/universe/skill-catalogue.service';
import { UniverseController } from './modules/universe/universe.controller';
import { UniverseService } from './modules/universe/universe.service';
import { NotificationsController } from './modules/notifications/notifications.controller';
import { OnboardingController } from './modules/onboarding/onboarding.controller';
import { OnboardingService } from './modules/onboarding/onboarding.service';
import { TasksController } from './modules/tasks/tasks.controller';
import { ProfileController } from './modules/employees/profile.controller';
import { ProfileService } from './modules/employees/profile.service';
import { WorkspaceController } from './modules/workspace/workspace.controller';
import { WorkspaceService } from './modules/workspace/workspace.service';
import { AppraisalsController } from './modules/talent/appraisals.controller';
import { AppraisalsService } from './modules/talent/appraisals.service';
import { TasksService } from './modules/tasks/tasks.service';
import { SetupController } from './modules/setup/setup.controller';
import { SignatureAgentController, SignaturesController } from './modules/signatures/signatures.controller';
import { SignaturesService } from './modules/signatures/signatures.service';
import { SetupService } from './modules/setup/setup.service';
import {
  BusinessUnitsController,
  DepartmentsController,
  LegalEntitiesController,
  LocationsController,
  OrganizationController,
} from './modules/organization/organization.controller';
import { OrganizationService } from './modules/organization/organization.service';
import { PlatformAuthController, PlatformController, PlatformIntegrationsController, PlatformSetupController } from './modules/platform-admin/platform.controller';
import { FirstRunService } from './modules/platform-admin/first-run.service';
import { PlatformAuthService } from './modules/platform-admin/platform-auth.service';
import { PlatformService } from './modules/platform-admin/platform.service';
import { AccessControlsService } from './modules/platform-admin/access-controls.service';
import { PlatformFeaturesService } from './modules/platform-admin/platform-features.service';
import { PlansService } from './modules/platform-admin/plans.service';
import { StatutoryPacksService } from './modules/platform-admin/statutory-packs.service';
import { TenantControlService } from './modules/platform-admin/tenant-control.service';
import { RolesController } from './modules/roles/roles.controller';
import { RolesService } from './modules/roles/roles.service';
import { SupportAccessController, TenancyController } from './modules/tenancy/tenancy.controller';
import { AttendanceController, DeviceApiController, DevicesController, KioskController, ShiftsController, ZkPushController } from './modules/attendance/attendance.controller';
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
import { EngagementController, GoalsController, LearningController, ReviewsController, TalentPeopleController } from './modules/talent/talent.controller';
import { AnnouncementsService } from './modules/helpdesk/announcements.service';
import { AnnouncementsController, HelpdeskController } from './modules/helpdesk/helpdesk.controller';
import { HelpdeskService } from './modules/helpdesk/helpdesk.service';
import { ChatService } from './modules/communication/chat.service';
import { PlatformSupportChatController, SupportChatController } from './modules/support-chat/support-chat.controller';
import { SupportChatService } from './modules/support-chat/support-chat.service';
import { CommFilesController, CommunicationController } from './modules/communication/communication.controller';
import { CommunicationService } from './modules/communication/communication.service';
import { CommEmailService } from './modules/communication/email.service';
import { CommFilesService } from './modules/communication/files.service';
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
import { ScimGroupsService } from './modules/identity/scim-groups.service';
import { SsoService } from './modules/identity/sso.service';
import { PrivacyController, RetentionController } from './modules/privacy/privacy.controller';
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
import { loadInstanceSecrets } from './platform/config/instance-secrets';
import { MongoService } from './platform/database/mongo.service';
import { EntitlementsService } from './platform/entitlements/entitlements.service';
import { OutboxService } from './platform/events/outbox.service';
import { contextMiddleware } from './platform/http/context.middleware';
import { ErrorEnvelopeFilter } from './platform/http/exception.filter';
import { IdempotencyInterceptor } from './platform/http/idempotency.interceptor';
import { PlatformIntegrationsService } from './platform/integrations/platform-integrations.service';
import { MailerService } from './platform/notify/mailer.service';
import { NotificationService } from './platform/notify/notification.service';
import { LiveService } from './platform/notify/live.service';
import { PushService } from './platform/notify/push.service';
import { StorageService } from './platform/storage/storage.service';

export const CONTROLLERS = [
  HealthController,
  AuthController,
  PasswordResetsController,
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
  BillingWebhooksController,
  DesignationsController,
  // Before EmployeesController, so /employees/import is not read as an employee id.
  EmployeeImportController,
  EmployeesController,
  AssetsController,
  AssetsEmployeeController,
  BgvController,
  BgvEmployeeController,
  BgvPortalController,
  CustomFieldsController,
  CustomFieldFilesController,
  HrAdminController,
  HierarchyController,
  WorkspaceLimitsController,
  OnboardingController,
  TasksController,
  ProfileController,
  WorkspaceController,
  AppraisalsController,
  SetupController,
  SignaturesController,
  SignatureAgentController,
  DocumentsController,
  LeaveController,
  LeavePenaltiesController,
  ApprovalsController,
  NotificationsController,
  PreferencesController,
  ViewsController,
  BidsController,
  ProposalsPublicController,
  IqController,
  UniverseController,
  LensesController,
  DashboardController,
  OverviewController,
  AttendanceController,
  KioskController,
  ShiftsController,
  DevicesController,
  ZkPushController,
  DeviceApiController,
  LateComingController,
  RecruitmentController,
  CandidateCrmController,
  CareersPublicController,
  ResumeFilesController,
  PayrollController,
  PayslipsController,
  ExpensesController,
  ReceiptFilesController,
  GoalsController,
  ReviewsController,
  TalentPeopleController,
  LearningController,
  EngagementController,
  HelpdeskController,
  AnnouncementsController,
  CommunicationController,
  SupportChatController,
  PlatformSupportChatController,
  CommFilesController,
  MobileController,
  AiController,
  AutomationController,
  IntegrationsController,
  IdentityController,
  ScimController,
  PrivacyController,
  RetentionController,
  InsightsController,
  PlatformAuthController,
  PlatformSetupController,
  PlatformController,
  PlatformIntegrationsController,
  PlatformBillingController,
];

@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      // With REDIS_URL the counters are shared by all API servers; without it each server counts on its own, which
      // is only right for a single server (local development, tests, a one-replica install).
      useFactory: () => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: Number(process.env.API_RATE_LIMIT_PER_MINUTE ?? 600) }],
        storage: process.env.REDIS_URL ? new SharedRateLimitStorage(process.env.REDIS_URL) : undefined,
        // Tests switch limits off, except the ones that check them.
        skipIf: () => process.env.CREW_ENV === 'test' && process.env.CREW_TEST_RATE_LIMITS !== 'true',
      }),
    }),
  ],
  controllers: CONTROLLERS,
  providers: [
    // The configuration from the environment (database, addresses, limits) plus the signing keys kept in the database.
    { provide: APP_CONFIG, useFactory: () => loadInstanceSecrets(loadConfig(), (m) => new Logger('Config').warn(m)) },
    MongoService,
    TokenService,
    AuditService,
    OutboxService,
    AuthzService,
    EntitlementsService,
    AuthService,
    PasswordResetService,
    OrganizationService,
    MembersService,
    RolesService,
    BillingService,
    BillingEngine,
    BillingJobsService,
    PlatformBillingService,
    PlatformAuthService,
    PlatformService,
    AccessControlsService,
    PlatformFeaturesService,
    PlansService,
    StatutoryPacksService,
    TenantControlService,
    NotificationService,
    LiveService,
    PlatformIntegrationsService,
    FirstRunService,
    MailerService,
    StorageService,
    ApprovalsService,
    DashboardService,
    OverviewService,
    BidsService,
    ProposalsPublicService,
    IqService,
    UniverseService,
    LensesService,
    SkillCatalogueService,
    OnboardingService,
    TasksService,
    ProfileService,
    WorkspaceService,
    AppraisalsService,
    SetupService,
    SignaturesService,
    LeaveService,
    EmployeesService,
    AssetsService,
    BgvService,
    CustomFieldsService,
    HrAdminService,
    HierarchyService,
    WorkspaceLimitsService,
    FeatureLevelsService,
    EmployeeImportService,
    DocumentsService,
    AttendanceDaysService,
    DisciplineService,
    AttendanceService,
    ShiftsService,
    DevicesService,
    RequisitionsService,
    CandidatesService,
    CrmAccessService,
    CrmFieldsService,
    CrmService,
    CrmWorkService,
    CrmImportService,
    CrmJobsService,
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
    ChatService,
    SupportChatService,
    CommEmailService,
    CommFilesService,
    CommunicationService,
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
    ScimGroupsService,
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
