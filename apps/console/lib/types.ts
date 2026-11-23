import type { AnyStatutory } from '@crew/contracts';
export interface Admin { id: string; email: string; fullName: string; role: string; roleName?: string; permissions?: string[]; mfaEnabled: boolean; mustChangePassword: boolean; session: { mfa: boolean; id?: string } }

export interface TenantRow {
  id: string; name: string; slug: string; status: string; region: string; countryCode: string; isDemo: boolean; createdAt: string;
  plan: string | null; subscriptionStatus: string | null; seats: number | null; trialEndsOn: string | null; activeMembers: number;
}

export interface TenantDetail {
  id: string; name: string; slug: string; status: string; statusReason: string | null; region: string; countryCode: string; timezone: string; currency: string;
  isDemo: boolean; requireMfa: boolean; createdAt: string;
  subscription: { plan: string; planName: string; status: string; billingCycle: string; seats: number; currency: string; unitPrice: string; trialEndsOn: string | null; currentPeriodEnd: string | null; currentPeriodStart: string | null; cancelAtPeriodEnd: boolean; featureOverrides: Record<string, boolean | number>; provider: string } | null;
  activeMembers: number; pendingInvites: number; legalEntities: number; lastActivityAt: string | null; aiCreditsThisMonth: number;
  supportAccess: { id: string; reason: string; status: string; durationMinutes: number; createdAt: string; expiresAt: string | null; requestedBy: string }[];
  /** The company's four levels: Console Admin (SAMPLEDGE) > Super Workspace > HR Workspace > Employee Workspace. */
  hierarchy?: {
    consoleAdmin: string;
    superWorkspace: { name: string }[];
    hrWorkspaces: { id: string; name: string; status: string; admins: number; people: number }[];
    counts: { super: number; hr: number; companyHr: number; employee: number };
  };
}

export interface Page<T> { items: T[]; nextCursor: string | null }

export interface PlanSummary { key: string; name: string; features: { key: string; limitValue: number | null }[] }
export interface HistoryRow { id: string; action: string; actorLabel: string | null; changes: Record<string, unknown>; createdAt: string }

/** A payroll country pack as GET /platform/statutory-packs returns it. */
export interface StatutoryPackView {
  countryCode: string;
  country: string;
  currency: string;
  basis: string;
  summary: string;
  settings: AnyStatutory;
  active: boolean;
  builtIn: boolean;
  customisedAt: string | null;
  customisedBy: string | null;
  updatedAt: string;
}
