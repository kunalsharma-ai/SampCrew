import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuditController } from './modules/audit/audit.controller';
import { AuthController, MeController } from './modules/auth/auth.controller';
import { AuthService } from './modules/auth/auth.service';
import { BillingController } from './modules/billing/billing.controller';
import { BillingService } from './modules/billing/billing.service';
import { HealthController } from './modules/health/health.controller';
import { MembersController } from './modules/members/members.controller';
import { MembersService } from './modules/members/members.service';
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
