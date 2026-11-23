import { Injectable } from '@nestjs/common';
import {
  CONSOLE_TEAM_NAME,
  HELP_AUDIENCE_LABEL,
  HELP_OTHER_CATEGORY,
  HELP_QUERY_STATUS_LABEL,
  HELP_QUERY_STATUSES,
  HELP_ROUTE_LABEL,
  helpTicketId,
  type HelpAudience,
  type HelpFileView,
  type HelpQueryDetail,
  type HelpQueryInput,
  type HelpQueryList,
  type HelpQueryListQuery,
  type HelpQueryMessageView,
  type HelpQueryStatus,
  type HelpQueryView,
  type HelpReplyInput,
  type HelpRoute,
} from '@crew/contracts';
import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import type { Subject } from '../../platform/authz/policy';
import { requestContext } from '../../platform/context/request-context';
import { ilike, MongoService as DatabaseService, PlatformTx, type TenantTx, usersTable } from '../../platform/database/mongo.service';
import { EntitlementsService } from '../../platform/entitlements/entitlements.service';
import { Errors } from '../../platform/http/errors';
import { NotificationService } from '../../platform/notify/notification.service';
import { StorageService } from '../../platform/storage/storage.service';
import { CommFilesService } from '../communication/files.service';
import { memberIdentities, superWorkspaceMembers } from '../communication/identity';
import type { UploadedFile } from '../documents/documents.service';
import { HelpContentService } from './help-content.service';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Doc = Record<string, any>;
type AnyTx = TenantTx | PlatformTx;

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const at = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);
const preview = (s: string) => s.replace(/\s+/g, ' ').slice(0, 140);
const DAY = 86_400_000;

/** Web Portal links: the raiser follows a query in My queries, handlers answer it in the inbox. */
export const myQueryLink = (id: string) => `/help/queries/${id}`;
export const inboxQueryLink = (id: string) => `/help/inbox/${id}`;

/** What the person looking at a query is to it. */
interface Role {
  raiser: boolean;
  handler: boolean;
  membershipId: string | null;
  adminId: string | null;
}

/** A workspace member's level and the HR Workspaces they run (company-wide HR names none). */
interface Reach {
  level: Exclude<HelpAudience, 'console'>;
  companyHr: boolean;
  hrWorkspaceIds: string[];
}

function reachOf(subject: Subject): Reach {
  const level = HelpContentService.levelOf(subject);
  const hr = subject.grants.filter((g) => g.roleKey === 'hr_workspace');
  return {
    level,
    companyHr: hr.some((g) => !g.constraints.hrWorkspaceIds?.length),
    hrWorkspaceIds: [...new Set(hr.flatMap((g) => g.constraints.hrWorkspaceIds ?? []))],
  };
}

/** Whether a workspace member handles a query: the Super Workspace handles hr and super routes; HR its own HR Workspaces. */
function handles(r: Reach, q: Doc): boolean {
  if (q.route === 'console') return false;
  if (r.level === 'super') return true;
  if (q.route !== 'hr' || r.level !== 'hr') return false;
  if (r.companyHr) return true;
  return !!q.hr_workspace_id && r.hrWorkspaceIds.includes(q.hr_workspace_id);
}

/**
 * Raise a Query and the support work behind it. A query belongs to the company of the person who raised it and goes
 * to the level above them; the Console Admin team answers Super Workspace queries (and any query escalated to it)
 * from the Console. Every change is audited, and the raiser is notified of each reply and status change.
 */
