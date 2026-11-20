import { z } from 'zod';
import { BOOLEAN_FEATURES, isCoreFeature, UNLIMITED } from './features';

/**
 * The four levels of SampCrew. Authority flows down, reporting flows up:
 *
 *   Console (SAMPLEDGE)  ->  Super Workspace (a customer company, the tenant)
 *                        ->  HR Workspace (a department, branch or region inside the company)
 *                        ->  Employee Workspace (each person's self-service)
 *
 * A level can only pass down what it holds itself: the company's modules are what the Console gives it (plan,
 * add-ons, deals and Console switches); an HR Workspace gets a subset of the company's modules that the Console
 * allows to be delegated; an employee gets a subset of their HR Workspace's modules (or of the company's, for the
 * central group). Every level is checked by the API on every request, never only by what a screen shows.
 */
export const PLATFORM_LEVELS = ['console', 'super', 'hr', 'employee'] as const;
export type PlatformLevel = (typeof PLATFORM_LEVELS)[number];

export const PLATFORM_LEVEL_LABEL: Record<PlatformLevel, string> = {
  console: 'Console',
  super: 'Super Workspace',
  hr: 'HR Workspace',
  employee: 'Employee Workspace',
};

/** The products a person signed in to a company can switch between in the web app, one per level they hold. */
export const WORKSPACE_PRODUCTS = ['super', 'hr', 'employee'] as const;
export type WorkspaceProduct = (typeof WORKSPACE_PRODUCTS)[number];

export const HR_WORKSPACE_KINDS = ['department', 'branch', 'region', 'business_unit', 'other'] as const;
export type HrWorkspaceKind = (typeof HR_WORKSPACE_KINDS)[number];
export const HR_WORKSPACE_KIND_LABEL: Record<HrWorkspaceKind, string> = {
  department: 'Department', branch: 'Branch', region: 'Region', business_unit: 'Business unit', other: 'Other',
};

export const HR_WORKSPACE_STATUSES = ['active', 'suspended', 'archived'] as const;
export type HrWorkspaceStatus = (typeof HR_WORKSPACE_STATUSES)[number];

const moduleKey = z.string().refine((k) => BOOLEAN_FEATURES.some((f) => f.key === k), 'Unknown module');
const modules = z.array(moduleKey).max(100).transform((a) => [...new Set(a)].sort());
const uuids = (max: number) => z.array(z.uuid()).max(max).transform((a) => [...new Set(a)]);

/** -1 for no limit of its own (the company's limit still applies). */
const employeeLimit = z.number().int().min(UNLIMITED).max(1_000_000);

export const hrWorkspaceInput = z.object({
  name: z.string().trim().min(2, 'At least 2 characters').max(80),
  code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{1,19}$/, 'Use 2 to 20 capital letters, digits, - or _').optional(),
  kind: z.enum(HR_WORKSPACE_KINDS).default('department'),
  description: z.string().trim().max(500).default(''),
  /** Modules the HR Workspace may use and hand to its employees: a subset of the company's delegable modules. */
  features: modules,
  maxEmployees: employeeLimit.default(UNLIMITED),
  /** People who run it (they get the HR Workspace Admin role, limited to this HR Workspace). */
  adminMembershipIds: uuids(20).default([]),
  /** Organisation units it usually looks after; informational and used to suggest employees. */
  departmentIds: uuids(200).default([]),
  locationIds: uuids(200).default([]),
}).strict();
export type HrWorkspaceInput = z.infer<typeof hrWorkspaceInput>;

export const hrWorkspaceUpdate = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  code: z.string().trim().regex(/^[A-Z0-9][A-Z0-9_-]{1,19}$/, 'Use 2 to 20 capital letters, digits, - or _').nullable().optional(),
  kind: z.enum(HR_WORKSPACE_KINDS).optional(),
  description: z.string().trim().max(500).optional(),
  features: modules.optional(),
  maxEmployees: employeeLimit.optional(),
  departmentIds: uuids(200).optional(),
  locationIds: uuids(200).optional(),
  /** The version the change was made on, so two admins editing at once do not overwrite each other. */
  version: z.number().int().min(1).optional(),
}).strict().refine((v) => Object.keys(v).some((k) => k !== 'version'), 'Nothing to change');
export type HrWorkspaceUpdate = z.infer<typeof hrWorkspaceUpdate>;

export const hrWorkspaceStatusInput = z.object({
  status: z.enum(HR_WORKSPACE_STATUSES),
  reason: z.string().trim().min(5, 'At least 5 characters').max(300),
}).strict();

export const hrWorkspaceAdminsInput = z.object({ membershipIds: uuids(20) }).strict();

/** Assign employees to an HR Workspace (people in the central group or in another HR Workspace are moved). */
export const hrWorkspaceAssignInput = z.object({
  employeeIds: uuids(500).refine((a) => a.length > 0, 'Choose at least one person'),
  reason: z.string().trim().min(3, 'At least 3 characters').max(300),
}).strict();

