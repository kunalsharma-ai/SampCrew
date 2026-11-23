import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req, Res } from '@nestjs/common';
import {
  clientBulkAction,
  clientProfileInput,
  clientsQuery,
  commandCenterQuery,
  consoleAuditQuery,
  consoleNotificationPrefsInput,
  consoleNotificationsQuery,
  consoleRoleInput,
  consoleRoleKey,
  consoleSearchQuery,
  consoleSettingsInput,
  CONSOLE_NOTIFICATION_CAP,
  creditNoteVoidInput,
  planDuplicateInput,
  planEntitlementsUpdate,
  planKey,
  planRetireInput,
  platformCreateTenantRequest,
  REPORT_KINDS,
  refundInput,
  reportQuery,
  type ConsoleNotificationCategory,
} from '@crew/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { PlatformRealm } from '../../platform/authz/decorators';
import { requestContext } from '../../platform/context/request-context';
import { contentDisposition } from '../../platform/http/content-disposition';
import { UuidPipe, ZodPipe } from '../../platform/http/zod';
import { LiveService } from '../../platform/notify/live.service';
import { Doc } from '../../platform/openapi/openapi';
import { PlansService } from '../platform-admin/plans.service';
import { CommandCenterService } from './command-center.service';
import { CompaniesService } from './companies.service';
import { ConsoleAuditService } from './console-audit.service';
import { ConsoleNotificationsService } from './console-notifications.service';
import { ConsoleReportsService } from './console-reports.service';
import { ConsoleRolesService } from './console-roles.service';
import { ConsoleSearchService } from './console-search.service';
import { ConsoleSettingsService } from './console-settings.service';
import { PlanImpactService } from './plan-impact.service';
import { RefundsService } from './refunds.service';
import { SystemStatusService } from './system-status.service';
import type { TableFile } from './table-file';
import { ViewAsService } from './view-as.service';

const fileFormat = z.object({ format: z.enum(['csv', 'xlsx', 'pdf']).default('csv') });
const idsInput = z.object({ ids: z.array(z.uuid()).min(1).max(200) }).strict();
const archiveInput = z.object({ archived: z.boolean(), reason: z.string().trim().min(3).max(500) }).strict();
const createClientInput = z.object({ profile: clientProfileInput, workspace: platformCreateTenantRequest }).strict();
const moveInput = z.object({ clientId: z.uuid() }).strict();
const lookupApply = z.object({ fields: z.array(z.enum(['description', 'logo', 'linkedin', 'foundedYear', 'location'])).min(1).max(5) }).strict();
const clientUsersQuery = z.object({ q: z.string().trim().max(120).optional(), status: z.enum(['active', 'invited', 'suspended']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
const feedQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), before: z.iso.datetime().optional() });
const refundsQuery = z.object({ tenantId: z.uuid().optional(), invoiceId: z.uuid().optional(), clientId: z.uuid().optional() });
const viewSection = z.enum(['overview', 'structure', 'users', 'modules', 'activity', 'billing']);
const reportKind = z.enum(REPORT_KINDS);
const HEARTBEAT_MS = 25_000;
const STREAM_MAX_MS = 15 * 60_000;

function send(res: Response, f: TableFile) {
  res.setHeader('content-type', f.type);
  res.setHeader('content-disposition', contentDisposition('attachment', f.fileName));
  res.setHeader('cache-control', 'private, no-store');
  res.send(f.content);
}

/**
 * The Console command center API: dashboard, clients (client companies) and their 360 view, notifications, roles
 * and permissions, global search, reports, audit log, security, refunds, plan lifecycle, system status, settings
 * and the read-only "View as". Every route checks its permission on the server (the role row is read on each
 * request); the Console hides what a role cannot use, but never relies on that.
 */
@Controller('platform')
export class ConsoleController {
  constructor(
    private readonly center: CommandCenterService,
    private readonly companies: CompaniesService,
    private readonly notifications: ConsoleNotificationsService,
    private readonly roles: ConsoleRolesService,
    private readonly search: ConsoleSearchService,
    private readonly reports: ConsoleReportsService,
    private readonly auditLog: ConsoleAuditService,
    private readonly settings: ConsoleSettingsService,
    private readonly refunds: RefundsService,
    private readonly plans: PlansService,
    private readonly impact: PlanImpactService,
    private readonly system: SystemStatusService,
    private readonly viewAs: ViewAsService,
    private readonly live: LiveService,
  ) {}

  // ---- dashboard ------------------------------------------------------------------------------------------------

