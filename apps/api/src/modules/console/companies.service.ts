import { Injectable } from '@nestjs/common';
import {
  CLIENT_INDUSTRY_LABEL, CLIENT_STATUS_LABEL, type ClientProfileInput, type ClientRow, type ClientsQuery, type platformCreateTenantRequest,
} from '@crew/contracts';
import type { z } from 'zod';
import { AuditService, diff } from '../../platform/audit/audit.service';
import { requestContext } from '../../platform/context/request-context';
import { ilike, MongoService as DatabaseService, type PlatformTx } from '../../platform/database/mongo.service';
import { renderTablePdf } from '../../platform/export/table-pdf';
import { toXlsx, type Cell } from '../../platform/export/tabular';
import { Errors } from '../../platform/http/errors';
import { CompanyDataError, domainOf, fetchBrand } from '../../platform/integrations/company-data';
import { PlatformIntegrationsService } from '../../platform/integrations/platform-integrations.service';
import { BillingEngine } from '../billing/billing-engine.service';
import { PlatformService } from '../platform-admin/platform.service';
import { TenantControlService } from '../platform-admin/tenant-control.service';
import { ConsoleSettingsService } from './console-settings.service';
import { addMoney, loadPortfolio, type CompanyRow, type CompanyStats } from './portfolio';

const DAY = 86_400_000;
const iso = (d: Date | null | undefined) => (d instanceof Date ? d.toISOString() : null);

/** Masks an email or phone for admins without users:pii (j***@acme.com, +91 ******3210). */
export function maskEmail(v: string | null | undefined): string | null {
  if (!v) return null;
  const [user, domain] = v.split('@');
  return domain ? `${user!.slice(0, 1)}***@${domain}` : '***';
}
export function maskPhone(v: string | null | undefined): string | null {
  if (!v) return null;
  const digits = v.replace(/\D/g, '');
  return digits.length > 4 ? `${'*'.repeat(Math.min(8, digits.length - 4))}${digits.slice(-4)}` : '****';
}
export const canSeePii = () => requestContext.platformActor().permissions.includes('users:pii');
const canSeeBilling = () => requestContext.platformActor().permissions.includes('billing:read');

/**
 * Clients (client companies) in the Console: the list with filters, sort, export and bulk actions; the 360 view;
 * the company profile; creating a company with its first Super Workspace and adding more Super Workspaces to it.
 * Money is shown only to admins with billing:read, contact details only with users:pii (masked otherwise).
 */
