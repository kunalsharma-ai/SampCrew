import { z } from 'zod';
import { email, name, slug, countryCode, currencyCode, timezone } from './common';
import type { FeatureBlockReason } from '../access';


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
  featureBlocks: Record<string, Exclude<FeatureBlockReason, 'not_in_plan'>>;
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
  /**
   * The levels of the company this person works at, which decide the products they can switch between: the Super
   * Workspace (company-wide administrators), the HR Workspaces they run, and their own Employee Workspace.
   */
  levels: {
    super: boolean;
    hrWorkspaces: { id: string; name: string; status: string }[];
    /** Company-wide HR (an HR Admin not limited to HR Workspaces) also works at the HR level, for the central group. */
    companyHr: boolean;
    employee: boolean;
    /** The HR Workspace looking after this person's own employee record (null: the central group). */
    ownHrWorkspace: { id: string; name: string } | null;
  };
}

/**
 * First-run setup of a new installation: the first SAMPLEDGE Super admin is created in the Console with the one-time
 * setup code the API prints in its log, instead of a password kept in the server's settings file.
 */
export const firstAdminRequest = z.object({
  setupCode: z.string().trim().min(8).max(40),
  fullName: z.string().trim().min(2).max(120),
  email,
  password,
}).strict();
export type FirstAdminRequest = z.infer<typeof firstAdminRequest>;

// ---------------------------------------------------------------------------
// Forgot password (every level: Console, Super, HR and Employee Workspace; web and phone app)
// ---------------------------------------------------------------------------

/** How long a reset link or code works. */
export const PASSWORD_RESET_TTL_MINUTES = 30;

export const passwordResetRequest = z.object({ email });

export const passwordResetCheck = z.object({ token: z.string().min(20).max(200) });

/** A new password with either the emailed link (token) or the 6-digit code from the same email and the address. */
export const passwordResetComplete = z
  .object({
    token: z.string().min(20).max(200).optional(),
    email: email.optional(),
    code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code from the email').optional(),
    newPassword: password,
  })
  .refine((v) => Boolean(v.token) || (Boolean(v.email) && Boolean(v.code)), { message: 'Open the link in the email, or enter your email and the 6-digit code', path: ['code'] });
export type PasswordResetComplete = z.infer<typeof passwordResetComplete>;

export const PASSWORD_RESET_LEVELS = ['console', 'super', 'hr', 'employee'] as const;
export type PasswordResetLevel = (typeof PASSWORD_RESET_LEVELS)[number];
export const PASSWORD_RESET_LEVEL_LABEL: Record<PasswordResetLevel, string> = { console: 'Console Admin', super: 'Super Workspace', hr: 'HR Workspace', employee: 'Employee Workspace' };

/** As shown in the lists: "expired" is a pending request whose time ran out. */
export const PASSWORD_RESET_STATUSES = ['pending', 'completed', 'expired', 'replaced', 'locked', 'no_account', 'inactive', 'limited'] as const;
export type PasswordResetStatus = (typeof PASSWORD_RESET_STATUSES)[number];
export const PASSWORD_RESET_STATUS_LABEL: Record<PasswordResetStatus, string> = {
  pending: 'Email sent, not used yet',
  completed: 'Password changed',
  expired: 'Expired unused',
  replaced: 'Replaced by a newer request',
  locked: 'Stopped after wrong codes',
  no_account: 'No account with this email',
  inactive: 'Account not active',
  limited: 'Too many requests',
};

export const passwordResetsQuery = z.object({
  level: z.enum(PASSWORD_RESET_LEVELS).optional(),
  status: z.enum(PASSWORD_RESET_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  tenantId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

export interface PasswordResetRow {
  id: string;
  email: string;
  fullName: string | null;
  level: PasswordResetLevel | null;
  workspaces: { id: string; name: string; level: PasswordResetLevel }[];
  status: PasswordResetStatus;
  /** What happened to the email: queued, sent, failed, skipped (email not set up in Console > Integrations); null when none was sent. */
  delivery: 'queued' | 'sent' | 'failed' | 'skipped' | 'cancelled' | null;
  deliveryError: string | null;
  client: 'web' | 'mobile' | 'api' | 'console';
  ip: string | null;
  requestedAt: string;
  expiresAt: string;
  completedAt: string | null;
  sessionsRevoked: number;
}

export interface PasswordResetList {
  items: PasswordResetRow[];
  total: number;
  /** Counts over the last 30 days, for the summary tiles. */
  summary: { requested: number; completed: number; pending: number; failedDelivery: number };
}
