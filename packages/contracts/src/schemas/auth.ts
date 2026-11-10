import { z } from 'zod';
import { email, name, slug, countryCode, currencyCode, timezone } from './common';


/** 12+ characters, at least three of: lowercase, uppercase, digit, symbol. */
export const password = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200)
  .refine((v) => [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length >= 3, {
    message: 'Use at least three of: lowercase, uppercase, numbers, symbols',
  });

export const loginRequest = z.object({
  email,
  password: z.string().min(1).max(200),
  tenantSlug: slug.optional(),
});
export type LoginRequest = z.infer<typeof loginRequest>;

export const mfaVerifyRequest = z.object({
  mfaToken: z.string().min(10),
  code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code'),
});

export const refreshRequest = z.object({ refreshToken: z.string().min(20) });

export const switchTenantRequest = z.object({ tenantId: z.uuid() });

export const signupRequest = z.object({
  companyName: name,
  slug,
  fullName: name,
  email,
  password,
  countryCode,
  currency: currencyCode,
  timezone,
  acceptTerms: z.literal(true, { error: 'You must accept the terms' }),
});
export type SignupRequest = z.infer<typeof signupRequest>;

export const acceptInviteRequest = z.object({
  token: z.string().min(20),
  fullName: name,
  password,
});

export const mfaEnableRequest = z.object({ code: z.string().regex(/^\d{6}$/) });

export const changePasswordRequest = z.object({ currentPassword: z.string().min(1), newPassword: password });

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type LoginResponse =
  | ({ status: 'ok' } & TokenPair)
  | { status: 'mfa_required'; mfaToken: string }
  | { status: 'select_tenant'; tenants: { id: string; name: string; slug: string }[]; selectToken: string }
  /** HR created this login with a temporary password: the person chooses their own before going on. */
  | { status: 'password_change_required'; changeToken: string };

export const initialPasswordRequest = z.object({ changeToken: z.string().min(10), newPassword: password });

export const selectTenantRequest = z.object({ selectToken: z.string().min(10), tenantId: z.uuid() });

export interface MeResponse {
  user: { id: string; email: string; fullName: string; mfaEnabled: boolean };
  tenant: {
    id: string; name: string; slug: string; isDemo: boolean; status: string; timezone: string; currency: string; locale: string;
    /** When the first-login company setup was finished (null: not yet, so admins are taken through it). */
    setupCompletedAt: string | null;
  };
  membership: { id: string; status: string; roles: { key: string; name: string }[] };
  permissions: Record<string, string>;
  features: string[];
  /**
   * Modules the plan includes that SAMPLEDGE switched off for the workspace (workspace_off), for this member
   * (member_blocked) or in the app this session uses (channel_off).
   */
  featureBlocks: Record<string, 'workspace_off' | 'member_blocked' | 'channel_off'>;
  /** The app this session was opened in. */
  client: 'web' | 'mobile' | 'api';
  /** Permissions SAMPLEDGE switched off for the whole workspace: no role can grant them. */
  disabledPermissions: string[];
  limits: Record<string, number>;
  subscription: { plan: string; status: string; trialEndsOn: string | null; /** Read-only for an overdue invoice. */ locked: boolean } | null;
  session: { mfa: boolean };
  tenants: { id: string; name: string; slug: string }[];
  /** This person's own employee record in the workspace, if their login is linked to one, for their photo. */
  employee: { id: string; photoUpdatedAt: string | null } | null;
}
