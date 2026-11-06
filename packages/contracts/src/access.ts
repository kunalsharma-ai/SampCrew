import { z } from 'zod';
import { BOOLEAN_FEATURES, isCoreFeature } from './features';
import { isPermissionKey } from './permissions';
import { DEVICE_VENDORS } from './schemas/attendance';

/**
 * Workspace access controls, set by SAMPLEDGE in the Super Admin Console:
 *   - module switches (on, off, or follow the plan) for the whole workspace,
 *   - permission switches for the whole workspace (a disabled permission is removed from every role),
 *   - per-member module access (take modules away from one person).
 */

const booleanFeatureKey = z.string().refine((k) => BOOLEAN_FEATURES.some((f) => f.key === k), 'Unknown module');
const switchableFeatureKey = booleanFeatureKey.refine((k) => !isCoreFeature(k), 'Core HR is the foundation of every workspace and cannot be switched off');

export const FEATURE_SWITCH_STATES = ['plan', 'on', 'off'] as const;
export type FeatureSwitchState = (typeof FEATURE_SWITCH_STATES)[number];

export const featureSwitchUpdate = z.object({
  changes: z.array(z.object({ key: switchableFeatureKey, state: z.enum(FEATURE_SWITCH_STATES) }).strict()).min(1).max(100),
}).strict();

export const permissionSwitchUpdate = z.object({
  changes: z.array(z.object({ key: z.string().refine(isPermissionKey, 'Unknown permission'), enabled: z.boolean() }).strict()).min(1).max(200),
}).strict();

export const memberFeatureUpdate = z.object({
  blockedFeatures: z.array(switchableFeatureKey).max(100).transform((a) => [...new Set(a)].sort()),
}).strict();

export const memberAccessQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Why a module is unavailable to the current member; returned by /me so the apps can explain it. */
export type FeatureBlockReason = 'not_in_plan' | 'workspace_off' | 'member_blocked' | 'channel_off';

/** The two apps people use SampCrew through. API keys and integrations are not affected by app switches. */
export const APP_CHANNELS = ['web', 'mobile'] as const;
export type AppChannel = (typeof APP_CHANNELS)[number];

/**
 * Apps: switch the Web Portal or the mobile app off for a whole workspace, and modules off in one app only.
 * `modules` lists every module whose per-app state changes; a module missing from it keeps its state.
 */
export const channelSwitchUpdate = z.object({
  web: z.boolean().optional(),
  mobile: z.boolean().optional(),
  modules: z.array(z.object({ key: switchableFeatureKey, web: z.boolean(), mobile: z.boolean() }).strict()).max(100).optional(),
}).strict().refine((v) => v.web !== undefined || v.mobile !== undefined || (v.modules?.length ?? 0) > 0, 'Nothing to change')
  .refine((v) => v.web !== false || v.mobile !== false, { message: 'Keep at least one app on. To stop all access, suspend the workspace instead.', path: ['web'] });

export const deviceIntegrationUpdate = z.object({
  changes: z.array(z.object({ key: z.enum(DEVICE_VENDORS), enabled: z.boolean() }).strict()).min(1).max(DEVICE_VENDORS.length),
}).strict();

export const devicePauseRequest = z.object({ reason: z.string().trim().min(5, 'At least 5 characters').max(300) }).strict();

/** What SAMPLEDGE can do to one person in a workspace from the Console. */
export const MEMBER_ACTIONS = ['suspend', 'reactivate', 'sign_out', 'reset_mfa', 'resend_invite', 'reset_password', 'force_password_change', 'lock_account', 'unlock_account'] as const;
export type MemberAction = (typeof MEMBER_ACTIONS)[number];
export const memberActionRequest = z.object({
  action: z.enum(MEMBER_ACTIONS),
  reason: z.string().trim().min(5, 'At least 5 characters').max(300),
}).strict();

export const platformUsersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'invited', 'suspended']).optional(),
  tenantId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const activityQuery = z.object({
  q: z.string().trim().max(100).optional(),
  area: z.string().trim().regex(/^[a-z_]{1,40}$/).optional(),
  actorType: z.enum(['user', 'platform_admin', 'system', 'ai_agent', 'integration']).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const platformDevicesQuery = z.object({
  q: z.string().trim().max(100).optional(),
  tenantId: z.uuid().optional(),
  status: z.enum(['online', 'delayed', 'offline', 'waiting', 'error', 'simulated', 'paused']).optional(),
});

export interface WorkspaceChannels {
  web: boolean;
  mobile: boolean;
  /** Modules switched off in one app only. */
  webOff: string[];
  mobileOff: string[];
  /** Live sessions per app, so SAMPLEDGE sees who an app switch signs out. */
  liveSessions: { web: number; mobile: number };
}

export interface WorkspaceUserRow {
  membershipId: string; userId: string; fullName: string; email: string;
  /** Membership status in this workspace, and the account's own status (shared by every workspace the person is in). */
  status: 'active' | 'invited' | 'suspended'; accountStatus: string;
  roles: string[]; blockedFeatures: string[];
  mfaEnabled: boolean; lastLoginAt: string | null; invitedAt: string | null; joinedAt: string | null;
  /** Must choose a new password at the next sign-in (a temporary password from HR or SAMPLEDGE). */
  mustChangePassword: boolean;
  /** Set while sign-in is blocked after too many wrong passwords. */
  lockedUntil: string | null;
  liveSessions: { web: number; mobile: number };
  tenantId: string; tenantName: string; tenantSlug: string;
}

export interface ActivityRow {
  id: string; createdAt: string; action: string; area: string;
  actorType: string; actorLabel: string | null; resourceType: string; resourceId: string | null;
  client: string | null; ip: string | null;
  /** True when the event records changed values (shown on the event's own page; opening it is audited). */
  hasChanges: boolean;
}

/** One activity event with its recorded contents, for the SAMPLEDGE Super Admin. Every read is audited. */
export interface ActivityEventDetail extends ActivityRow {
  /** Changed values as { field: { from, to } } or the values recorded at creation. Secrets, bank and ID numbers are never stored. */
  changes: Record<string, unknown>;
  metadata: Record<string, unknown>;
  userAgent: string | null;
  requestId: string | null;
  /** Earlier and later events on the same record, newest first, with their contents. */
  history: (ActivityRow & { changes: Record<string, unknown> })[];
}

export interface WorkspaceAccess {
  plan: { key: string; name: string; status: string } | null;
  features: {
    key: string; name: string; module: string; core: boolean;
    inPlan: boolean; override: boolean | null; effective: boolean;
    /** Members of this workspace who have this module taken away. */
    blockedMembers: number;
  }[];
  permissions: {
    key: string; module: string; description: string; sensitive: boolean;
    enabled: boolean; feature: string | null; featureOn: boolean;
    /** Roles in this workspace that grant it, and how many members hold one of them. */
    roles: number; members: number;
  }[];
  channels: WorkspaceChannels;
  updatedAt: string | null;
}

export interface MemberAccessRow {
  membershipId: string; fullName: string; email: string; status: string;
  roles: string[]; blockedFeatures: string[];
}
