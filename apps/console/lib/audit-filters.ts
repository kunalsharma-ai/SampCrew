/** Audit log filters, shared by the server pages that read them and the client view that edits them. */
export type AuditFilters = Partial<Record<'q' | 'area' | 'status' | 'actorType' | 'from' | 'to' | 'scope' | 'cursor' | 'tenantId' | 'clientId', string>>;

export const AREAS = [['companies', 'Companies'], ['workspaces', 'Workspaces'], ['users', 'Users'], ['plans', 'Plans'], ['billing', 'Billing'], ['admins', 'Console admins'], ['security', 'Security'], ['communication', 'Communication'], ['settings', 'Settings'], ['other', 'Other']] as const;
export const ACTOR: Record<string, string> = { platform_admin: 'Console admin', user: 'Client user', system: 'System', ai_agent: 'AI agent', integration: 'Integration' };

const AUDIT_KEYS = ['q', 'area', 'status', 'actorType', 'from', 'to', 'scope', 'cursor', 'tenantId', 'clientId'] as const;
/** Reads audit filters from the address, keeping only well-formed values. */
export function auditFiltersFrom(sp: Record<string, string | undefined>): AuditFilters {
  const f: AuditFilters = {};
  for (const k of AUDIT_KEYS) if (sp[k]) f[k] = String(sp[k]).slice(0, 200);
  if (f.area && !AREAS.some(([a]) => a === f.area)) delete f.area;
  if (f.status && !['success', 'denied', 'failed'].includes(f.status)) delete f.status;
  if (f.actorType && !(f.actorType in ACTOR)) delete f.actorType;
  if (f.scope && !['platform', 'all'].includes(f.scope)) delete f.scope;
  for (const k of ['from', 'to'] as const) if (f[k] && !/^\d{4}-\d{2}-\d{2}$/.test(f[k]!)) delete f[k];
  for (const k of ['tenantId', 'clientId'] as const) if (f[k] && !/^[0-9a-f-]{36}$/i.test(f[k]!)) delete f[k];
  return f;
}
