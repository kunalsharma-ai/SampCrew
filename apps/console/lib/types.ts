export interface Admin { id: string; email: string; fullName: string; role: 'super_admin' | 'support' | 'billing_ops' | 'viewer'; mfaEnabled: boolean; session: { mfa: boolean } }

export interface TenantRow {
  id: string; name: string; slug: string; status: string; region: string; countryCode: string; isDemo: boolean; createdAt: string;
  plan: string | null; subscriptionStatus: string | null; seats: number | null; trialEndsOn: string | null; activeMembers: number;
}

export interface TenantDetail {
  id: string; name: string; slug: string; status: string; statusReason: string | null; region: string; countryCode: string; timezone: string; currency: string;
  isDemo: boolean; requireMfa: boolean; createdAt: string;
  subscription: { plan: string; planName: string; status: string; billingCycle: string; seats: number; currency: string; unitPrice: string; trialEndsOn: string | null; currentPeriodEnd: string | null; featureOverrides: Record<string, boolean | number>; provider: string } | null;
  activeMembers: number; pendingInvites: number; legalEntities: number; lastActivityAt: string | null; aiCreditsThisMonth: number;
  supportAccess: { id: string; reason: string; status: string; durationMinutes: number; createdAt: string; expiresAt: string | null; requestedBy: string }[];
}

export interface Page<T> { items: T[]; nextCursor: string | null }
