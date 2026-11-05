import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  email,
  featureSwitchUpdate,
  memberAccessQuery,
  memberFeatureUpdate,
  permissionSwitchUpdate,
  mfaEnableRequest,
  name,
  paginationQuery,
  password,
  planPriceUpdate,
  platformCreateTenantRequest,
  platformLoginRequest,
  platformTenantStatusRequest,
  PLATFORM_ROLES,
  refreshRequest,
  supportAccessRequest,
  SUBSCRIPTION_STATUSES,
} from '@crew/contracts';
import { z } from 'zod';
import { AllowWithoutMfa, PlatformRealm, Public } from '../../platform/authz/decorators';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { Doc } from '../../platform/openapi/openapi';
import { PlatformAuthService } from './platform-auth.service';
import { PlatformService } from './platform.service';
import { AccessControlsService } from './access-controls.service';

const tenantsQuery = paginationQuery.extend({ status: z.enum(['active', 'suspended', 'closed']).optional() });
const subscriptionOverride = z
  .object({
    planKey: z.enum(['starter', 'professional', 'business', 'enterprise']).optional(),
    status: z.enum(SUBSCRIPTION_STATUSES).optional(),
    seats: z.number().int().min(1).optional(),
    trialEndsOn: z.iso.date().nullable().optional(),
    featureOverrides: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.union([z.boolean(), z.number().int()])).optional(),
  })
  .strict();
const createAdmin = z.object({ email, fullName: name, role: z.enum(PLATFORM_ROLES), password });

@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly auth: PlatformAuthService) {}

  @Public()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  @Doc({ summary: 'SAMPLEDGE staff sign-in (include the authenticator code once MFA is enrolled)', body: platformLoginRequest })
  login(@Body(new ZodPipe(platformLoginRequest)) body: z.infer<typeof platformLoginRequest>) {
    return this.auth.login(body.email, body.password, body.code);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @Doc({ summary: 'Refresh a console session', body: refreshRequest })
  refresh(@Body(new ZodPipe(refreshRequest)) body: z.infer<typeof refreshRequest>) {
    return this.auth.refresh(body.refreshToken);
  }

  @PlatformRealm()
  @AllowWithoutMfa()
  @Post('logout')
  @HttpCode(204)
  @Doc({ summary: 'Sign out of the console' })
  async logout() {
    await this.auth.logout();
  }

  @PlatformRealm()
  @AllowWithoutMfa()
  @Get('me')
  @Doc({ summary: 'Current platform admin' })
  me() {
    return this.auth.me();
  }

  @PlatformRealm()
  @AllowWithoutMfa()
  @Post('mfa/setup')
  @Doc({ summary: 'Start MFA enrolment (mandatory for console access)' })
  mfaSetup() {
    return this.auth.mfaSetup();
  }

  @PlatformRealm()
  @AllowWithoutMfa()
  @Post('mfa/enable')
  @HttpCode(200)
  @Doc({ summary: 'Confirm MFA enrolment and get an MFA-verified console session', body: mfaEnableRequest })
  mfaEnable(@Body(new ZodPipe(mfaEnableRequest)) body: z.infer<typeof mfaEnableRequest>) {
    return this.auth.mfaEnable(body.code);
  }
}

@Controller('platform')
export class PlatformController {
  constructor(private readonly platform: PlatformService, private readonly access: AccessControlsService) {}

  @PlatformRealm('tenants:read')
  @Get('tenants/:id/access')
  @Doc({ summary: 'Modules and permissions for a workspace: plan default, SAMPLEDGE switch and what is in effect' })
  workspaceAccess(@Param('id', UuidPipe) id: string) {
    return this.access.workspace(id);
  }