/**
 * The modules one employee gets, chosen by their HR Workspace admins or the Super Workspace. Only modules the
 * person's HR Workspace (or, in the central group, the company) holds can be given; the rest are taken away.
 */
export const memberModulesInput = z.object({
  modules: modules,
  version: z.number().int().min(0).optional(),
}).strict();

/** Move an employee to another HR Workspace, or to the central group (null). History stays with the person. */
export const employeeTransferInput = z.object({
  employeeId: z.uuid(),
  toHrWorkspaceId: z.uuid().nullable(),
  reason: z.string().trim().min(3, 'At least 3 characters').max(300),
}).strict();

/** Console: which of a company's modules its Super Workspace may NOT pass down to HR Workspaces. */
export const delegationPolicyInput = z.object({
  nonDelegableFeatures: z.array(moduleKey.refine((k) => !isCoreFeature(k), 'Core HR is always delegable')).max(100).transform((a) => [...new Set(a)].sort()),
  /** Whether the Super Workspace may create employees directly (outside any HR Workspace). */
  superMayCreateEmployees: z.boolean().optional(),
}).strict();

export const hrWorkspaceListQuery = z.object({
  status: z.enum(['active', 'suspended', 'archived', 'all']).default('active'),
  q: z.string().trim().max(100).optional(),
});

export const hrWorkspaceMembersQuery = z.object({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** Why a module is or is not available at one level of the chain, for the delegation screens. */
export type DelegationState =
  /** Held by the parent and given here. */
  | 'granted'
  /** Held by the parent, not given here. */
  | 'available'
  /** The parent does not hold it (or the Console keeps it at company level), so it cannot be given. */
  | 'locked';

export interface DelegatedModule {
  key: string; name: string; module: string; core: boolean;
  state: DelegationState;
  /** For a locked module: which level holds it back. */
  lockedBy: PlatformLevel | null;
  /** Given here earlier but no longer held above, so it has no effect (cleared on the next recalculation). */
  stale?: boolean;
}

export interface HrWorkspaceSummary {
  id: string; name: string; code: string | null; kind: HrWorkspaceKind; description: string; status: HrWorkspaceStatus;
  features: string[]; maxEmployees: number;
  employees: number; admins: { membershipId: string; name: string | null; email: string | null }[];
  version: number; updatedAt: string; createdAt: string;
}

export interface HrWorkspaceDetail extends HrWorkspaceSummary {
  departmentIds: string[]; locationIds: string[];
  modules: DelegatedModule[];
  /** What the company itself holds right now (the parent of this HR Workspace). */
  parentFeatures: string[];
  usage: { employees: number; limit: number; companyEmployees: number; companyLimit: number | null };
  can: { manage: boolean; assignModules: boolean; transfer: boolean };
}

export interface HierarchyMemberRow {
  employeeId: string; membershipId: string | null; name: string; code: string; email: string | null;
  department: string | null; status: string; hrWorkspaceId: string | null; hrWorkspaceName: string | null;
  /** Modules this person gets, after every level above. */
  modules: string[];
  /** Modules their HR Workspace (or the company) holds that were not given to them. */
  withheld: string[];
  version: number;
}

export interface ConfigVersionRow {
  id: string; version: number; level: PlatformLevel; targetType: 'company' | 'hr_workspace' | 'member';
  targetId: string; targetName: string | null; action: string;
  changes: Record<string, { from: unknown; to: unknown }>;
  actorName: string | null; createdAt: string;
}

export interface TransferRow {
  id: string; employeeId: string; employeeName: string | null;
  fromHrWorkspaceId: string | null; fromName: string | null; toHrWorkspaceId: string | null; toName: string | null;
  reason: string; byName: string | null; createdAt: string;
}

/** The company as the Super Workspace sees it: its HR Workspaces, the central group and how modules flow. */
export interface HierarchyOverview {
  company: { id: string; name: string; features: string[]; nonDelegable: string[]; superMayCreateEmployees: boolean; employees: number; employeeLimit: number | null; hrWorkspaceLimit: number | null };
  central: { employees: number };
  hrWorkspaces: HrWorkspaceSummary[];
  levels: { super: boolean; hrWorkspaceIds: string[] };
}

/**
 * The level name a signed-in person is shown under their name ("Super Workspace", "HR Workspace" or "Employee
 * Workspace"), never a job title or role name. An HR Workspace admin of exactly one HR Workspace also sees its name.
 */
export function workspaceLevelLabel(levels: { super: boolean; companyHr: boolean; hrWorkspaces: { name: string }[] } | null | undefined, opts: { withName?: boolean } = {}): string {
  if (!levels) return PLATFORM_LEVEL_LABEL.employee;
  if (levels.super) return PLATFORM_LEVEL_LABEL.super;
  if (levels.hrWorkspaces.length === 1 && opts.withName) return `${PLATFORM_LEVEL_LABEL.hr} · ${levels.hrWorkspaces[0]!.name}`;
  if (levels.hrWorkspaces.length || levels.companyHr) return PLATFORM_LEVEL_LABEL.hr;
  return PLATFORM_LEVEL_LABEL.employee;
}
