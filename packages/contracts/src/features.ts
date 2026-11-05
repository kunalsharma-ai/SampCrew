/**
 * Feature entitlements. A plan includes a set of features (boolean) and limits (numeric).
 * The API gates routes with @RequireFeature(); the UIs use the same keys to shape navigation.
 */

export interface FeatureDefinition {
  key: string;
  name: string;
  module: string;
  kind: 'boolean' | 'limit';
  /** Phase in which the gated functionality ships. */
  phase: number;
  unit?: string;
}

export const FEATURES = [
  { key: 'core_hr', name: 'Core HR and employee records', module: 'People', kind: 'boolean', phase: 2 },
  { key: 'leave', name: 'Leave management', module: 'Leave', kind: 'boolean', phase: 2 },
  { key: 'self_service', name: 'Employee and manager self-service', module: 'People', kind: 'boolean', phase: 2 },
  { key: 'documents', name: 'Documents and e-signatures', module: 'Documents', kind: 'boolean', phase: 2 },
  { key: 'attendance_basic', name: 'Web and mobile attendance', module: 'Attendance', kind: 'boolean', phase: 3 },
  { key: 'attendance_advanced', name: 'Geofencing, kiosks, biometric devices', module: 'Attendance', kind: 'boolean', phase: 3 },
  { key: 'shift_scheduling', name: 'Shift and roster management', module: 'Scheduling', kind: 'boolean', phase: 3 },
  { key: 'recruitment', name: 'Recruitment CRM and ATS', module: 'Recruitment', kind: 'boolean', phase: 4 },
  { key: 'payroll', name: 'Payroll', module: 'Payroll', kind: 'boolean', phase: 5 },
  { key: 'expenses', name: 'Expenses and reimbursements', module: 'Expenses', kind: 'boolean', phase: 5 },
  { key: 'talent', name: 'Performance, learning and engagement', module: 'Talent', kind: 'boolean', phase: 6 },
  { key: 'automation', name: 'Workflow Automation Studio', module: 'Automation', kind: 'boolean', phase: 8 },
  { key: 'ai_copilot', name: 'CREW AI Copilots', module: 'AI', kind: 'boolean', phase: 8 },
  { key: 'workforce_analytics', name: 'Workforce analytics and Ask Anything', module: 'Analytics', kind: 'boolean', phase: 8 },
  { key: 'integrations_advanced', name: 'Advanced integrations and webhooks', module: 'Integrations', kind: 'boolean', phase: 9 },
  { key: 'global_payroll', name: 'Global payroll provider integrations', module: 'Payroll', kind: 'boolean', phase: 9 },
  { key: 'multi_entity', name: 'Multiple legal entities and countries', module: 'Organization', kind: 'boolean', phase: 1 },
  { key: 'custom_roles', name: 'Custom roles', module: 'Administration', kind: 'boolean', phase: 1 },
  { key: 'audit_export', name: 'Audit log export', module: 'Administration', kind: 'boolean', phase: 1 },
  { key: 'sso', name: 'Single sign-on (SAML / OIDC)', module: 'Security', kind: 'boolean', phase: 10 },
  { key: 'enterprise_support', name: 'Enterprise support and SLA', module: 'Support', kind: 'boolean', phase: 1 },
  { key: 'max_employees', name: 'Employees included', module: 'Billing', kind: 'limit', phase: 1, unit: 'employees' },
  { key: 'max_legal_entities', name: 'Legal entities', module: 'Organization', kind: 'limit', phase: 1, unit: 'entities' },
  { key: 'ai_credits_monthly', name: 'AI credits per month', module: 'AI', kind: 'limit', phase: 8, unit: 'credits' },
  { key: 'storage_gb', name: 'Document storage', module: 'Documents', kind: 'limit', phase: 2, unit: 'GB' },
] as const satisfies readonly FeatureDefinition[];

export type FeatureKey = (typeof FEATURES)[number]['key'];
export type BooleanFeatureKey = Extract<(typeof FEATURES)[number], { kind: 'boolean' }>['key'];
export type LimitFeatureKey = Extract<(typeof FEATURES)[number], { kind: 'limit' }>['key'];

/** -1 means unlimited. */
export const UNLIMITED = -1;

export interface PlanTemplate {
  key: 'starter' | 'professional' | 'business' | 'enterprise';
  name: string;
  tagline: string;
  sortOrder: number;
  /** List prices per employee per month. Configurable in the Super Admin Console; these are launch defaults, not final commercial pricing. */
  prices: { currency: 'USD' | 'INR'; monthly: string; annualPerMonth: string }[];
  minimumSeats: number;
  quoteOnly: boolean;
  features: BooleanFeatureKey[];
  limits: Record<LimitFeatureKey, number>;
}

const STARTER: BooleanFeatureKey[] = ['core_hr', 'leave', 'self_service', 'documents', 'attendance_basic'];
const PROFESSIONAL: BooleanFeatureKey[] = [...STARTER, 'recruitment', 'attendance_advanced', 'shift_scheduling', 'automation', 'custom_roles'];
const BUSINESS: BooleanFeatureKey[] = [...PROFESSIONAL, 'payroll', 'expenses', 'talent', 'ai_copilot', 'workforce_analytics', 'integrations_advanced', 'multi_entity', 'audit_export'];
const ENTERPRISE: BooleanFeatureKey[] = [...BUSINESS, 'global_payroll', 'sso', 'enterprise_support'];

export const PLAN_TEMPLATES: readonly PlanTemplate[] = [
  {
    key: 'starter', name: 'Starter', tagline: 'Core HR, employee records, basic attendance and leave', sortOrder: 1,
    prices: [{ currency: 'USD', monthly: '4.00', annualPerMonth: '3.20' }, { currency: 'INR', monthly: '149.00', annualPerMonth: '119.00' }],
    minimumSeats: 5, quoteOnly: false, features: STARTER,
    limits: { max_employees: 100, max_legal_entities: 1, ai_credits_monthly: 0, storage_gb: 10 },
  },
  {
    key: 'professional', name: 'Professional', tagline: 'Recruitment, advanced attendance, shifts and automation', sortOrder: 2,
    prices: [{ currency: 'USD', monthly: '8.00', annualPerMonth: '6.40' }, { currency: 'INR', monthly: '299.00', annualPerMonth: '239.00' }],
    minimumSeats: 10, quoteOnly: false, features: PROFESSIONAL,
    limits: { max_employees: 1000, max_legal_entities: 1, ai_credits_monthly: 500, storage_gb: 50 },
  },
  {
    key: 'business', name: 'Business', tagline: 'Payroll, AI Copilot, analytics and advanced integrations', sortOrder: 3,
    prices: [{ currency: 'USD', monthly: '14.00', annualPerMonth: '11.20' }, { currency: 'INR', monthly: '499.00', annualPerMonth: '399.00' }],
    minimumSeats: 25, quoteOnly: false, features: BUSINESS,
    limits: { max_employees: 5000, max_legal_entities: 10, ai_credits_monthly: 5000, storage_gb: 250 },
  },
  {
    key: 'enterprise', name: 'Enterprise', tagline: 'Global payroll, SSO, multi-country, custom workflows and enterprise support', sortOrder: 4,
    prices: [], minimumSeats: 250, quoteOnly: true, features: ENTERPRISE,
    limits: { max_employees: UNLIMITED, max_legal_entities: UNLIMITED, ai_credits_monthly: 50000, storage_gb: 2000 },
  },
];