  @PlatformRealm('access:manage')
  @Put('tenants/:id/access/modules')
  @Doc({ summary: 'Switch modules on or off for a workspace, or back to the plan default', body: featureSwitchUpdate })
  switchModules(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(featureSwitchUpdate)) body: z.infer<typeof featureSwitchUpdate>) {
    return this.access.setFeatures(id, body.changes);
  }

  @PlatformRealm('access:manage')
  @Put('tenants/:id/access/permissions')
  @Doc({ summary: 'Switch permissions on or off for every role in a workspace', body: permissionSwitchUpdate })
  switchPermissions(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(permissionSwitchUpdate)) body: z.infer<typeof permissionSwitchUpdate>) {
    return this.access.setPermissions(id, body.changes);
  }

  @PlatformRealm('access:manage')
  @Get('tenants/:id/access/members')
  @Doc({ summary: 'Members of a workspace (account details only) with the modules each one is blocked from', query: memberAccessQuery })
  memberAccess(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(memberAccessQuery)) q: z.infer<typeof memberAccessQuery>) {
    return this.access.members(id, q);
  }

  @PlatformRealm('access:manage')
  @Put('tenants/:id/access/members/:membershipId')
  @Doc({ summary: 'Choose which modules one member may use (list the modules to block; empty restores full access)', body: memberFeatureUpdate })
  setMemberAccess(@Param('id', UuidPipe) id: string, @Param('membershipId', UuidPipe) membershipId: string, @Body(new ZodPipe(memberFeatureUpdate)) body: z.infer<typeof memberFeatureUpdate>) {
    return this.access.setMemberFeatures(id, membershipId, body.blockedFeatures);
  }

  @PlatformRealm('tenants:read')
  @Get('metrics')
  @Doc({ summary: 'Platform KPIs: tenants, subscriptions, MRR, trials ending, sign-ups' })
  metrics() {
    return this.platform.metrics();
  }

  @PlatformRealm('tenants:read')
  @Get('tenants')
  @Doc({ summary: 'List tenants', query: tenantsQuery })
  tenants(@Query(new ZodPipe(tenantsQuery)) q: z.infer<typeof tenantsQuery>) {
    return this.platform.tenants(q);
  }

  @PlatformRealm('tenants:manage')
  @Post('tenants')
  @Doc({ summary: 'Create a tenant for a customer (sales-assisted onboarding); the owner receives an invitation', body: platformCreateTenantRequest })
  create(@Body(new ZodPipe(platformCreateTenantRequest)) body: z.infer<typeof platformCreateTenantRequest>) {
    return this.platform.createTenant(body);
  }

  @PlatformRealm('tenants:read')
  @Get('tenants/:id')
  @Doc({ summary: 'Tenant detail: subscription, usage, support access history' })
  tenant(@Param('id', UuidPipe) id: string) {
    return this.platform.tenant(id);
  }

  @PlatformRealm('tenants:manage')
  @Patch('tenants/:id/status')
  @Doc({ summary: 'Suspend or reactivate a tenant (suspension signs everyone out)', body: platformTenantStatusRequest })
  status(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(platformTenantStatusRequest)) body: z.infer<typeof platformTenantStatusRequest>) {
    return this.platform.setStatus(id, body.status, body.reason);
  }

  @PlatformRealm('billing:manage')
  @Put('tenants/:id/subscription')
  @Doc({ summary: 'Override plan, status, seats, trial end or individual feature entitlements', body: subscriptionOverride })
  subscription(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(subscriptionOverride)) body: z.infer<typeof subscriptionOverride>) {
    return this.platform.overrideSubscription(id, body);
  }

  @PlatformRealm('support:request')
  @Post('tenants/:id/support-access')
  @Doc({ summary: 'Request time-boxed support access; the customer must approve', body: supportAccessRequest })
  supportAccess(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(supportAccessRequest)) body: z.infer<typeof supportAccessRequest>) {
    return this.platform.requestSupportAccess(id, body.reason, body.durationMinutes);
  }

  @PlatformRealm('support:request')
  @Get('tenants/:id/support-view')
  @Doc({ summary: 'Read-only workspace snapshot during an approved support grant (audited in the customer\'s trail)' })
  supportView(@Param('id', UuidPipe) id: string) {
    return this.platform.supportView(id);
  }

  @PlatformRealm('billing:read')
  @Get('plans')
  @Doc({ summary: 'Plans with prices, entitlements and tenant counts' })
  plans() {
    return this.platform.plans();
  }

  @PlatformRealm('plans:manage')
  @Put('plans/:key/prices')
  @Doc({ summary: 'Set a plan\'s per-seat price in a currency', body: planPriceUpdate })
  price(@Param('key') key: string, @Body(new ZodPipe(planPriceUpdate)) body: z.infer<typeof planPriceUpdate>) {
    return this.platform.setPrice(key, body);
  }

  @PlatformRealm('health:read')
  @Get('health')
  @Doc({ summary: 'System health: API, database, migrations, outbox backlog, audit chain' })
  health() {
    return this.platform.health();
  }

  @PlatformRealm('audit:read')
  @Get('audit')
  @Doc({ summary: 'Platform-level audit trail' })
  audit() {
    return this.platform.platformAudit();
  }

  @PlatformRealm('admins:manage')
  @Get('admins')
  @Doc({ summary: 'List SAMPLEDGE platform admins' })
  admins() {
    return this.platform.admins();
  }

  @PlatformRealm('admins:manage')
  @Post('admins')
  @Doc({ summary: 'Create a platform admin (they must enrol MFA at first sign-in)', body: createAdmin })
  createAdmin(@Body(new ZodPipe(createAdmin)) body: z.infer<typeof createAdmin>) {
    return this.platform.createAdmin(body);
  }
}