  @PlatformRealm('tenants:read')
  @Get('command-center')
  @Doc({ summary: 'The Console dashboard for a range: workspace counts, growth, revenue and subscriptions (money only with billing:read), attention items, activity', query: commandCenterQuery })
  commandCenter(@Query(new ZodPipe(commandCenterQuery)) q: z.infer<typeof commandCenterQuery>) {
    return this.center.get(q);
  }

  @PlatformRealm('tenants:read')
  @Get('activity')
  @Doc({ summary: 'The activity feed: new companies, workspaces, users, payments, plan changes, support and security events (by permission)', query: feedQuery })
  activity(@Query(new ZodPipe(feedQuery)) q: z.infer<typeof feedQuery>) {
    return this.center.feed(q.limit, q.before);
  }

  // ---- clients --------------------------------------------------------------------------------------------------

  @PlatformRealm('tenants:read')
  @Get('clients')
  @Doc({ summary: 'Client companies with filters, search, sort and counts per status', query: clientsQuery })
  clients(@Query(new ZodPipe(clientsQuery)) q: z.infer<typeof clientsQuery>) {
    return this.companies.list(q);
  }

  @PlatformRealm('reports:export')
  @Get('clients/export')
  @Doc({ summary: 'The filtered client list as CSV, Excel or PDF (audited)', query: clientsQuery })
  async exportClients(@Query(new ZodPipe(clientsQuery.extend(fileFormat.shape))) q: z.infer<typeof clientsQuery> & { format: 'csv' | 'xlsx' | 'pdf' }, @Res() res: Response) {
    const { format, ...rest } = q;
    send(res, await this.companies.export({ ...rest, limit: 200, offset: 0 }, format) as TableFile);
  }

  @PlatformRealm('tenants:read')
  @Get('clients/options')
  @Doc({ summary: 'Client companies for pickers (id and name)' })
  clientOptions() {
    return this.companies.options();
  }

  @PlatformRealm('tenants:manage')
  @Post('clients')
  @Doc({ summary: 'Create a client company with its first Super Workspace (owner invite, plan, trial)', body: createClientInput })
  createClient(@Body(new ZodPipe(createClientInput)) body: z.infer<typeof createClientInput>) {
    return this.companies.create(body);
  }

  @PlatformRealm('tenants:manage')
  @Post('clients/bulk')
  @HttpCode(200)
  @Doc({ summary: 'Bulk action on selected companies: suspend, activate, tag, assign an account manager', body: clientBulkAction })
  bulk(@Body(new ZodPipe(clientBulkAction)) body: z.infer<typeof clientBulkAction>) {
    return this.companies.bulk(body);
  }

  @PlatformRealm('tenants:read')
  @Get('clients/:id')
  @Doc({ summary: 'Company 360: profile, status, workspaces (Super, HR, Employee), people, subscription and money (by permission), support' })
  client(@Param('id', UuidPipe) id: string) {
    return this.companies.detail(id);
  }

