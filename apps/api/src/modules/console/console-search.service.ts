import { Injectable } from '@nestjs/common';
import { SEARCH_TYPES, type SearchHit, type SearchResults, type SearchType } from '@crew/contracts';
import { requestContext } from '../../platform/context/request-context';
import { MongoService as DatabaseService } from '../../platform/database/mongo.service';
import { canSeePii, maskEmail } from './companies.service';

/** The permission each result type needs; a type the admin cannot open is skipped (and listed as skipped). */
const NEEDS: Record<SearchType, string> = {
  company: 'tenants:read', workspace: 'tenants:read', hr_workspace: 'tenants:read', user: 'users:read', subscription: 'billing:read', invoice: 'billing:read', payment: 'billing:read',
  plan: 'billing:read', conversation: 'support:chat', ticket: 'help:answer', audit: 'audit:read', admin: 'admins:manage',
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Console global search (Ctrl+K). Looks across client companies, Super and HR Workspaces, users, subscriptions,
 * invoices, payments, plans, support conversations and tickets, the audit log and Console admins, each only when
 * the admin's role can open it. Users are found by name or full email only and shown with a masked email unless the
 * role has users:pii; searching never reaches employee records, messages or documents.
 */
@Injectable()
export class ConsoleSearchService {
  constructor(private readonly db: DatabaseService) {}

  search(q: string, types: string | undefined, limit: number): Promise<SearchResults> {
    const perms = requestContext.platformActor().permissions;
    const asked = types ? (types.split(',').filter((t) => (SEARCH_TYPES as readonly string[]).includes(t)) as SearchType[]) : [...SEARCH_TYPES];
    const allowed = asked.filter((t) => perms.includes(NEEDS[t]));
    const skipped = asked.filter((t) => !allowed.includes(t));
    const term = q.trim();
    const rx = { $regex: escape(term), $options: 'i' };
    return this.db.platform(async (tx) => {
      const tenantNames = new Map<string, string>();
      const nameOf = async (ids: string[]) => {
        const missing = [...new Set(ids)].filter((id) => id && !tenantNames.has(id));
        if (missing.length) for (const t of await tx.collection<{ id: string; name: string }>('tenants').find({ id: { $in: missing } }, { projection: { name: 1 } })) tenantNames.set(t.id, t.name);
        return (id: string) => tenantNames.get(id) ?? null;
      };
      const run: Record<SearchType, () => Promise<SearchHit[]>> = {
        company: async () => (await tx.collection<{ id: string; name: string; website: string | null; legal_name: string | null }>('companies').find({ $or: [{ name: rx }, { legal_name: rx }, { website: rx }] }, { limit, sort: { name: 1 } }))
          .map((c) => ({ type: 'company', id: c.id, title: c.name, subtitle: c.website ?? c.legal_name ?? null, href: `/clients/${c.id}` })),
        workspace: async () => (await tx.collection<{ id: string; name: string; slug: string; status: string }>('tenants').find({ $or: [{ name: rx }, { slug: rx }, ...(isUuid(term) ? [{ id: term }] : [])] }, { limit, sort: { name: 1 } }))
          .map((t) => ({ type: 'workspace', id: t.id, title: t.name, subtitle: `Super Workspace · ${t.slug}${t.status !== 'active' ? ` · ${t.status}` : ''}`, href: `/tenants/${t.id}` })),
        hr_workspace: async () => {
          const rows = await tx.collection<{ id: string; name: string; tenant_id: string; status: string }>('hr_workspaces').find({ name: rx, archived_at: null }, { limit, sort: { name: 1 } });
          const n = await nameOf(rows.map((r) => r.tenant_id));
          return rows.map((r) => ({ type: 'hr_workspace', id: r.id, title: r.name, subtitle: `HR Workspace in ${n(r.tenant_id) ?? 'a Super Workspace'}`, href: `/tenants/${r.tenant_id}?tab=hierarchy` }));
        },
        user: async () => {
          // A full email address or part of a name; never a partial email, so the search cannot be used to list addresses.
          const filter = term.includes('@') ? { email: term.toLowerCase() } : { full_name: rx };
          const users = await tx.collection<{ id: string; email: string; full_name: string }>('users').find(filter, { limit, projection: { email: 1, full_name: 1 } });
          const ms = await tx.collection<{ user_id: string; tenant_id: string }>('memberships').find({ user_id: { $in: users.map((u) => u.id) } }, { projection: { user_id: 1, tenant_id: 1 } });
          const n = await nameOf(ms.map((m) => m.tenant_id));
          const pii = canSeePii();
          return users.map((u) => {
            const m = ms.find((x) => x.user_id === u.id);
            return { type: 'user', id: u.id, title: u.full_name, subtitle: [pii ? u.email : maskEmail(u.email), m ? n(m.tenant_id) : null].filter(Boolean).join(' · '), href: m ? `/tenants/${m.tenant_id}?tab=users` : '/users' };
          });
        },
        subscription: async () => {
          const plans = await tx.collection<{ id: string; name: string }>('plans').find({ $or: [{ name: rx }, { key: rx }] }, { projection: { name: 1 } });
          const tenants = await tx.collection<{ id: string; name: string }>('tenants').find({ name: rx }, { projection: { name: 1 }, limit: 50 });
          for (const t of tenants) tenantNames.set(t.id, t.name);
          const subs = await tx.collection<{ id: string; tenant_id: string; plan_id: string; status: string; provider_ref: string | null }>('subscriptions')
            .find({ $or: [{ provider_ref: term }, { tenant_id: { $in: tenants.map((t) => t.id) } }, { plan_id: { $in: plans.map((p) => p.id) } }] }, { limit, sort: { updated_at: -1 } });
          const n = await nameOf(subs.map((s) => s.tenant_id));
          const planName = new Map((await tx.collection<{ id: string; name: string }>('plans').find({ id: { $in: subs.map((s) => s.plan_id) } }, { projection: { name: 1 } })).map((p) => [p.id, p.name]));
          return subs.map((s) => ({ type: 'subscription', id: s.id, title: `${n(s.tenant_id) ?? 'Workspace'} · ${planName.get(s.plan_id) ?? 'plan'}`, subtitle: `Subscription · ${s.status.replace('_', ' ')}`, href: `/tenants/${s.tenant_id}?tab=billing` }));
        },
        invoice: async () => {
          const rows = await tx.collection<{ id: string; number: string; tenant_id: string; status: string; total: unknown; currency: string }>('invoices').find({ $or: [{ number: rx }, { provider_ref: term }, { paid_reference: term }] }, { limit, sort: { created_at: -1 } });
          const n = await nameOf(rows.map((r) => r.tenant_id));
          return rows.map((r) => ({ type: 'invoice', id: r.id, title: r.number, subtitle: `${n(r.tenant_id) ?? ''} · ${r.currency} ${String(r.total)} · ${r.status}`, href: `/billing?tab=invoices&q=${encodeURIComponent(r.number)}` }));
        },
        payment: async () => {
          const rows = await tx.collection<{ id: string; tenant_id: string; status: string; amount: unknown; currency: string; provider: string; provider_payment_id: string | null; provider_order_id: string | null }>('payment_orders')
            .find({ $or: [{ provider_payment_id: term }, { provider_order_id: term }, ...(isUuid(term) ? [{ id: term }] : [])] }, { limit, sort: { created_at: -1 } });
          const n = await nameOf(rows.map((r) => r.tenant_id));
          return rows.map((r) => ({ type: 'payment', id: r.id, title: r.provider_payment_id ?? r.provider_order_id ?? r.id, subtitle: `${n(r.tenant_id) ?? ''} · ${r.currency} ${String(r.amount)} · ${r.provider} ${r.status}`, href: `/tenants/${r.tenant_id}?tab=billing` }));
        },
        plan: async () => (await tx.collection<{ key: string; name: string; archived_at: Date | null; retired_at: Date | null }>('plans').find({ $or: [{ name: rx }, { key: rx }] }, { limit, sort: { sort_order: 1 } }))
          .map((p) => ({ type: 'plan', id: p.key, title: p.name, subtitle: `Plan · ${p.retired_at ? 'retired' : p.archived_at ? 'archived' : 'active'}`, href: `/plans/${p.key}` })),
        conversation: async () => {
          const num = /^#?\d+$/.test(term) ? Number(term.replace('#', '')) : null;
          const rows = await tx.collection<{ id: string; subject: string; number: number; tenant_id: string; status: string }>('support_conversations').find({ $or: [{ subject: rx }, ...(num ? [{ number: num }] : [])] }, { limit, sort: { last_message_at: -1 } });
          const n = await nameOf(rows.map((r) => r.tenant_id));
          return rows.map((r) => ({ type: 'conversation', id: r.id, title: r.subject, subtitle: `#${r.number} · ${n(r.tenant_id) ?? ''} · ${r.status}`, href: `/support?id=${r.id}` }));
        },
        ticket: async () => {
          const num = /^#?\d+$/.test(term) ? Number(term.replace('#', '')) : null;
          // Only tickets sent to SampCrew support (route console); tickets inside a client's own workspace stay private.
          const rows = await tx.collection<{ id: string; subject: string; number: number; tenant_id: string; status: string }>('help_queries').find({ route: 'console', $or: [{ subject: rx }, ...(num ? [{ number: num }] : [])] }, { limit, sort: { created_at: -1 } });
          const n = await nameOf(rows.map((r) => r.tenant_id));
          return rows.map((r) => ({ type: 'ticket', id: r.id, title: r.subject, subtitle: `Ticket #${r.number} · ${n(r.tenant_id) ?? ''} · ${r.status.replace('_', ' ')}`, href: `/help-queries?id=${r.id}` }));
        },
        audit: async () => (await tx.collection<{ id: string; action: string; actor_label: string | null; created_at: Date }>('audit_events').find({ tenant_id: null, $or: [{ action: rx }, { actor_label: rx }, { resource_id: term }] }, { limit, sort: { created_at: -1 } }))
          .map((e) => ({ type: 'audit', id: e.id, title: e.action.replace(/^platform\./, '').replace(/[._]/g, ' '), subtitle: `${e.actor_label ?? 'system'} · ${e.created_at.toISOString().slice(0, 16).replace('T', ' ')} UTC`, href: `/audit?q=${encodeURIComponent(e.action)}` })),
        admin: async () => (await tx.collection<{ id: string; email: string; full_name: string; role: string }>('platform_admins').find({ $or: [{ full_name: rx }, { email: rx }] }, { limit }))
          .map((a) => ({ type: 'admin', id: a.id, title: a.full_name, subtitle: `${a.email} · ${a.role}`, href: '/admins' })),
      };
      const hits: SearchHit[] = [];
      for (const t of allowed) hits.push(...(await run[t]()));
      return { q: term, hits, skipped };
    });
  }
}

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