@Injectable()
export class HelpQueriesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly entitlements: EntitlementsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly files: CommFilesService,
    private readonly storage: StorageService,
    private readonly content: HelpContentService,
  ) {}

  // ------------------------------------------------------------------------------------------- routing

  /** Active members on the HR Workspace level who look after this HR Workspace (null: company-wide HR only). */
  private async hrHandlers(tx: AnyTx, tenantId: string, hrWorkspaceId: string | null): Promise<string[]> {
    const role = await tx.collection('roles').findOne({ tenant_id: tenantId, is_system: true, key: 'hr_workspace' }, { projection: { _id: 1 } });
    if (!role) return [];
    const rows = await tx.collection('role_assignments').find({ tenant_id: tenantId, role_id: role.id }, { projection: { membership_id: 1, constraints: 1 } });
    const ids = rows.filter((r) => {
      const named = (r.constraints?.hrWorkspaceIds as string[] | undefined) ?? [];
      return !named.length || (!!hrWorkspaceId && named.includes(hrWorkspaceId));
    }).map((r) => r.membership_id as string);
    if (!ids.length) return [];
    return tx.collection('memberships').distinct<string>('id', { tenant_id: tenantId, id: { $in: [...new Set(ids)] }, status: 'active' });
  }

  /** Who is told about a new or updated query on the handling side (Console: nobody in the workspace). */
  private async handlerMembers(tx: AnyTx, q: Doc): Promise<string[]> {
    if (q.route === 'console') return [];
    if (q.route === 'super') return superWorkspaceMembers(tx, q.tenant_id);
    return this.hrHandlers(tx, q.tenant_id, q.hr_workspace_id ?? null);
  }

  /** Where a new query goes, from the raiser's level. An employee whose HR team has nobody in it goes to the Super Workspace. */
  private async routeFor(tx: TenantTx, reach: Reach, membershipId: string, toConsole: boolean): Promise<{ route: HelpRoute; hrWorkspaceId: string | null }> {
    if (toConsole || reach.level === 'super') return { route: 'console', hrWorkspaceId: null };
    if (reach.level === 'hr') return { route: 'super', hrWorkspaceId: null };
    const emp = await tx.collection('employees').findOne({ membership_id: membershipId }, { projection: { hr_workspace_id: 1 } });
    let hrWorkspaceId = (emp?.hr_workspace_id as string | null) ?? null;
    if (hrWorkspaceId && !(await tx.collection('hr_workspaces').exists({ id: hrWorkspaceId, status: 'active' }))) hrWorkspaceId = null;
    const handlers = (await this.hrHandlers(tx, tx.tenantId, hrWorkspaceId)).filter((m) => m !== membershipId);
    if (!handlers.length) return { route: 'super', hrWorkspaceId: null };
    return { route: 'hr', hrWorkspaceId };
  }

  // ------------------------------------------------------------------------------------------- views

  private async fileViews(tx: AnyTx, tenantId: string, ids: string[], queryId: string, side: 'web' | 'console'): Promise<Map<string, HelpFileView>> {
    if (!ids.length) return new Map();
    const rows = await tx.collection('comm_files').find({ tenant_id: tenantId, id: { $in: ids } }, { projection: { name: 1, type: 1, size: 1 } });
    const href = (id: string) => (side === 'console' ? `/help-files/${queryId}/${id}` : `/help-files/${queryId}/${id}`);
    return new Map(rows.map((f) => [f.id as string, { id: f.id, name: f.name, type: f.type, size: f.size, href: href(f.id) }]));
  }

  private async views(tx: AnyTx, rows: Doc[], role: (q: Doc) => Role, settings: { reopenDays: number; escalation: boolean }): Promise<HelpQueryView[]> {
    if (!rows.length) return [];
    const tenantIds = [...new Set(rows.map((q) => q.tenant_id as string))];
    const tenants = new Map((await tx.collection('tenants').find({ id: { $in: tenantIds } }, { projection: { name: 1 } })).map((t) => [t.id as string, t.name as string]));
    const spaceIds = rows.map((q) => q.hr_workspace_id).filter(Boolean);
    const spaces = new Map((spaceIds.length ? await tx.collection('hr_workspaces').find({ id: { $in: spaceIds } }, { projection: { name: 1 } }) : []).map((w) => [w.id as string, w.name as string]));
    const adminIds = rows.map((q) => q.assignee_admin_id).filter(Boolean);
    const memberNames = new Map<string, string>();
    for (const tid of tenantIds) {
      const ms = rows.filter((q) => q.tenant_id === tid && q.assignee_membership_id).map((q) => q.assignee_membership_id as string);
      if (!ms.length) continue;
      const mem = await tx.collection('memberships').find({ tenant_id: tid, id: { $in: ms } }, { projection: { user_id: 1 } });
      const users = new Map((await (await usersTable(tx)).find({ id: { $in: mem.map((m) => m.user_id) } }, { projection: { full_name: 1 } })).map((u) => [u.id as string, u.full_name as string]));
      for (const m of mem) memberNames.set(m.id as string, users.get(m.user_id) ?? 'Unnamed');
    }
    // Console Admins' names are for the Console; a workspace sees the team's name.
    const admins = new Map((adminIds.length && tx instanceof PlatformTx ? await tx.collection('platform_admins').find({ id: { $in: adminIds } }, { projection: { full_name: 1 } }) : []).map((a) => [a.id as string, a.full_name as string]));
    return rows.map((q) => {
      const r = role(q);
      const status = q.status as HelpQueryStatus;
      const reopenUntil = q.resolved_at ? at(q.resolved_at) + settings.reopenDays * DAY : 0;
      const seen = r.raiser ? at(q.raiser_seen_at) : at(q.handler_seen_at);
      const theirs = r.raiser ? at(q.last_handler_message_at) : at(q.last_raiser_message_at);
      return {
        id: q.id, ticketId: helpTicketId(q.number), number: q.number, subject: q.subject, description: q.description,
        category: { key: q.category_key, label: q.category_label }, page: q.page ?? null, feature: q.feature ?? null,
        status, statusLabel: HELP_QUERY_STATUS_LABEL[status], route: q.route, routeLabel: HELP_ROUTE_LABEL[q.route as HelpRoute],
        hrWorkspace: q.hr_workspace_id ? { id: q.hr_workspace_id, name: spaces.get(q.hr_workspace_id) ?? 'HR Workspace' } : null,
        raisedBy: { name: q.raiser_name, level: q.raiser_level, levelLabel: HELP_AUDIENCE_LABEL[q.raiser_level as HelpAudience], workspace: q.raiser_workspace ?? null, email: q.raiser_email ?? null, phone: q.raiser_phone ?? null },
        assignee: q.assignee_membership_id ? { id: q.assignee_membership_id, name: memberNames.get(q.assignee_membership_id) ?? 'Unnamed' } : q.assignee_admin_id ? { id: q.assignee_admin_id, name: admins.get(q.assignee_admin_id) ?? CONSOLE_TEAM_NAME } : null,
        workspace: { id: q.tenant_id, name: tenants.get(q.tenant_id) ?? 'Workspace' },
        lastMessageAt: iso(q.last_message_at ?? q.created_at)!, createdAt: iso(q.created_at)!, updatedAt: iso(q.updated_at ?? q.created_at)!, resolvedAt: iso(q.resolved_at),
        unread: theirs > seen,
        rating: (q.rating as number | null) ?? null,
        can: {
          reply: (r.raiser || r.handler) && status !== 'closed',
          reopen: r.raiser && status === 'resolved' && settings.reopenDays > 0 && Date.now() <= reopenUntil,
          close: (r.raiser || r.handler) && status !== 'closed',
          rate: r.raiser && (status === 'resolved' || status === 'closed') && !q.rating,
          handle: r.handler,
          escalate: r.handler && settings.escalation && q.route !== 'console' && status !== 'closed',
        },
      };
    });
  }

  private async messageViews(tx: AnyTx, q: Doc, role: Role, side: 'web' | 'console'): Promise<HelpQueryMessageView[]> {
    const rows = await tx.collection('help_query_messages').find({ tenant_id: q.tenant_id, query_id: q.id, ...(role.raiser && !role.handler ? { kind: { $ne: 'note' } } : {}) }, { sort: { created_at: 1 }, limit: 500 });
    const files = await this.fileViews(tx, q.tenant_id, rows.flatMap((m) => (m.file_ids as string[]) ?? []), q.id, side);
    return rows.map((m) => ({
      id: m.id, kind: m.kind, body: m.body,
      author: m.author_name ? { name: m.author_name, level: m.author_level, levelLabel: HELP_AUDIENCE_LABEL[m.author_level as HelpAudience] ?? '', workspace: m.author_workspace ?? null } : null,
      fromRaiser: !!m.author_membership_id && m.author_membership_id === q.raised_by_membership_id,
      mine: (role.membershipId && m.author_membership_id === role.membershipId) || (role.adminId && m.author_admin_id === role.adminId) ? true : false,
      files: ((m.file_ids as string[]) ?? []).map((id) => files.get(id)).filter((f): f is HelpFileView => !!f),
      createdAt: iso(m.created_at)!,
    }));
  }

  private async detail(tx: AnyTx, q: Doc, role: Role, side: 'web' | 'console'): Promise<HelpQueryDetail> {
    const settings = await this.content.settingsIn(tx);
    const [view] = await this.views(tx, [q], () => role, settings);
    const files = await this.fileViews(tx, q.tenant_id, (q.file_ids as string[]) ?? [], q.id, side);
    let assignees: { id: string; name: string }[] = [];
    if (role.handler) {
      if (q.route === 'console') {
        const admins = await tx.collection('platform_admins').find({ status: 'active', role: { $in: ['super_admin', 'support'] } }, { projection: { full_name: 1 }, sort: { full_name: 1 } });
        assignees = admins.map((a) => ({ id: a.id, name: a.full_name }));
      } else {
        const ids = [...new Set([...(await this.handlerMembers(tx, q)), ...(q.route === 'hr' ? await superWorkspaceMembers(tx, q.tenant_id) : [])])];
        const ident = await memberIdentities(tx as TenantTx, ids);
        assignees = ids.map((id) => ({ id, name: ident.get(id)?.name ?? 'Unnamed' })).sort((x, y) => x.name.localeCompare(y.name));
      }
    }
    const article = q.article_id ? await tx.collection('help_articles').findOne({ id: q.article_id }, { projection: { title: 1 } }) : undefined;
    return {
      ...view!,
      messages: await this.messageViews(tx, q, role, side),
      files: ((q.file_ids as string[]) ?? []).map((id) => files.get(id)).filter((f): f is HelpFileView => !!f),
      assignees,
      article: article ? { id: article.id, title: article.title } : null,
    };
  }

  private counts(rows: Doc[]): HelpQueryList['counts'] {
    const out = { all: rows.length } as HelpQueryList['counts'];
    for (const s of HELP_QUERY_STATUSES) out[s] = 0;
    for (const q of rows) out[q.status as HelpQueryStatus] += 1;
    return out;
  }

  private filter(rows: Doc[], q: HelpQueryListQuery, me: string | null) {
    const needle = q.q?.toLowerCase().trim();
    return rows.filter((r) =>
      (!q.status || r.status === q.status)
      && (!q.assigned || (q.assigned === 'none' ? !r.assignee_membership_id && !r.assignee_admin_id : (r.assignee_membership_id ?? r.assignee_admin_id) === me))
      && (!needle || [r.subject, r.description, r.raiser_name, r.category_label, helpTicketId(r.number), String(r.number)].some((f) => String(f ?? '').toLowerCase().includes(needle))));
  }

  // ------------------------------------------------------------------------------------------- messages, events, notices

  private async addMessage(tx: AnyTx, q: Doc, m: { kind: 'message' | 'note' | 'event'; body: string; authorKind: 'member' | 'console' | 'system'; membershipId?: string | null; adminId?: string | null; name?: string | null; level?: string | null; workspace?: string | null; fileIds?: string[]; clientId?: string }) {
    return tx.collection('help_query_messages').insert({
      tenant_id: q.tenant_id, query_id: q.id, kind: m.kind, body: m.body, author_kind: m.authorKind,
      author_membership_id: m.membershipId ?? null, author_admin_id: m.adminId ?? null, author_name: m.name ?? null, author_level: m.level ?? null,
      author_workspace: m.workspace ?? null, file_ids: m.fileIds ?? [], client_id: m.clientId ?? null,
    });
  }

  private async tellRaiser(tx: AnyTx, q: Doc, kind: string, title: string, body?: string) {
    if (!q.raised_by_membership_id) return;
    await this.notifications.notify(tx, {
      membershipIds: [q.raised_by_membership_id], kind, category: 'communication', title, body, link: myQueryLink(q.id),
      dedupeKey: `help:${q.id}:raiser`, resource: { type: 'help_query', id: q.id }, email: true,
    });
    await tx.collection('live_events').insert({ tenant_id: q.tenant_id, membership_ids: [q.raised_by_membership_id], type: 'help.query', data: { queryId: q.id } });
  }

  private async tellHandlers(tx: AnyTx, q: Doc, kind: string, title: string, body?: string, except?: string | null) {
    if (q.route === 'console') {
      await tx.collection('live_events').insert({ tenant_id: q.tenant_id, membership_ids: [], console: true, type: 'help.query', data: { queryId: q.id } });
      return;
    }
    const to = (q.assignee_membership_id ? [q.assignee_membership_id as string] : await this.handlerMembers(tx, q)).filter((m) => m !== except);
    if (!to.length) return;
    await this.notifications.notify(tx, {
      membershipIds: to, kind, category: 'communication', title, body, link: inboxQueryLink(q.id),
      dedupeKey: `help:${q.id}:handlers`, resource: { type: 'help_query', id: q.id },
    });
    await tx.collection('live_events').insert({ tenant_id: q.tenant_id, membership_ids: to, type: 'help.query', data: { queryId: q.id } });
  }

  private async checkFiles(tx: TenantTx, fileIds: string[], membershipId: string) {
    if (!fileIds.length) return;
    const settings = await this.content.settingsIn(tx);
    if (!settings.attachments) throw Errors.badRequest('attachments_off', 'Attachments are switched off for help queries');
    const mine = await tx.collection('comm_files').count({ id: { $in: fileIds }, uploaded_by_membership_id: membershipId });
    if (mine !== new Set(fileIds).size) throw Errors.badRequest('invalid_file', 'Attach files you uploaded yourself');
  }

  // ------------------------------------------------------------------------------------------- workspace side

  private async me(tx: TenantTx) {
    const actor = requestContext.tenantActor();
    const subject = await this.authz.subject(tx);
    return { membershipId: actor.membershipId, reach: reachOf(subject) };
  }

  private async features(tx: TenantTx) {
    return (await this.entitlements.current(tx)).features;
  }

  /** The query, if the caller raised it or handles it; anyone else gets "not found". */
  private async visibleQuery(tx: TenantTx, id: string) {
    const me = await this.me(tx);
    const q = await tx.collection('help_queries').findOne({ id });
    if (!q) throw Errors.notFound('Query');
    const raiser = q.raised_by_membership_id === me.membershipId;
    // Handling needs the inbox part too (a level whose inbox is switched off only follows its own queries).
    const handler = handles(me.reach, q) && (await this.features(tx)).has('core_hr.help_inbox');
    if (!raiser && !handler) throw Errors.notFound('Query');
    return { q, me, role: { raiser, handler, membershipId: me.membershipId, adminId: null } satisfies Role };
  }

  queryCategories() {
    return this.db.tenant(async (tx) => ({ items: await this.content.queryCategoriesIn(tx), settings: await this.content.settingsIn(tx) }));
  }

  /** The raiser's contact details, filled in on the form from their account. */
  contact() {
    return this.db.tenant(async (tx) => {
      const { membershipId, reach } = await this.me(tx);
      const ident = (await memberIdentities(tx, [membershipId])).get(membershipId);
      const emp = await tx.collection('employees').findOne({ membership_id: membershipId }, { projection: { phone: 1 } });
      const route = await this.routeFor(tx, reach, membershipId, false);
      const space = route.hrWorkspaceId ? await tx.collection('hr_workspaces').findOne({ id: route.hrWorkspaceId }, { projection: { name: 1 } }) : undefined;
      return {
        name: ident?.name ?? 'Unnamed', email: ident?.email ?? null, phone: (emp?.phone as string | undefined) ?? null,
        level: reach.level, levelLabel: HELP_AUDIENCE_LABEL[reach.level], workspace: ident?.workspace ?? null,
        routesTo: route.route === 'hr' ? `${space?.name ?? 'Your company'} HR Workspace` : HELP_ROUTE_LABEL[route.route],
      };
    });
  }

  upload(file: UploadedFile | undefined) {
    return this.files.upload(file);
  }

  raise(input: HelpQueryInput) {
    return this.db.tenant(async (tx) => {
      const { membershipId, reach } = await this.me(tx);
      if (input.clientId) {
        const dup = await tx.collection('help_queries').findOne({ raised_by_membership_id: membershipId, client_id: input.clientId });
        if (dup) return { id: dup.id as string, ticketId: helpTicketId(dup.number), number: dup.number as number, created: false, routeLabel: HELP_ROUTE_LABEL[dup.route as HelpRoute] };
      }
      const cat = await tx.collection('help_query_categories').findOne({ key: input.categoryKey, active: true, deleted_at: null });
      if (!cat) throw Errors.badRequest('invalid_category', 'Choose one of the categories, or Other');
      await this.checkFiles(tx, input.fileIds, membershipId);
      if (input.articleId && !(await tx.collection('help_articles').exists({ id: input.articleId }))) throw Errors.badRequest('invalid_article', 'That help article does not exist');
      const ident = (await memberIdentities(tx, [membershipId])).get(membershipId);
      const route = await this.routeFor(tx, reach, membershipId, !!cat.to_console && cat.key !== HELP_OTHER_CATEGORY);
      const last = await tx.collection('help_queries').findOne({}, { sort: { number: -1 }, projection: { number: 1 } });
      const number = ((last?.number as number | undefined) ?? 0) + 1;
      const now = new Date();
      const q = await tx.collection('help_queries').insert({
        tenant_id: tx.tenantId, number, subject: input.subject, description: input.description, category_key: cat.key, category_label: cat.label,
        page: input.page, feature: input.feature, article_id: input.articleId, route: route.route, hr_workspace_id: route.hrWorkspaceId, status: 'open',
        raised_by_membership_id: membershipId, raiser_name: ident?.name ?? 'Unnamed', raiser_level: reach.level, raiser_workspace: ident?.workspace ?? null,
        raiser_email: ident?.email ?? null, raiser_phone: input.contactPhone, file_ids: input.fileIds, client_id: input.clientId ?? null,
        last_message_at: now, last_raiser_message_at: now, raiser_seen_at: now,
      });
      const ticket = helpTicketId(number);
      await this.addMessage(tx, q, { kind: 'event', authorKind: 'system', body: `Query raised and sent to ${route.route === 'hr' ? 'the HR Workspace' : HELP_ROUTE_LABEL[route.route]}` });
      await this.audit.record(tx, { action: 'help.query_raised', resourceType: 'help_query', resourceId: q.id, changes: { ticket, category: cat.key, route: route.route } });
      await this.notifications.notify(tx, {
        membershipIds: [membershipId], kind: 'help.query_submitted', category: 'communication', title: `Query ${ticket} received: ${input.subject}`,
        body: `We sent it to ${route.route === 'hr' ? 'your HR Workspace' : HELP_ROUTE_LABEL[route.route]}. You will be notified of every reply.`, link: myQueryLink(q.id),
        resource: { type: 'help_query', id: q.id },
      });
      await this.tellHandlers(tx, q, 'help.query_new', `New query ${ticket} from ${q.raiser_name}: ${input.subject}`, preview(input.description), membershipId);
      return { id: q.id as string, ticketId: ticket, number, created: true, routeLabel: route.route === 'hr' ? 'your HR Workspace' : HELP_ROUTE_LABEL[route.route] };
    });
  }

  mine(query: HelpQueryListQuery) {
    return this.db.tenant(async (tx) => {
      const { membershipId } = await this.me(tx);
      const rows = await tx.collection('help_queries').find({ raised_by_membership_id: membershipId }, { sort: { last_message_at: -1 }, limit: 500 });
      const settings = await this.content.settingsIn(tx);
      const items = await this.views(tx, this.filter(rows, query, membershipId), () => ({ raiser: true, handler: false, membershipId, adminId: null }), settings);
      return { items, counts: this.counts(rows) } satisfies HelpQueryList;
    });
  }

  inbox(query: HelpQueryListQuery) {
    return this.db.tenant(async (tx) => {
      const { membershipId, reach } = await this.me(tx);
      if (reach.level === 'employee') throw Errors.forbidden('The queries inbox is for the HR Workspace and the Super Workspace');
      const filter: Doc = reach.level === 'super'
        ? { route: { $in: ['hr', 'super'] } }
        : reach.companyHr ? { route: 'hr' } : { route: 'hr', hr_workspace_id: { $in: reach.hrWorkspaceIds } };
      const rows = (await tx.collection('help_queries').find(filter, { sort: { last_message_at: -1 }, limit: 1000 })).filter((q) => q.raised_by_membership_id !== membershipId);
      const settings = await this.content.settingsIn(tx);
      const items = await this.views(tx, this.filter(rows, query, membershipId), (q) => ({ raiser: false, handler: handles(reach, q), membershipId, adminId: null }), settings);
      const waiting = rows.filter((q) => q.status === 'open' || (q.status === 'in_progress' && at(q.last_raiser_message_at) > at(q.last_handler_message_at))).length;
      return { items, counts: this.counts(rows), waiting };
    });
  }

  /** Numbers for the help centre home: open queries of mine, and whether I have an inbox with queries waiting. */
  async summaryIn(tx: TenantTx): Promise<{ raise: boolean; open: number; inbox: boolean; waiting: number }> {
    const { membershipId, reach } = await this.me(tx);
    const features = await this.features(tx);
    const raise = features.has('core_hr.help_queries');
    const open = raise ? await tx.collection('help_queries').count({ raised_by_membership_id: membershipId, status: { $in: ['open', 'in_progress', 'awaiting_user'] } }) : 0;
    const inbox = reach.level !== 'employee' && features.has('core_hr.help_inbox');
    let waiting = 0;
    if (inbox) {
      const filter: Doc = reach.level === 'super' ? { route: { $in: ['hr', 'super'] } } : reach.companyHr ? { route: 'hr' } : { route: 'hr', hr_workspace_id: { $in: reach.hrWorkspaceIds } };
      waiting = await tx.collection('help_queries').count({ ...filter, status: 'open', raised_by_membership_id: { $ne: membershipId } });
    }
    return { raise, open, inbox, waiting };
  }

  get(id: string) {
    return this.db.tenant(async (tx) => {
      const { q, role } = await this.visibleQuery(tx, id);
      const now = new Date();
      await tx.collection('help_queries').updateOne({ id }, { $set: role.raiser ? { raiser_seen_at: now } : { handler_seen_at: now } });
      if (role.raiser) q.raiser_seen_at = now; else q.handler_seen_at = now;
      await this.notifications.markReadByLink(tx, role.membershipId!, role.raiser ? myQueryLink(id) : inboxQueryLink(id));
      return this.detail(tx, q, role, 'web');
    });
  }

  reply(id: string, input: HelpReplyInput) {
    return this.db.tenant(async (tx) => {
      const { q, role } = await this.visibleQuery(tx, id);
      if (input.clientId) {
        const dup = await tx.collection('help_query_messages').findOne({ query_id: id, author_membership_id: role.membershipId, client_id: input.clientId });
        if (dup) return this.detail(tx, q, role, 'web');
      }
      if (q.status === 'closed') throw Errors.conflict('query_closed', 'This query is closed. Raise a new query and mention its ticket ID.');
      if (input.internal && !role.handler) throw Errors.forbidden('Only the team handling a query can add internal notes');
      if (input.status && !role.handler) throw Errors.forbidden('Only the team handling a query can change its status this way');
      await this.checkFiles(tx, input.fileIds, role.membershipId!);
      const settings = await this.content.settingsIn(tx);
      const me = (await memberIdentities(tx, [role.membershipId])).get(role.membershipId!);
      const now = new Date();
      const actingAsRaiser = role.raiser && !input.internal;
      if (actingAsRaiser && q.status === 'resolved') {
        const until = at(q.resolved_at) + settings.reopenDays * DAY;
        if (!settings.reopenDays || Date.now() > until) throw Errors.conflict('reopen_expired', 'This query can no longer be reopened. Raise a new query and mention its ticket ID.');
      }
      await this.addMessage(tx, q, { kind: input.internal ? 'note' : 'message', authorKind: 'member', membershipId: role.membershipId, name: me?.name ?? 'Unnamed', level: me?.level ?? 'employee', workspace: me?.workspace ?? null, body: input.body, fileIds: input.fileIds, clientId: input.clientId });
      const ticket = helpTicketId(q.number);
      if (input.internal) {
        await tx.collection('help_queries').updateOne({ id }, { $set: { handler_seen_at: now } });
      } else if (actingAsRaiser) {
        // The person answered: the team has it again (reopened if it was resolved).
        const next: HelpQueryStatus = q.assignee_membership_id || q.assignee_admin_id ? 'in_progress' : 'open';
        await tx.collection('help_queries').updateOne({ id }, { $set: { status: next, last_message_at: now, last_raiser_message_at: now, raiser_seen_at: now, resolved_at: null } });
        if (q.status === 'resolved') await this.addMessage(tx, q, { kind: 'event', authorKind: 'system', body: `${me?.name ?? 'The person'} reopened the query` });
        await this.tellHandlers(tx, { ...q, status: next }, 'help.query_reply', `${me?.name ?? 'The person'} replied on ${ticket}: ${q.subject}`, preview(input.body), role.membershipId);
      } else {
        const next = input.status ?? 'awaiting_user';
        await tx.collection('help_queries').updateOne({ id }, { $set: { status: next, last_message_at: now, last_handler_message_at: now, handler_seen_at: now, ...(next === 'resolved' ? { resolved_at: now } : {}), ...(next === 'closed' ? { closed_at: now } : {}), ...(!q.assignee_membership_id ? { assignee_membership_id: role.membershipId } : {}) } });
        await this.tellRaiser(tx, q, 'help.query_replied', `${me?.name ?? 'Support'} replied to your query ${ticket}`, preview(input.body));
      }
      await this.audit.record(tx, { action: input.internal ? 'help.query_note' : 'help.query_replied', resourceType: 'help_query', resourceId: id });
      const fresh = (await tx.collection('help_queries').findOne({ id }))!;
      return this.detail(tx, fresh, role, 'web');
    });
  }

  private async changeStatus(tx: AnyTx, q: Doc, status: HelpQueryStatus, note: string | null, by: { name: string; level: string; workspace: string | null; membershipId?: string | null; adminId?: string | null }, byRaiser: boolean) {
    const now = new Date();
    await tx.collection('help_queries').updateOne({ id: q.id, tenant_id: q.tenant_id }, { $set: {
      status, updated_at: now,
      ...(status === 'resolved' ? { resolved_at: now } : {}),
      ...(status === 'closed' ? { closed_at: now } : {}),
      ...(status === 'open' || status === 'in_progress' ? { resolved_at: null, closed_at: null } : {}),
      ...(byRaiser ? { raiser_seen_at: now } : { handler_seen_at: now }),
    } });
    await this.addMessage(tx, q, { kind: 'event', authorKind: 'system', body: `${by.name} changed the status to ${HELP_QUERY_STATUS_LABEL[status]}${note ? `: ${note}` : ''}` });
    await this.audit.record(tx, { tenantId: q.tenant_id, action: 'help.query_status', resourceType: 'help_query', resourceId: q.id, changes: { from: q.status, to: status } });
    const ticket = helpTicketId(q.number);
    if (byRaiser) await this.tellHandlers(tx, q, 'help.query_status', `${by.name} set ${ticket} to ${HELP_QUERY_STATUS_LABEL[status]}`, note ?? undefined, by.membershipId);
    else await this.tellRaiser(tx, q, status === 'resolved' ? 'help.query_resolved' : 'help.query_status', status === 'resolved' ? `Your query ${ticket} was resolved` : `Your query ${ticket} is now ${HELP_QUERY_STATUS_LABEL[status]}`, note ?? q.subject);
  }

  status(id: string, status: HelpQueryStatus, note: string | null) {
    return this.db.tenant(async (tx) => {
      const { q, role } = await this.visibleQuery(tx, id);
      if (q.status === status) return this.detail(tx, q, role, 'web');
      const settings = await this.content.settingsIn(tx);
      const me = (await memberIdentities(tx, [role.membershipId])).get(role.membershipId!);
      const by = { name: me?.name ?? 'Unnamed', level: me?.level ?? 'employee', workspace: me?.workspace ?? null, membershipId: role.membershipId };
      if (!role.handler) {
        // The raiser may close their own query, or reopen a resolved one within the allowed days.
        if (status === 'closed') { /* allowed */ }
        else if (status === 'open' && q.status === 'resolved') {
          if (!settings.reopenDays || Date.now() > at(q.resolved_at) + settings.reopenDays * DAY) throw Errors.conflict('reopen_expired', 'This query can no longer be reopened. Raise a new query and mention its ticket ID.');
        } else throw Errors.forbidden('Only the team handling a query can set that status');
        if (q.status === 'closed') throw Errors.conflict('query_closed', 'This query is closed. Raise a new query and mention its ticket ID.');
      }
      await this.changeStatus(tx, q, status === 'open' && (q.assignee_membership_id || q.assignee_admin_id) ? 'in_progress' : status, note, by, !role.handler);
      return this.detail(tx, (await tx.collection('help_queries').findOne({ id }))!, role, 'web');
    });
  }

  assign(id: string, assigneeId: string | null) {
    return this.db.tenant(async (tx) => {
      const { q, role } = await this.visibleQuery(tx, id);
      if (!role.handler) throw Errors.forbidden('Only the team handling a query can assign it');
      if (assigneeId) {
        const allowed = new Set([...(await this.handlerMembers(tx, q)), ...(q.route === 'hr' ? await superWorkspaceMembers(tx, q.tenant_id) : [])]);
        if (!allowed.has(assigneeId)) throw Errors.badRequest('invalid_assignee', 'Choose someone who handles this query');
      }
      const names = await memberIdentities(tx, [role.membershipId, assigneeId]);
      await tx.collection('help_queries').updateOne({ id }, { $set: { assignee_membership_id: assigneeId, ...(assigneeId && q.status === 'open' ? { status: 'in_progress' } : {}) } });
      await this.addMessage(tx, q, { kind: 'event', authorKind: 'system', body: assigneeId ? `${names.get(role.membershipId!)?.name ?? 'Someone'} assigned it to ${names.get(assigneeId)?.name ?? 'a colleague'}` : `${names.get(role.membershipId!)?.name ?? 'Someone'} removed the assignee` });
      await this.audit.record(tx, { action: 'help.query_assigned', resourceType: 'help_query', resourceId: id, changes: { from: q.assignee_membership_id ?? null, to: assigneeId } });
      if (assigneeId && assigneeId !== role.membershipId) {
        await this.notifications.notify(tx, { membershipIds: [assigneeId], kind: 'help.query_assigned', category: 'communication', title: `Query ${helpTicketId(q.number)} was assigned to you: ${q.subject}`, link: inboxQueryLink(id), resource: { type: 'help_query', id } });
      }
      if (assigneeId && q.status === 'open') await this.tellRaiser(tx, q, 'help.query_status', `Your query ${helpTicketId(q.number)} is now In Progress`, q.subject);
      return this.detail(tx, (await tx.collection('help_queries').findOne({ id }))!, role, 'web');
    });
  }

  escalate(id: string, reason: string) {
    return this.db.tenant(async (tx) => {
      const { q, role } = await this.visibleQuery(tx, id);
      if (!role.handler) throw Errors.forbidden('Only the team handling a query can escalate it');
      const settings = await this.content.settingsIn(tx);
      if (!settings.escalation) throw Errors.forbidden('Escalation is switched off for help queries');
      if (q.status === 'closed') throw Errors.conflict('query_closed', 'This query is closed');
      const next: HelpRoute = q.route === 'hr' ? 'super' : 'console';
      const me = (await memberIdentities(tx, [role.membershipId])).get(role.membershipId!);
      await tx.collection('help_queries').updateOne({ id }, { $set: { route: next, hr_workspace_id: next === 'super' ? null : q.hr_workspace_id, assignee_membership_id: null, assignee_admin_id: null, status: 'open' } });
      await this.addMessage(tx, q, { kind: 'event', authorKind: 'system', body: `${me?.name ?? 'Someone'} escalated it to ${HELP_ROUTE_LABEL[next]}: ${reason}` });
      await this.audit.record(tx, { action: 'help.query_escalated', resourceType: 'help_query', resourceId: id, changes: { from: q.route, to: next, reason } });
      const fresh = (await tx.collection('help_queries').findOne({ id }))!;
      await this.tellHandlers(tx, fresh, 'help.query_new', `Query ${helpTicketId(q.number)} escalated to you: ${q.subject}`, reason, role.membershipId);
      await this.tellRaiser(tx, q, 'help.query_status', `Your query ${helpTicketId(q.number)} was passed to ${HELP_ROUTE_LABEL[next]}`, reason);
      return { ok: true, route: next };
    });
  }

  rate(id: string, rating: number, comment: string | null) {
    return this.db.tenant(async (tx) => {
      const { q, role } = await this.visibleQuery(tx, id);
      if (!role.raiser) throw Errors.forbidden('Only the person who raised a query can rate the answer');
      if (!['resolved', 'closed'].includes(q.status)) throw Errors.conflict('not_resolved', 'Rate a query once it is resolved');
      await tx.collection('help_queries').updateOne({ id }, { $set: { rating, rating_comment: comment } });
      await this.audit.record(tx, { action: 'help.query_rated', resourceType: 'help_query', resourceId: id, changes: { rating } });
      return { ok: true, rating };
    });
  }

  /** A 5-minute download link for a file on a query the caller can see (notes' files only for handlers). */
  fileLink(id: string, fileId: string) {
    return this.db.tenant(async (tx) => {
      const { q, role } = await this.visibleQuery(tx, id);
      const onQuery = ((q.file_ids as string[]) ?? []).includes(fileId);
      const onMessage = await tx.collection('help_query_messages').exists({ query_id: id, file_ids: fileId, ...(role.handler ? {} : { kind: { $ne: 'note' } }) });
      if (!onQuery && !onMessage) throw Errors.notFound('File');
      await this.audit.record(tx, { action: 'help.file_downloaded', resourceType: 'help_query', resourceId: id, metadata: { fileId } });
      return this.storage.sign(fileId, 300, 'comm');
    });
  }

  // ------------------------------------------------------------------------------------------- Console side

  private adminRole(): Role {
    return { raiser: false, handler: true, membershipId: null, adminId: requestContext.platformActor().adminId };
  }

  private async consoleQuery(tx: PlatformTx, id: string) {
    const q = await tx.collection('help_queries').findOne({ id, route: 'console' });
    if (!q) throw Errors.notFound('Query');
    return q;
  }

  private async adminName(tx: PlatformTx) {
    const a = await tx.collection('platform_admins').findOne({ id: requestContext.platformActor().adminId }, { projection: { full_name: 1 } });
    return (a?.full_name as string) ?? 'Console Admin';
  }

  consoleList(query: HelpQueryListQuery) {
    return this.db.platform(async (tx) => {
      const filter: Doc = { route: 'console', ...(query.tenantId ? { tenant_id: query.tenantId } : {}) };
      if (query.q) {
        const tenants = await tx.collection('tenants').distinct<string>('id', { $or: [{ name: ilike(query.q) }, { slug: ilike(query.q) }] });
        filter.$or = [{ tenant_id: { $in: tenants } }, { subject: ilike(query.q) }, { description: ilike(query.q) }, { raiser_name: ilike(query.q) }, ...(/^(hq-)?\d+$/i.test(query.q.trim()) ? [{ number: Number(query.q.trim().replace(/^hq-/i, '')) }] : [])];
      }
      const rows = await tx.collection('help_queries').find(filter, { sort: { last_message_at: -1 }, limit: 1000 });
      const role = this.adminRole();
      const settings = await this.content.settingsIn(tx);
      const items = await this.views(tx, this.filter(rows, { ...query, q: undefined }, role.adminId), () => role, settings);
      return { items, counts: this.counts(rows), waiting: rows.filter((q) => q.status === 'open').length };
    });
  }

  consoleWaiting() {
    return this.db.platform(async (tx) => ({ waiting: await tx.collection('help_queries').count({ route: 'console', status: 'open' }) }));
  }

  consoleGet(id: string) {
    return this.db.platform(async (tx) => {
      const q = await this.consoleQuery(tx, id);
      await tx.collection('help_queries').updateOne({ id, tenant_id: q.tenant_id }, { $set: { handler_seen_at: new Date() } });
      return this.detail(tx, q, this.adminRole(), 'console');
    });
  }

  consoleReply(id: string, input: HelpReplyInput) {
    return this.db.platform(async (tx) => {
      const q = await this.consoleQuery(tx, id);
      const role = this.adminRole();
      if (input.clientId && (await tx.collection('help_query_messages').exists({ tenant_id: q.tenant_id, query_id: id, author_admin_id: role.adminId, client_id: input.clientId }))) return this.detail(tx, q, role, 'console');
      if (q.status === 'closed') throw Errors.conflict('query_closed', 'This query is closed');
      if (input.fileIds.length) throw Errors.badRequest('attachments_console', 'Attach files from the Support inbox conversation instead');
      const name = await this.adminName(tx);
      await this.addMessage(tx, q, { kind: input.internal ? 'note' : 'message', authorKind: 'console', adminId: role.adminId, name, level: 'console', workspace: CONSOLE_TEAM_NAME, body: input.body, clientId: input.clientId });
      const now = new Date();
      if (!input.internal) {
        const next = input.status ?? 'awaiting_user';
        await tx.collection('help_queries').updateOne({ id, tenant_id: q.tenant_id }, { $set: { status: next, last_message_at: now, last_handler_message_at: now, handler_seen_at: now, ...(next === 'resolved' ? { resolved_at: now } : {}), ...(next === 'closed' ? { closed_at: now } : {}), ...(!q.assignee_admin_id ? { assignee_admin_id: role.adminId } : {}) } });
        await this.tellRaiser(tx, q, 'help.query_replied', `${name} (SampCrew Support) replied to your query ${helpTicketId(q.number)}`, preview(input.body));
      }
      await this.audit.record(tx, { tenantId: q.tenant_id, action: input.internal ? 'help.query_note' : 'help.query_replied', resourceType: 'help_query', resourceId: id });
      return this.detail(tx, (await tx.collection('help_queries').findOne({ id, tenant_id: q.tenant_id }))!, role, 'console');
    });
  }

  consoleStatus(id: string, status: HelpQueryStatus, note: string | null) {
    return this.db.platform(async (tx) => {
      const q = await this.consoleQuery(tx, id);
      if (q.status !== status) await this.changeStatus(tx, q, status, note, { name: await this.adminName(tx), level: 'console', workspace: CONSOLE_TEAM_NAME, adminId: this.adminRole().adminId }, false);
      return this.detail(tx, (await tx.collection('help_queries').findOne({ id, tenant_id: q.tenant_id }))!, this.adminRole(), 'console');
    });
  }

  consoleAssign(id: string, adminId: string | null) {
    return this.db.platform(async (tx) => {
      const q = await this.consoleQuery(tx, id);
      if (adminId && !(await tx.collection('platform_admins').exists({ id: adminId, status: 'active', role: { $in: ['super_admin', 'support'] } }))) throw Errors.badRequest('invalid_assignee', 'Choose a Console Admin who answers help queries');
      const name = await this.adminName(tx);
      const target = adminId ? await tx.collection('platform_admins').findOne({ id: adminId }, { projection: { full_name: 1 } }) : undefined;
      await tx.collection('help_queries').updateOne({ id, tenant_id: q.tenant_id }, { $set: { assignee_admin_id: adminId, ...(adminId && q.status === 'open' ? { status: 'in_progress' } : {}) } });
      await this.addMessage(tx, q, { kind: 'event', authorKind: 'system', body: adminId ? `${name} assigned it to ${(target?.full_name as string) ?? 'a Console Admin'}` : `${name} removed the assignee` });
      await this.audit.record(tx, { tenantId: q.tenant_id, action: 'help.query_assigned', resourceType: 'help_query', resourceId: id, changes: { from: q.assignee_admin_id ?? null, to: adminId } });
      if (adminId && q.status === 'open') await this.tellRaiser(tx, q, 'help.query_status', `Your query ${helpTicketId(q.number)} is now In Progress`, q.subject);
      return this.detail(tx, (await tx.collection('help_queries').findOne({ id, tenant_id: q.tenant_id }))!, this.adminRole(), 'console');
    });
  }

  consoleFileLink(id: string, fileId: string) {
    return this.db.platform(async (tx) => {
      const q = await this.consoleQuery(tx, id);
      const onQuery = ((q.file_ids as string[]) ?? []).includes(fileId);
      const onMessage = await tx.collection('help_query_messages').exists({ tenant_id: q.tenant_id, query_id: id, file_ids: fileId });
      if (!onQuery && !onMessage) throw Errors.notFound('File');
      await this.audit.record(tx, { tenantId: q.tenant_id, action: 'help.file_downloaded', resourceType: 'help_query', resourceId: id, metadata: { fileId } });
      return this.storage.sign(fileId, 300, 'comm');
    });
  }
}
