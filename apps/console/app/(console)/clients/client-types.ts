import type { ClientStatus } from '@crew/contracts';

/** The Company 360 answer from GET /platform/clients/:id (money and contact details by permission). */
export interface ClientDetail {
  profile: {
    id: string; name: string; legalName: string | null; industry: string | null; description: string | null; website: string | null; linkedin: string | null;
    email: string | null; phone: string | null; whatsapp: string | null; foundedYear: number | null; companySize: string | null; countryCode: string | null;
    address: { line1?: string | null; line2?: string | null; city?: string | null; state?: string | null; postalCode?: string | null; country?: string | null } | null;
    logoUrl: string | null; tags: string[];
    primaryContact: { name: string | null; title: string | null; email: string | null; phone: string | null } | null;
    accountManagerId: string | null; isDemo: boolean; archivedAt: string | null; createdAt: string | null;
    fieldSources: Record<string, { source?: string; domain?: string; at?: string } | undefined>; piiMasked: boolean;
  };
  status: ClientStatus; statusLabel: string;
  accountManager: { id: string; name: string } | null;
  totals: { superWorkspaces: number; hrWorkspaces: number; employeeWorkspaces: number; users: number; activeUsers: number; inactiveUsers: number; pendingInvitations: number; employees: number; hrUsers: number };
  workspaces: {
    id: string; name: string; slug: string; status: string; isDemo: boolean; createdAt: string; setupDone: boolean;
    plan: { key: string; name: string } | null;
    subscription: { status: string; seats: number; billingCycle: string; currency: string; trialEndsOn: string | null; currentPeriodEnd: string; cancelAtPeriodEnd: boolean; unitPrice?: string; mrr?: string } | null;
    counts: { users: number; activeUsers: number; invited: number; hrUsers: number; employees: number; hrWorkspaces: number; employeeWorkspaces: number };
    hrWorkspaces: { id: string | null; name: string; status: string; people: number }[];
    lastActivityAt: string | null;
    revenue?: Record<string, string>; outstanding?: Record<string, string>; overdue?: boolean;
  }[];
  superWorkspaceAdmins: { workspaceId: string; name: string; email: string | null }[];
  money: { revenue: Record<string, string>; outstanding: Record<string, string>; mrr: Record<string, string> } | null;
  support: { openConversations: number; openTickets: number };
}
