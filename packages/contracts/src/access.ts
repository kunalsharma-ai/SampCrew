import { z } from 'zod';
import { BOOLEAN_FEATURES, isCoreFeature } from './features';
import { isPermissionKey } from './permissions';

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
export type FeatureBlockReason = 'not_in_plan' | 'workspace_off' | 'member_blocked';

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
  updatedAt: string | null;
}

export interface MemberAccessRow {
  membershipId: string; fullName: string; email: string; status: string;
  roles: string[]; blockedFeatures: string[];
}
