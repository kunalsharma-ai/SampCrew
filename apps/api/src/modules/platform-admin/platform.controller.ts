import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  email,
  featureSwitchUpdate,
  integrationTestExtras,
  PLATFORM_INTEGRATION_KEYS,
  type PlatformIntegrationKey,
  memberAccessQuery,
  memberFeatureUpdate,
  activityQuery,
  channelSwitchUpdate,
  deviceIntegrationUpdate,
  devicePauseRequest,
  memberActionRequest,
  platformDevicesQuery,
  platformUsersQuery,
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
import { TenantControlService } from './tenant-control.service';
import { PlatformIntegrationsService } from '../../platform/integrations/platform-integrations.service';

const integrationKey = z.enum(PLATFORM_INTEGRATION_KEYS);
/** The values are checked per integration by PlatformIntegrationsService (each has its own schema). */
const integrationValues = z.record(z.string(), z.unknown());
const integrationTest = integrationTestExtras.extend({ values: integrationValues });

const tenantsQuery = paginationQuery.extend({ status: z.enum(['active', 'suspended', 'closed']).optional() });
const subscriptionOverride = z
  .object({
    planKey: z.enum(['starter', 'professional', 'business', 'enterprise']).optional(),
    status: z.enum(SUBSCRIPTION_STATUSES).optional(),
    seats: z.number().int().min(1).optional(),
    trialEndsOn: z.iso.date().nullable().optional(),
    featureOverrides: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.union([z.boolean(), z.number().int()])).optional(),
    billingCycle: z.enum(['monthly', 'annual']).optional(),
    /** Negotiated price per seat per month, in the subscription's currency. */
    unitPrice: z.string().regex(/^\d{1,8}(\.\d{1,2})?$/, 'A price such as 6.40').optional(),
    currentPeriodEnd: z.iso.date().optional(),
    cancelAtPeriodEnd: z.boolean().optional(),
    /** Plan limits for this customer only (-1 is unlimited); null goes back to the plan's limit. Merged with the module switches. */
    limits: z.partialRecord(z.enum(['max_employees', 'max_legal_entities', 'ai_credits_monthly', 'storage_gb']), z.number().int().min(-1).max(10_000_000).nullable()).optional(),
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
  constructor(private readonly platform: PlatformService, private readonly access: AccessControlsService, private readonly control: TenantControlService) {}

  @PlatformRealm('access:manage')
  @Put('tenants/:id/access/apps')
  @Doc({ summary: 'Switch the Web Portal or the mobile app on or off for a workspace, and modules off in one app only (switching an app off ends its sessions)', body: channelSwitchUpdate })
  switchApps(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(channelSwitchUpdate)) body: z.infer<typeof channelSwitchUpdate>) {
    return this.access.setChannels(id, body);
  }

  @PlatformRealm('access:manage')
  @Get('users')
  @Doc({ summary: 'People in every workspace (account and sign-in details only), with search and status filters', query: platformUsersQuery })
  allUsers(@Query(new ZodPipe(platformUsersQuery)) q: z.infer<typeof platformUsersQuery>) {
    return this.control.users(q);
  }

  @PlatformRealm('access:manage')
  @Get('tenants/:id/users')
  @Doc({ summary: 'People in one workspace (account and sign-in details only)', query: platformUsersQuery })
  tenantUsers(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(platformUsersQuery)) q: z.infer<typeof platformUsersQuery>) {
    return this.control.users({ ...q, tenantId: id });
  }

  @PlatformRealm('access:manage')
  @Post('tenants/:id/users/:membershipId/actions')
  @HttpCode(200)
  @Doc({ summary: 'Suspend, reactivate, sign out, reset two-step verification or resend the invitation of one person (reason required, audited in both trails)', body: memberActionRequest })
  userAction(@Param('id', UuidPipe) id: string, @Param('membershipId', UuidPipe) membershipId: string, @Body(new ZodPipe(memberActionRequest)) body: z.infer<typeof memberActionRequest>) {
    return this.control.userAction(id, membershipId, body.action, body.reason);
  }

  @PlatformRealm('access:manage')
  @Get('tenants/:id/activity')
  @Doc({ summary: 'The workspace\'s activity: what happened, who did it, when and from which app (record contents are not included)', query: activityQuery })
  activity(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(activityQuery)) q: z.infer<typeof activityQuery>) {
    return this.control.activity(id, q);
  }

  @PlatformRealm('tenants:read')
  @Get('devices')
  @Doc({ summary: 'Attendance machines in every workspace with live status', query: platformDevicesQuery })
  allDevices(@Query(new ZodPipe(platformDevicesQuery)) q: z.infer<typeof platformDevicesQuery>) {
    return this.control.devices(q);
  }

  @PlatformRealm('tenants:read')
  @Get('tenants/:id/devices')
  @Doc({ summary: 'Attendance machines of one workspace and the machine integrations it may use' })
  async tenantDevices(@Param('id', UuidPipe) id: string) {
    const [devices, integrations] = await Promise.all([this.control.devices({ tenantId: id }), this.control.deviceIntegrations(id)]);
    return { ...devices, integrations };
  }

  @PlatformRealm('access:manage')
  @Put('tenants/:id/devices/integrations')
  @Doc({ summary: 'Choose which attendance machine integrations a workspace may use (machines of a switched-off integration are refused)', body: deviceIntegrationUpdate })
  setDeviceIntegrations(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(deviceIntegrationUpdate)) body: z.infer<typeof deviceIntegrationUpdate>) {
    return this.control.setDeviceIntegrations(id, body.changes);
  }

  @PlatformRealm('access:manage')
  @Post('tenants/:id/devices/:deviceId/pause')
  @HttpCode(200)
  @Doc({ summary: 'Pause one attendance machine: its pushes are refused and logged until resumed', body: devicePauseRequest })
  pauseDevice(@Param('id', UuidPipe) id: string, @Param('deviceId', UuidPipe) deviceId: string, @Body(new ZodPipe(devicePauseRequest)) body: z.infer<typeof devicePauseRequest>) {
    return this.control.pauseDevice(id, deviceId, body.reason);
  }

  @PlatformRealm('access:manage')
  @Post('tenants/:id/devices/:deviceId/resume')
  @HttpCode(200)
  @Doc({ summary: 'Resume a paused attendance machine' })
  resumeDevice(@Param('id', UuidPipe) id: string, @Param('deviceId', UuidPipe) deviceId: string) {
    return this.control.pauseDevice(id, deviceId, null);
  }

  @PlatformRealm('billing:read')
  @Get('tenants/:id/subscription/history')
  @Doc({ summary: 'Changes SAMPLEDGE made to a workspace\'s subscription, status and modules' })
  subscriptionHistory(@Param('id', UuidPipe) id: string) {
    return this.control.subscriptionHistory(id);
  }

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