@Injectable()
export class CompaniesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly engine: BillingEngine,
    private readonly settings: ConsoleSettingsService,
    private readonly platform: PlatformService,
    private readonly control: TenantControlService,
    private readonly integrations: PlatformIntegrationsService,
  ) {}

  // ---------------------------------------------------------------------------------------------------------------
  // List
  // ---------------------------------------------------------------------------------------------------------------

  async list(q: ClientsQuery) {
    return this.db.platform(async (tx) => {
      const all = await this.portfolio(tx);
      const counts: Record<string, number> = { all: all.length };
      for (const c of all) counts[c.status] = (counts[c.status] ?? 0) + 1;
      const rows = this.filter(all, q).map((c) => this.row(c));
      this.sort(rows, q);
      const plans = [...new Map(all.flatMap((c) => c.tenants.map((t) => t.plan)).filter(Boolean).map((p) => [p!.key, { key: p!.key, name: p!.name }])).values()];
      return { items: rows.slice(q.offset, q.offset + q.limit), total: rows.length, counts, plans };
    });
  }

  /** The filtered list as a file (CSV, Excel or PDF), every matching row. Audited: exports leave the Console. */
  async export(q: ClientsQuery, format: 'csv' | 'xlsx' | 'pdf') {
    const { items } = await this.list({ ...q, offset: 0, limit: 100_000 } as ClientsQuery);
    const money = canSeeBilling();
    const header = ['Company', 'Status', 'Industry', 'Location', 'Size', 'Plan', 'Subscription', 'Users', 'HR/Admin users', 'Employees', 'Super Workspaces', 'HR Workspaces', 'Employee Workspaces',
      ...(money ? ['Revenue', 'MRR', 'Payment status', 'Outstanding'] : []), 'Subscription start', 'Next renewal', 'Created', 'Last activity'];
    const fmt = (m: Record<string, string>) => Object.entries(m).filter(([, v]) => Number(v) !== 0).map(([c, v]) => `${c} ${v}`).join(' + ');
    const rows: Cell[][] = [header, ...items.map((r) => [
      r.name, CLIENT_STATUS_LABEL[r.status], r.industry ? CLIENT_INDUSTRY_LABEL[r.industry as keyof typeof CLIENT_INDUSTRY_LABEL] ?? r.industry : '', r.location ?? '', r.companySize ?? '', r.planName ?? '', r.subscriptionStatus ?? '',
      r.users, r.hrUsers, r.employees, r.superWorkspaces, r.hrWorkspaces, r.employeeWorkspaces,
      ...(money ? [fmt(r.revenue), fmt(r.mrr), r.paymentStatus, fmt(r.outstanding)] : []),
      r.subscriptionStart ?? '', r.nextRenewal ?? '', r.createdAt.slice(0, 10), r.lastActivityAt?.slice(0, 10) ?? '',
    ])];
    await this.db.platform((tx) => this.audit.record(tx, { tenantId: null, action: 'platform.clients_exported', resourceType: 'company', resourceId: null, metadata: { format, rows: items.length, filters: q } }));
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'pdf') return { fileName: `sampcrew-clients-${stamp}.pdf`, content: await renderTablePdf('SampCrew clients', `${items.length} companies · ${stamp}`, rows), type: 'application/pdf' };
    if (format === 'xlsx') return { fileName: `sampcrew-clients-${stamp}.xlsx`, content: toXlsx('Clients', rows), type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
    const csv = rows.map((r) => r.map((v) => { const t = v == null ? '' : String(v); return /[",\n\r]/.test(t) || /^[=+\-@]/.test(t) ? `"${(/^[=+\-@]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"` : t; }).join(',')).join('\r\n');
    return { fileName: `sampcrew-clients-${stamp}.csv`, content: `﻿${csv}\r\n`, type: 'text/csv; charset=utf-8' };
  }

  private async portfolio(tx: PlatformTx, companyIds?: string[]) {
    const { notifications } = await this.settings.read(tx);
    return loadPortfolio(tx, this.engine, notifications.inactiveAfterDays, companyIds ? { companyIds } : {});
  }

  private filter(all: CompanyStats[], q: ClientsQuery) {
    const needle = q.q ? new RegExp(ilike(q.q).$regex, 'i') : null;
    const today = new Date().toISOString().slice(0, 10);
    return all.filter((c) => {
      const t0 = c.tenants[0];
      if (q.demo === 'exclude' && c.company.is_demo) return false;
      if (q.demo === 'only' && !c.company.is_demo) return false;
      if (q.status && c.status !== q.status) return false;
      if (needle && !needle.test(c.company.name) && !needle.test(c.company.legal_name ?? '') && !c.tenants.some((t) => needle.test(t.slug) || needle.test(t.name)) && !needle.test(c.company.website ?? '')) return false;
      if (q.plan && !c.tenants.some((t) => t.plan?.key === q.plan)) return false;
      if (q.industry && c.company.industry !== q.industry) return false;
      if (q.size && c.company.company_size !== q.size) return false;
      if (q.paid === 'paid' && !c.tenants.some((t) => t.sub && ['active', 'past_due'].includes(t.sub.status) && Number(t.sub.unit_price) > 0)) return false;
      if (q.paid === 'free' && c.tenants.some((t) => t.sub && ['active', 'past_due'].includes(t.sub.status) && Number(t.sub.unit_price) > 0)) return false;
      if (q.paid === 'enterprise' && !c.tenants.some((t) => t.plan?.enterprise)) return false;
      const created = c.company.created_at.toISOString().slice(0, 10);
      if (q.createdFrom && created < q.createdFrom) return false;
      if (q.createdTo && created > q.createdTo) return false;
      const subStart = t0?.sub?.created_at?.toISOString().slice(0, 10);
      if (q.subscribedFrom && (!subStart || subStart < q.subscribedFrom)) return false;
      if (q.subscribedTo && (!subStart || subStart > q.subscribedTo)) return false;
      if (q.renewalWithinDays !== undefined) {
        const limit = new Date(Date.now() + q.renewalWithinDays * DAY).toISOString().slice(0, 10);
        if (!c.tenants.some((t) => t.sub && ['active', 'past_due', 'trialing'].includes(t.sub.status) && (t.sub.status === 'trialing' ? t.sub.trial_ends_on ?? '' : t.sub.current_period_end) >= today && (t.sub.status === 'trialing' ? t.sub.trial_ends_on ?? '' : t.sub.current_period_end) <= limit)) return false;
      }
      return true;
    });
  }

  private row(c: CompanyStats): ClientRow {
    const ts = c.tenants;
    const t0 = ts[0];
    const money = canSeeBilling();
    const outstanding = addMoney(ts.map((t) => t.outstanding));
    const anyOutstanding = Object.values(outstanding).some((v) => Number(v) > 0);
    const renewals = ts.map((t) => (t.sub ? (t.sub.status === 'trialing' ? t.sub.trial_ends_on : t.sub.status === 'cancelled' ? null : t.sub.current_period_end) : null)).filter((d): d is string => !!d).sort();
    const activity = ts.map((t) => t.lastActivityAt?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
    const location = [c.company.address?.city, c.company.address?.country ?? c.company.country_code].filter(Boolean).join(', ') || null;
    return {
      id: c.company.id, name: c.company.name, logoUrl: c.company.logo_url ?? null, industry: c.company.industry ?? null, location, companySize: c.company.company_size ?? null,
      plan: t0?.plan?.key ?? null, planName: ts.length > 1 ? [...new Set(ts.map((t) => t.plan?.name).filter(Boolean))].join(', ') || null : t0?.plan?.name ?? null,
      subscriptionStatus: t0?.sub?.status ?? null, status: c.status,
      users: sum(ts.map((t) => t.users)), hrUsers: sum(ts.map((t) => t.hrUsers)), employees: sum(ts.map((t) => t.employees)),
      superWorkspaces: ts.length, hrWorkspaces: sum(ts.map((t) => t.hrWorkspaces)), employeeWorkspaces: sum(ts.map((t) => t.employeeWorkspaces)),
      revenue: money ? addMoney(ts.map((t) => t.revenue)) : {}, mrr: money ? addMoney(ts.map((t) => (t.sub ? { [t.sub.currency]: t.mrr } : {}))) : {},
      paymentStatus: !money ? 'none' : ts.some((t) => t.overdue || t.sub?.status === 'past_due') ? 'overdue' : anyOutstanding ? 'due' : ts.some((t) => Object.keys(t.revenue).length) ? 'paid' : 'none',
      outstanding: money ? outstanding : {},
      subscriptionStart: t0?.sub?.created_at?.toISOString().slice(0, 10) ?? null, nextRenewal: renewals[0] ?? null,
      createdAt: c.company.created_at.toISOString(), lastActivityAt: activity ? new Date(activity).toISOString() : null, isDemo: c.company.is_demo, primaryWorkspaceId: t0?.id ?? null,
    };
  }

  private sort(rows: ClientRow[], q: ClientsQuery) {
    const dir = q.dir === 'asc' ? 1 : -1;
    const total = (m: Record<string, string>) => Object.values(m).reduce((a, v) => a + Number(v), 0);
    const key: Record<ClientsQuery['sort'], (r: ClientRow) => string | number> = {
      name: (r) => r.name.toLowerCase(), created: (r) => r.createdAt, revenue: (r) => total(r.revenue), users: (r) => r.users, renewal: (r) => r.nextRenewal ?? '9999', activity: (r) => r.lastActivityAt ?? '',
    };
    const k = key[q.sort];
    rows.sort((a, b) => (k(a) < k(b) ? -dir : k(a) > k(b) ? dir : a.id < b.id ? -1 : 1));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // 360
  // ---------------------------------------------------------------------------------------------------------------

  async detail(id: string) {
    const pii = canSeePii();
    const money = canSeeBilling();
    return this.db.platform(async (tx) => {
      const [c] = await this.portfolio(tx, [id]);
      if (!c) throw Errors.notFound('Company');
      const manager = c.company.account_manager_admin_id ? await tx.collection<{ id: string; full_name: string; email: string }>('platform_admins').findOne({ id: c.company.account_manager_admin_id }) : undefined;
      const full = (await tx.collection<CompanyRow & Record<string, unknown>>('companies').findOne({ id }))!;
      const tenantIds = c.tenants.map((t) => t.id);
      const workspaces = [];
      for (const t of c.tenants) {
        const spaces = await tx.collection<{ id: string; name: string; status: string; created_at: Date }>('hr_workspaces').find({ tenant_id: t.id, status: { $ne: 'archived' } }, { sort: { name: 1 }, projection: { name: 1, status: 1, created_at: 1 } });
        const people = await tx.collection('employees').aggregate<{ id: string | null; n: number }>([{ $match: { tenant_id: t.id, status: { $ne: 'exited' } } }, { $group: { _id: '$hr_workspace_id', n: { $sum: 1 } } }]);
        const per = new Map(people.map((p) => [String(p.id), p.n]));
        workspaces.push({
          id: t.id, name: t.name, slug: t.slug, status: t.status, isDemo: t.isDemo, createdAt: t.createdAt.toISOString(), setupDone: t.setupDone,
          plan: t.plan ? { key: t.plan.key, name: t.plan.name } : null,
          subscription: t.sub ? {
            status: t.sub.status, seats: t.sub.seats, billingCycle: t.sub.billing_cycle, currency: t.sub.currency, trialEndsOn: t.sub.trial_ends_on, currentPeriodEnd: t.sub.current_period_end,
            cancelAtPeriodEnd: t.sub.cancel_at_period_end, ...(money ? { unitPrice: t.sub.unit_price, mrr: t.mrr } : {}),
          } : null,
          counts: { users: t.users, activeUsers: t.activeUsers, invited: t.invited, hrUsers: t.hrUsers, employees: t.employees, hrWorkspaces: t.hrWorkspaces, employeeWorkspaces: t.employeeWorkspaces },
          hrWorkspaces: [
            { id: null, name: 'Company-wide (central group)', status: 'active', people: per.get('null') ?? 0 },
            ...spaces.map((s) => ({ id: s.id, name: s.name, status: s.status, people: per.get(s.id) ?? 0 })),
          ],
          lastActivityAt: iso(t.lastActivityAt),
          ...(money ? { revenue: t.revenue, outstanding: t.outstanding, overdue: t.overdue } : {}),
        });
      }
      const ts = c.tenants;
      const totals = {
        superWorkspaces: ts.length, hrWorkspaces: sum(ts.map((t) => t.hrWorkspaces)), employeeWorkspaces: sum(ts.map((t) => t.employeeWorkspaces)),
        users: sum(ts.map((t) => t.users)), activeUsers: sum(ts.map((t) => t.activeUsers)), inactiveUsers: sum(ts.map((t) => t.users - t.activeUsers - t.invited)),
        pendingInvitations: sum(ts.map((t) => t.invited)), employees: sum(ts.map((t) => t.employees)), hrUsers: sum(ts.map((t) => t.hrUsers)),
      };
      const conversations = await tx.collection('support_conversations').count({ tenant_id: { $in: tenantIds }, status: 'open' });
      const tickets = await tx.collection('help_queries').count({ tenant_id: { $in: tenantIds }, route: 'console', status: { $in: ['open', 'in_progress', 'awaiting_user'] } });
      const ownerRows = [];
      for (const t of ts) {
        const role = await tx.collection<{ id: string }>('roles').findOne({ tenant_id: t.id, key: 'super_workspace', is_system: true }, { projection: { id: 1 } });
        const ms = role ? await tx.collection<{ membership_id: string }>('role_assignments').find({ tenant_id: t.id, role_id: role.id }, { projection: { membership_id: 1 }, limit: 5 }) : [];
        const mem = await tx.collection<{ id: string; user_id: string; status: string }>('memberships').find({ id: { $in: ms.map((m) => m.membership_id) }, status: { $ne: 'suspended' } });
        const us = await tx.collection<{ id: string; full_name: string; email: string }>('users').find({ id: { $in: mem.map((m) => m.user_id) } }, { projection: { full_name: 1, email: 1 } });
        for (const u of us) ownerRows.push({ workspaceId: t.id, name: u.full_name, email: pii ? u.email : maskEmail(u.email) });
      }
      return {
        profile: this.profileView(full, pii), status: c.status, statusLabel: CLIENT_STATUS_LABEL[c.status],
        accountManager: manager ? { id: manager.id, name: manager.full_name } : null,
        totals, workspaces, superWorkspaceAdmins: ownerRows,
        money: money ? {
          revenue: addMoney(ts.map((t) => t.revenue)), outstanding: addMoney(ts.map((t) => t.outstanding)), mrr: addMoney(ts.map((t) => (t.sub ? { [t.sub.currency]: t.mrr } : {}))),
        } : null,
        support: { openConversations: conversations, openTickets: tickets },
      };
    });
  }

  private profileView(c: Record<string, unknown>, pii: boolean) {
    const contact = (c.primary_contact ?? null) as { name?: string | null; email?: string | null; phone?: string | null; title?: string | null } | null;
    return {
      id: c.id as string, name: c.name as string, legalName: (c.legal_name as string) ?? null, industry: (c.industry as string) ?? null, description: (c.description as string) ?? null,
      website: (c.website as string) ?? null, linkedin: (c.linkedin as string) ?? null,
      email: pii ? ((c.email as string) ?? null) : maskEmail(c.email as string), phone: pii ? ((c.phone as string) ?? null) : maskPhone(c.phone as string), whatsapp: pii ? ((c.whatsapp as string) ?? null) : maskPhone(c.whatsapp as string),
      foundedYear: (c.founded_year as number) ?? null, companySize: (c.company_size as string) ?? null, countryCode: (c.country_code as string) ?? null,
      address: (c.address as Record<string, string | null>) ?? null, logoUrl: (c.logo_url as string) ?? null, tags: (c.tags as string[]) ?? [],
      primaryContact: contact ? { name: contact.name ?? null, title: contact.title ?? null, email: pii ? contact.email ?? null : maskEmail(contact.email), phone: pii ? contact.phone ?? null : maskPhone(contact.phone) } : null,
      accountManagerId: (c.account_manager_admin_id as string) ?? null, isDemo: c.is_demo === true, archivedAt: iso(c.archived_at as Date), createdAt: iso(c.created_at as Date),
      fieldSources: (c.field_sources as Record<string, unknown>) ?? {}, piiMasked: !pii,
    };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Profile, create, add workspace, archive, bulk
  // ---------------------------------------------------------------------------------------------------------------

  /**
   * Saves the company profile. Contact fields are only changed by admins who may see them (users:pii): without it a
   * masked value sent back is ignored, so it cannot overwrite the real one.
   */
  async updateProfile(id: string, input: ClientProfileInput, sources: Record<string, unknown> = {}) {
    const pii = canSeePii();
    return this.db.platform(async (tx) => {
      const companies = tx.collection<Record<string, unknown>>('companies');
      const before = await companies.findOne({ id });
      if (!before) throw Errors.notFound('Company');
      if (input.accountManagerId && !(await tx.collection('platform_admins').exists({ id: input.accountManagerId, status: 'active' }))) throw Errors.badRequest('unknown_admin', 'Pick an active Console admin as account manager');
      const next: Record<string, unknown> = {
        name: input.name, legal_name: input.legalName ?? null, industry: input.industry ?? null, description: input.description ?? null, website: input.website ?? null, linkedin: input.linkedin ?? null,
        founded_year: input.foundedYear ?? null, company_size: input.companySize ?? null, address: input.address ?? null, country_code: input.address?.country ?? before.country_code ?? null,
        ...(input.accountManagerId !== undefined ? { account_manager_admin_id: input.accountManagerId } : {}),
        ...(input.tags ? { tags: [...new Set(input.tags)] } : {}),
      };
      if (pii) Object.assign(next, { email: input.email ?? null, phone: input.phone ?? null, whatsapp: input.whatsapp ?? null, primary_contact: input.primaryContact ?? null });
      else if (input.primaryContact) next.primary_contact = { ...((before.primary_contact as object) ?? {}), name: input.primaryContact.name ?? null, title: input.primaryContact.title ?? null };
      if (Object.keys(sources).length) next.field_sources = { ...((before.field_sources as object) ?? {}), ...sources };
      const changes = diff(before, next);
      if (!Object.keys(changes).length) return this.profileView(before, pii);
      await companies.updateOne({ id }, { $set: next });
      await this.audit.record(tx, { tenantId: null, action: 'platform.company_updated', resourceType: 'company', resourceId: id, changes });
      return this.profileView({ ...before, ...next }, pii);
    });
  }

  /** A company with its first Super Workspace (owner, plan, trial), in one go. */
  async create(input: { profile: ClientProfileInput; workspace: z.infer<typeof platformCreateTenantRequest> }) {
    const p = input.profile;
    const pii = canSeePii();
    const company = {
      name: p.name, legal_name: p.legalName ?? null, industry: p.industry ?? null, description: p.description ?? null, website: p.website ?? null, linkedin: p.linkedin ?? null,
      founded_year: p.foundedYear ?? null, company_size: p.companySize ?? null, address: p.address ?? null, country_code: p.address?.country ?? input.workspace.countryCode,
      account_manager_admin_id: p.accountManagerId ?? null, tags: p.tags ?? [], created_by_admin_id: requestContext.platformActor().adminId,
      ...(pii ? { email: p.email ?? null, phone: p.phone ?? null, whatsapp: p.whatsapp ?? null, primary_contact: p.primaryContact ?? null } : {}),
    };
    await this.requireOpenPlan(input.workspace.planKey);
    const created = await this.platform.createTenant(input.workspace, { company });
    await this.db.platform((tx) => this.audit.record(tx, { tenantId: null, action: 'platform.company_created', resourceType: 'company', resourceId: created.companyId, changes: { name: p.name, workspace: input.workspace.slug } }));
    return created;
  }

  async addWorkspace(companyId: string, workspace: z.infer<typeof platformCreateTenantRequest>) {
    await this.requireOpenPlan(workspace.planKey);
    return this.platform.createTenant(workspace, { companyId });
  }

  /** Moves a Super Workspace to another company (two companies found to be one group, or a split). */
  async moveWorkspace(tenantId: string, companyId: string) {
    return this.db.platform(async (tx) => {
      const t = await tx.collection<{ company_id: string | null; name: string }>('tenants').findOne({ id: tenantId });
      if (!t) throw Errors.notFound('Workspace');
      if (!(await tx.collection('companies').exists({ id: companyId, archived_at: null }))) throw Errors.notFound('Company');
      if (t.company_id === companyId) return { moved: false };
      await tx.collection('tenants').updateOne({ id: tenantId }, { $set: { company_id: companyId } });
      await this.audit.record(tx, { tenantId: null, action: 'platform.workspace_moved', resourceType: 'tenant', resourceId: tenantId, changes: { company_id: { from: t.company_id, to: companyId } } });
      return { moved: true };
    });
  }

  /** Archives a company whose Super Workspaces are all suspended or closed (nothing is deleted); or brings it back. */
  async setArchived(id: string, archived: boolean, reason: string) {
    return this.db.platform(async (tx) => {
      const c = await tx.collection<{ archived_at: Date | null }>('companies').findOne({ id });
      if (!c) throw Errors.notFound('Company');
      if (archived && (await tx.collection('tenants').exists({ company_id: id, status: 'active' }))) {
        throw Errors.conflict('workspaces_active', 'Suspend its Super Workspaces first. Archiving keeps every record; it only takes the company out of the active lists.');
      }
      await tx.collection('companies').updateOne({ id }, { $set: { archived_at: archived ? new Date() : null } });
      await this.audit.record(tx, { tenantId: null, action: archived ? 'platform.company_archived' : 'platform.company_restored', resourceType: 'company', resourceId: id, metadata: { reason } });
      return { id, archived };
    });
  }

  /** Bulk actions on selected companies. Suspend and activate need tenants:manage and apply to every Super Workspace. */
  async bulk(input: { action: 'suspend' | 'activate' | 'tag' | 'assign_manager'; ids: string[]; reason?: string; tag?: string; accountManagerId?: string | null }) {
    const perms = requestContext.platformActor().permissions;
    if ((input.action === 'suspend' || input.action === 'activate') && !perms.includes('tenants:manage')) throw Errors.forbidden();
    const results: { id: string; ok: boolean; detail?: string }[] = [];
    if (input.action === 'suspend' || input.action === 'activate') {
      const tenants = await this.db.platform((tx) => tx.collection<{ id: string; company_id: string; status: string }>('tenants').find({ company_id: { $in: input.ids } }, { projection: { company_id: 1, status: 1 } }));
      for (const id of input.ids) {
        const mine = tenants.filter((t) => t.company_id === id && t.status !== 'closed');
        try {
          for (const t of mine) if ((input.action === 'suspend') === (t.status === 'active')) await this.platform.setStatus(t.id, input.action === 'suspend' ? 'suspended' : 'active', input.reason ?? 'Reactivated in bulk from Console > Clients');
          results.push({ id, ok: true });
        } catch (e) {
          results.push({ id, ok: false, detail: (e as Error).message });
        }
      }
      return { results };
    }
    return this.db.platform(async (tx) => {
      if (input.action === 'assign_manager' && input.accountManagerId && !(await tx.collection('platform_admins').exists({ id: input.accountManagerId, status: 'active' }))) throw Errors.badRequest('unknown_admin', 'Pick an active Console admin');
      const update = input.action === 'tag' ? { $addToSet: { tags: input.tag } } : { $set: { account_manager_admin_id: input.accountManagerId ?? null } };
      const n = await tx.collection('companies').update({ id: { $in: input.ids } }, update);
      await this.audit.record(tx, { tenantId: null, action: `platform.companies_${input.action === 'tag' ? 'tagged' : 'manager_assigned'}`, resourceType: 'company', resourceId: null, metadata: { ids: input.ids, tag: input.tag, accountManagerId: input.accountManagerId } });
      return { results: input.ids.map((id) => ({ id, ok: true })), updated: n };
    });
  }

  /** People in every Super Workspace of a company (names and levels; contact details only with users:pii). */
  async users(id: string, q: { q?: string; status?: string; limit: number; offset: number }) {
    const tenantIds = await this.db.platform((tx) => tx.collection('tenants').distinct<string>('id', { company_id: id }));
    if (!tenantIds.length && !(await this.db.platform((tx) => tx.collection('companies').exists({ id })))) throw Errors.notFound('Company');
    const r = await this.control.users({ ...q, tenantIds });
    const pii = canSeePii();
    return { ...r, items: r.items.map((u) => (pii ? u : { ...u, email: maskEmail(u.email) ?? '' })), piiMasked: !pii };
  }

  /**
   * Looks the company up in the company-data integration (Brandfetch) by its website, and returns what was found next
   * to what the profile holds. Nothing is saved: the admin accepts fields one by one (saved with their source).
   */
  async lookup(id: string) {
    const keys = await this.integrations.companyData();
    if (!keys) throw Errors.badRequest('company_data_off', 'Company data is not set up. Add a Brandfetch key in Console > Integrations.');
    const c = await this.db.platform((tx) => tx.collection<{ website: string | null; name: string }>('companies').findOne({ id }));
    if (!c) throw Errors.notFound('Company');
    const domain = domainOf(c.website);
    if (!domain) throw Errors.badRequest('no_website', 'Add the company website first; details are looked up by its domain.');
    try {
      const facts = await fetchBrand(keys, domain);
      await this.db.platform((tx) => this.audit.record(tx, { tenantId: null, action: 'platform.company_data_fetched', resourceType: 'company', resourceId: id, metadata: { domain, source: 'brandfetch' } }));
      return { source: 'Brandfetch', fetchedAt: new Date().toISOString(), facts };
    } catch (e) {
      if (e instanceof CompanyDataError) throw Errors.badRequest('company_data_failed', e.message);
      throw e;
    }
  }

  /**
   * Saves the chosen fields from a fresh Brandfetch lookup (fetched again here, so only what Brandfetch returns is
   * saved, never a value typed into the request). Each saved field is marked with its source and the time.
   */
  async applyLookup(id: string, fields: ('description' | 'logo' | 'linkedin' | 'foundedYear' | 'location')[]) {
    const { facts } = await this.lookup(id);
    return this.db.platform(async (tx) => {
      const companies = tx.collection<Record<string, unknown>>('companies');
      const before = await companies.findOne({ id });
      if (!before) throw Errors.notFound('Company');
      const next: Record<string, unknown> = {};
      const stamp = { source: 'brandfetch', domain: facts.domain, at: new Date().toISOString() };
      const sources: Record<string, unknown> = {};
      const take = (field: string, value: unknown) => { if (value != null) { next[field] = value; sources[field] = stamp; } };
      if (fields.includes('description')) take('description', facts.description);
      if (fields.includes('logo')) take('logo_url', facts.logoUrl);
      if (fields.includes('linkedin')) take('linkedin', facts.linkedin);
      if (fields.includes('foundedYear')) take('founded_year', facts.foundedYear);
      if (fields.includes('location') && (facts.city || facts.country)) {
        take('address', { ...((before.address as object) ?? {}), ...(facts.city ? { city: facts.city } : {}), ...(facts.country ? { country: facts.country } : {}) });
        if (facts.country) next.country_code = facts.country;
      }
      if (!Object.keys(next).length) throw Errors.badRequest('nothing_found', 'Brandfetch returned none of the chosen fields');
      next.field_sources = { ...((before.field_sources as object) ?? {}), ...sources };
      const changes = diff(before, next);
      await companies.updateOne({ id }, { $set: next });
      await this.audit.record(tx, { tenantId: null, action: 'platform.company_data_applied', resourceType: 'company', resourceId: id, changes, metadata: { source: 'brandfetch', domain: facts.domain, fields } });
      return this.profileView({ ...before, ...next }, canSeePii());
    });
  }

  /** Companies for pickers (add a workspace to, move to): id and name. */
  async options() {
    return this.db.platform(async (tx) => (await tx.collection<{ id: string; name: string }>('companies').find({ archived_at: null }, { sort: { name: 1 }, projection: { id: 1, name: 1 }, limit: 2000 })).map((c) => ({ id: c.id, name: c.name })));
  }

  /** Active Console admins who can be a company's account manager (id and name only). */
  async managers() {
    return this.db.platform(async (tx) => (await tx.collection<{ id: string; full_name: string }>('platform_admins').find({ status: 'active' }, { sort: { full_name: 1 }, projection: { id: 1, full_name: 1 }, limit: 500 })).map((a) => ({ id: a.id, name: a.full_name })));
  }

  private async requireOpenPlan(key: string) {
    const p = await this.db.platform((tx) => tx.collection<{ archived_at: Date | null; retired_at: Date | null }>('plans').findOne({ key }));
    if (!p) throw Errors.badRequest('unknown_plan', 'Unknown plan');
    if (p.archived_at || p.retired_at) throw Errors.badRequest('plan_closed', 'This plan is retired or archived and takes no new companies');
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