  @PlatformRealm('tenants:manage')
  @Put('clients/:id/profile')
  @Doc({ summary: 'Save the company profile (contact details only with users:pii)', body: clientProfileInput })
  profile(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(clientProfileInput)) body: z.infer<typeof clientProfileInput>) {
    return this.companies.updateProfile(id, body);
  }

  @PlatformRealm('tenants:manage')
  @Post('clients/:id/archive')
  @HttpCode(200)
  @Doc({ summary: 'Archive a company whose Super Workspaces are suspended, or restore it (nothing is deleted)', body: archiveInput })
  archive(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(archiveInput)) body: z.infer<typeof archiveInput>) {
    return this.companies.setArchived(id, body.archived, body.reason);
  }

  @PlatformRealm('tenants:manage')
  @Post('clients/:id/workspaces')
  @Doc({ summary: 'Add another Super Workspace to the company', body: platformCreateTenantRequest })
  addWorkspace(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(platformCreateTenantRequest)) body: z.infer<typeof platformCreateTenantRequest>) {
    return this.companies.addWorkspace(id, body);
  }

  @PlatformRealm('tenants:manage')
  @Put('tenants/:id/client')
  @Doc({ summary: 'Move a Super Workspace to another company', body: moveInput })
  move(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(moveInput)) body: z.infer<typeof moveInput>) {
    return this.companies.moveWorkspace(id, body.clientId);
  }

  @PlatformRealm('users:read')
  @Get('clients/:id/users')
  @Doc({ summary: 'People in every Super Workspace of the company (emails masked without users:pii)', query: clientUsersQuery })
  clientUsers(@Param('id', UuidPipe) id: string, @Query(new ZodPipe(clientUsersQuery)) q: z.infer<typeof clientUsersQuery>) {
    return this.companies.users(id, q);
  }

  @PlatformRealm('tenants:manage')
  @Post('clients/:id/lookup')
  @HttpCode(200)
  @Doc({ summary: 'Look the company up in the company-data integration (Brandfetch) by its website; saves nothing' })
  lookup(@Param('id', UuidPipe) id: string) {
    return this.companies.lookup(id);
  }

  @PlatformRealm('tenants:manage')
  @Post('clients/:id/lookup/apply')
  @HttpCode(200)
  @Doc({ summary: 'Save chosen fields from a fresh Brandfetch lookup, marked with their source', body: lookupApply })
  applyLookup(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(lookupApply)) body: z.infer<typeof lookupApply>) {
    return this.companies.applyLookup(id, body.fields);
  }

  // ---- notifications --------------------------------------------------------------------------------------------

  @PlatformRealm()
  @Get('notifications/summary')
  @Doc({ summary: 'Unread count per category (for the menu badges and the bell), the latest notifications and my preferences' })
  notificationSummary() {
    return this.notifications.summary();
  }

  @PlatformRealm()
  @Get('notifications')
  @Doc({ summary: 'Notification history, newest first, only categories my role allows', query: consoleNotificationsQuery })
  notificationList(@Query(new ZodPipe(consoleNotificationsQuery)) q: z.infer<typeof consoleNotificationsQuery>) {
    return this.notifications.list(q);
  }

  @PlatformRealm()
  @Post('notifications/read')
  @HttpCode(200)
  @Doc({ summary: 'Mark notifications read', body: idsInput })
  markRead(@Body(new ZodPipe(idsInput)) body: z.infer<typeof idsInput>) {
    return this.notifications.markRead(body.ids);
  }

  @PlatformRealm()
  @Post('notifications/unread')
  @HttpCode(200)
  @Doc({ summary: 'Mark notifications unread again', body: idsInput })
  markUnread(@Body(new ZodPipe(idsInput)) body: z.infer<typeof idsInput>) {
    return this.notifications.markUnread(body.ids);
  }

  @PlatformRealm()
  @Post('notifications/read-all')
  @HttpCode(200)
  @Doc({ summary: 'Mark all as read' })
  markAllRead() {
    return this.notifications.markAllRead();
  }

  @PlatformRealm()
  @Put('notifications/preferences')
  @Doc({ summary: 'My notification preferences: muted categories, sound (off by default), desktop notifications', body: consoleNotificationPrefsInput })
  prefs(@Body(new ZodPipe(consoleNotificationPrefsInput)) body: z.infer<typeof consoleNotificationPrefsInput>) {
    return this.notifications.setPrefs(body);
  }

  /** Server-sent events for the whole Console (notifications by permission, support inbox with support:chat). */
  @PlatformRealm()
  @Get('console/stream')
  @Doc({ summary: 'Live Console events (text/event-stream): new notifications my role may see, and support inbox updates when I can chat' })
  stream(@Req() req: Request, @Res() res: Response) {
    const admin = requestContext.platformActor();
    const perms = admin.permissions;
    res.status(200).set({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    const write = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const sub = this.live.subscribeConsole(admin.adminId).subscribe((m) => {
      if (m.type === 'console.notification') {
        const cat = (m.data as { category?: ConsoleNotificationCategory }).category;
        if (cat && perms.includes(CONSOLE_NOTIFICATION_CAP[cat])) write(m.type, { ...m.data, tenantId: m.tenantId });
        return;
      }
      if (perms.includes('support:chat')) write(m.type, { ...m.data, tenantId: m.tenantId });
    });
    write('ready', { at: new Date().toISOString() });
    const beat = setInterval(() => res.write(`: ping\n\n`), HEARTBEAT_MS);
    const end = setTimeout(() => res.end(), STREAM_MAX_MS);
    const close = () => {
      clearInterval(beat);
      clearTimeout(end);
      sub.unsubscribe();
    };
    req.on('close', close);
    res.on('close', close);
  }

  // ---- roles ----------------------------------------------------------------------------------------------------

  @PlatformRealm()
  @Get('roles/mine')
  @Doc({ summary: 'My Console role and its permissions' })
  myRole() {
    return this.roles.mine();
  }

  @PlatformRealm('admins:manage')
  @Get('roles')
  @Doc({ summary: 'Console roles with their permissions and how many admins hold each' })
  roleList() {
    return this.roles.list();
  }

  @PlatformRealm('roles:manage')
  @Post('roles')
  @Doc({ summary: 'Create a custom Console role', body: consoleRoleInput })
  createRole(@Body(new ZodPipe(consoleRoleInput)) body: z.infer<typeof consoleRoleInput>) {
    return this.roles.create(body);
  }

  @PlatformRealm('roles:manage')
  @Put('roles/:key')
  @Doc({ summary: 'Change a role\'s name, description and permissions (Super Admin always has every permission)', body: consoleRoleInput })
  updateRole(@Param('key', new ZodPipe(consoleRoleKey)) key: string, @Body(new ZodPipe(consoleRoleInput)) body: z.infer<typeof consoleRoleInput>) {
    return this.roles.update(key, body);
  }

  @PlatformRealm('roles:manage')
  @Delete('roles/:key')
  @HttpCode(204)
  @Doc({ summary: 'Archive a custom role nobody holds' })
  async archiveRole(@Param('key', new ZodPipe(consoleRoleKey)) key: string) {
    await this.roles.archive(key);
  }

  // ---- search ---------------------------------------------------------------------------------------------------

  @PlatformRealm()
  @Get('search')
  @Doc({ summary: 'Global search across companies, workspaces, users, billing, plans, support, audit and admins (only what my role can open)', query: consoleSearchQuery })
  find(@Query(new ZodPipe(consoleSearchQuery)) q: z.infer<typeof consoleSearchQuery>) {
    return this.search.search(q.q, q.types, q.limit);
  }

  // ---- reports --------------------------------------------------------------------------------------------------

  @PlatformRealm('reports:read')
  @Get('reports/:kind')
  @Doc({ summary: 'A report (business, workspaces, subscriptions, payments) as JSON, or as CSV, Excel or PDF with format (reports:export, audited)', query: reportQuery })
  async report(@Param('kind', new ZodPipe(reportKind)) kind: z.infer<typeof reportKind>, @Query(new ZodPipe(reportQuery)) q: z.infer<typeof reportQuery>, @Res({ passthrough: true }) res: Response) {
    if (q.format === 'json') return this.reports.run(kind, q);
    const f = await this.reports.file(kind, q, q.format);
    send(res, f);
    return undefined;
  }

  // ---- audit and security ---------------------------------------------------------------------------------------

  @PlatformRealm('audit:read')
  @Get('audit-log')
  @Doc({ summary: 'The audit log with filters: before and after values, IP and device', query: consoleAuditQuery })
  audit(@Query(new ZodPipe(consoleAuditQuery)) q: z.infer<typeof consoleAuditQuery>) {
    return this.auditLog.list(q);
  }

  @PlatformRealm('audit:export')
  @Get('audit-log/export')
  @Doc({ summary: 'The filtered audit log as CSV, Excel or PDF (audited)', query: consoleAuditQuery })
  async exportAudit(@Query(new ZodPipe(consoleAuditQuery.extend(fileFormat.shape))) q: z.infer<typeof consoleAuditQuery> & { format: 'csv' | 'xlsx' | 'pdf' }, @Res() res: Response) {
    const { format, ...rest } = q;
    send(res, await this.auditLog.export(rest, format));
  }

  @PlatformRealm('security:manage')
  @Get('security')
  @Doc({ summary: 'Console sessions, sign-in history, suspicious activity and two-step verification coverage' })
  security() {
    return this.auditLog.security();
  }

  @PlatformRealm('security:manage')
  @Post('sessions/:id/revoke')
  @HttpCode(200)
  @Doc({ summary: 'End one Console session now' })
  revokeSession(@Param('id', UuidPipe) id: string) {
    return this.auditLog.revokeSession(id);
  }

  @PlatformRealm('security:manage')
  @Post('admins/:id/sessions/revoke')
  @HttpCode(200)
  @Doc({ summary: 'End every session of one admin (except mine)' })
  revokeAdminSessions(@Param('id', UuidPipe) id: string) {
    return this.auditLog.revokeAdminSessions(id);
  }

  // ---- refunds --------------------------------------------------------------------------------------------------

  @PlatformRealm('billing:read')
  @Get('credit-notes')
  @Doc({ summary: 'Refunds and credit notes, newest first', query: refundsQuery })
  creditNotes(@Query(new ZodPipe(refundsQuery)) q: z.infer<typeof refundsQuery>) {
    return this.refunds.list(q);
  }

  @PlatformRealm('billing:refund')
  @Post('refunds')
  @Doc({ summary: 'Refund all or part of a paid invoice through its gateway or by bank transfer; issues a credit note', body: refundInput })
  refund(@Body(new ZodPipe(refundInput)) body: z.infer<typeof refundInput>) {
    return this.refunds.refund(body);
  }

  @PlatformRealm('billing:refund')
  @Post('credit-notes/:id/void')
  @HttpCode(200)
  @Doc({ summary: 'Void a credit note recorded by mistake (bank transfers only)', body: creditNoteVoidInput })
  voidNote(@Param('id', UuidPipe) id: string, @Body(new ZodPipe(creditNoteVoidInput)) body: z.infer<typeof creditNoteVoidInput>) {
    return this.refunds.voidNote(id, body.reason);
  }

  // ---- plan lifecycle -------------------------------------------------------------------------------------------

  @PlatformRealm('billing:read')
  @Get('plans/:key/impact')
  @Doc({ summary: 'Subscribers, MRR, revenue and billing records of a plan, and whether it can be deleted' })
  planImpact(@Param('key', new ZodPipe(planKey)) key: string) {
    return this.impact.impact(key);
  }

  @PlatformRealm('plans:manage')
  @Post('plans/:key/impact')
  @HttpCode(200)
  @Doc({ summary: 'Preview a change of modules and limits: what subscribers would lose and who is over a lowered limit (saves nothing)', body: planEntitlementsUpdate })
  previewPlan(@Param('key', new ZodPipe(planKey)) key: string, @Body(new ZodPipe(planEntitlementsUpdate)) body: z.infer<typeof planEntitlementsUpdate>) {
    return this.impact.impact(key, body);
  }

  @PlatformRealm('plans:manage')
  @Post('plans/:key/duplicate')
  @Doc({ summary: 'Copy a plan (modules, limits and prices) under a new key; the copy starts hidden', body: planDuplicateInput })
  duplicatePlan(@Param('key', new ZodPipe(planKey)) key: string, @Body(new ZodPipe(planDuplicateInput)) body: z.infer<typeof planDuplicateInput>) {
    return this.plans.create({ key: body.key, name: body.name, copyFrom: key, isPublic: false });
  }

  @PlatformRealm('plans:manage')
  @Post('plans/:key/retire')
  @HttpCode(200)
  @Doc({ summary: 'Retire a plan: closed to new companies and plan changes; subscribers keep it', body: planRetireInput })
  retirePlan(@Param('key', new ZodPipe(planKey)) key: string, @Body(new ZodPipe(planRetireInput)) body: z.infer<typeof planRetireInput>) {
    return this.plans.setRetired(key, true, body.reason);
  }

  @PlatformRealm('plans:manage')
  @Post('plans/:key/unretire')
  @HttpCode(200)
  @Doc({ summary: 'Undo a retirement (the plan stays archived until restored)' })
  unretirePlan(@Param('key', new ZodPipe(planKey)) key: string) {
    return this.plans.setRetired(key, false);
  }

  // ---- system status and settings -------------------------------------------------------------------------------

  @PlatformRealm('health:read')
  @Get('status')
  @Doc({ summary: 'System health as Operational, Warning or Critical per component, with API traffic and errors' })
  status() {
    return this.system.status();
  }

  @PlatformRealm('tenants:read')
  @Get('settings')
  @Doc({ summary: 'Console global settings' })
  getSettings() {
    return this.settings.get();
  }

  @PlatformRealm('settings:manage')
  @Patch('settings')
  @Doc({ summary: 'Save one or more sections of the global settings (audited with before and after)', body: consoleSettingsInput })
  saveSettings(@Body(new ZodPipe(consoleSettingsInput.partial())) body: z.infer<typeof consoleSettingsInput>) {
    return this.settings.update(body);
  }

  // ---- view as --------------------------------------------------------------------------------------------------

  @PlatformRealm('support:request')
  @Get('tenants/:id/view-as')
  @Doc({ summary: 'My approved support access to this Super Workspace, if any: time left and what I can see' })
  viewAsCurrent(@Param('id', UuidPipe) id: string) {
    return this.viewAs.current(id);
  }

  @PlatformRealm('support:request')
  @Get('tenants/:id/view-as/:section')
  @Doc({ summary: 'One read-only section of the workspace during an approved grant (audited in the workspace and the Console)' })
  viewAsSection(@Param('id', UuidPipe) id: string, @Param('section', new ZodPipe(viewSection)) section: z.infer<typeof viewSection>) {
    return this.viewAs.section(id, section);
  }

  @PlatformRealm('support:request')
  @Post('tenants/:id/view-as/exit')
  @HttpCode(200)
  @Doc({ summary: 'Exit: end my support access now' })
  viewAsExit(@Param('id', UuidPipe) id: string) {
    return this.viewAs.exit(id);
  }
}
