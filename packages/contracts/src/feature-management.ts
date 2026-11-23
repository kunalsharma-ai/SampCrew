import { z } from 'zod';
import { isFeaturePart, isSwitchableFeature, type FeatureIndicator, type PlatformFeatureState } from './feature-parts';
import { isCoreFeature } from './features';

/**
 * Feature management, top down: Console (whole application) > Super Workspace (the company, and what its HR Workspace
 * and Employee Workspace levels get) > HR Workspace (what Employee Workspace gets) > Employee Workspace (uses it).
 * Every switch takes a module key ("leave") or a part key ("leave.settings"). A lower level never switches on what a
 * higher level switched off; it is shown as restricted there.
 */
const switchKey = z.string().refine((k) => isSwitchableFeature(k) && (isFeaturePart(k) || !isCoreFeature(k)), 'Unknown feature, or one that is always on');

/** Console: switch a feature on or off for every company, or release a pending one. */
export const platformFeaturesInput = z.object({
  changes: z.array(z.object({ key: switchKey, state: z.enum(['active', 'off']) }).strict()).min(1).max(200),
  reason: z.string().trim().max(500).optional(),
}).strict();

/** Super Workspace: the company as a whole, the HR Workspace level, or the Employee Workspace level. */
export const FEATURE_TARGETS = ['company', 'hr', 'employee'] as const;
export type FeatureTarget = (typeof FEATURE_TARGETS)[number];
export const featureLevelsInput = z.object({
  changes: z.array(z.object({ key: switchKey, target: z.enum(FEATURE_TARGETS), enabled: z.boolean() }).strict()).min(1).max(200),
}).strict();

/** HR Workspace: Employee Workspace features for the central group or for one HR Workspace. */
export const employeeFeaturesQuery = z.object({ scope: z.union([z.literal('central'), z.uuid()]).default('central') });
export const employeeFeaturesInput = z.object({
  scope: z.union([z.literal('central'), z.uuid()]),
  changes: z.array(z.object({ key: switchKey, enabled: z.boolean() }).strict()).min(1).max(200),
}).strict();

export interface PlatformFeatureRow {
  key: string;
  name: string;
  module: string;
  /** Null for a module; the module key for a part. */
  parent: string | null;
  audience: 'employee' | 'hr' | 'admin' | null;
  core: boolean;
  state: PlatformFeatureState;
  /** Companies whose plan includes the module. */
  companies: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** One cell of the Super Workspace matrix or of the HR Workspace list. */
export interface FeatureCell {
  on: boolean;
  indicator: FeatureIndicator;
  /** Who restricts it when it is restricted: SAMPLEDGE (Console or plan), the Super Workspace or the company switch. */
  restrictedBy?: 'console' | 'plan' | 'super' | 'company' | 'hr_workspace' | 'level';
  /** Who switched it off when it is inactive: the Super Workspace or HR Workspace. */
  setBy?: 'super' | 'hr';
  /** Whether the person looking can change it. */
  editable: boolean;
}

export interface FeatureLevelRow {
  key: string;
  name: string;
  module: string;
  parent: string | null;
  audience: 'employee' | 'hr' | 'admin' | null;
  company: FeatureCell;
  hr: FeatureCell;
  employee: FeatureCell;
}

export interface EmployeeFeatureRow {
  key: string;
  name: string;
  module: string;
  parent: string | null;
  audience: 'employee' | 'hr' | 'admin' | null;
  cell: FeatureCell;
}

export interface EmployeeFeatureScope {
  id: 'central' | string;
  name: string;
}