/**
 * Installation-wide integrations (Claude AI, email, mobile push, virus scanning, mobile sign-in addresses), set up in
 * the Console instead of the server's environment file. Everyone who can see System health can see them (secrets are
 * never returned); only Super admins can change or test them.
 */
@Controller('platform/integrations')
export class PlatformIntegrationsController {
  constructor(private readonly integrations: PlatformIntegrationsService) {}

  @PlatformRealm('health:read')
  @Get()
  @Doc({ summary: 'Installation-wide integrations: what is in effect, where it comes from (Console or environment) and the last connection test. Secrets show their last characters only.' })
  list() {
    return this.integrations.list();
  }

  @PlatformRealm('integrations:manage')
  @Put(':key')
  @Doc({ summary: 'Save an integration in the Console (it then wins over the environment). Secret fields left empty keep the secret in effect; null removes it.', body: integrationValues })
  save(@Param('key', new ZodPipe(integrationKey)) key: PlatformIntegrationKey, @Body(new ZodPipe(integrationValues)) body: Record<string, unknown>) {
    return this.integrations.save(key, body);
  }

  @PlatformRealm('integrations:manage')
  @Post(':key/test')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Doc({ summary: 'Test the values on screen against the real service without saving them (email can send a test message, push can alert one device)', body: integrationTest })
  test(@Param('key', new ZodPipe(integrationKey)) key: PlatformIntegrationKey, @Body(new ZodPipe(integrationTest)) body: z.infer<typeof integrationTest>) {
    const { values, ...extras } = body;
    return this.integrations.test(key, values, extras);
  }

  @PlatformRealm('integrations:manage')
  @Delete(':key')
  @Doc({ summary: 'Forget the Console setting so the server\'s environment variables apply again' })
  reset(@Param('key', new ZodPipe(integrationKey)) key: PlatformIntegrationKey) {
    return this.integrations.reset(key);
  }
}
