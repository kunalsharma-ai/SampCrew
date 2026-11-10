import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { BOOLEAN_FEATURES, FEATURES, isCoreFeature, isPlannedFeature, PLAN_TEMPLATES } from '@crew/contracts';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROLLERS } from '../src/app.module';
import { FEATURE_KEY, PUBLIC_KEY, REALM_KEY } from '../src/platform/authz/decorators';

/**
 * Every feature of SampCrew is controlled by the workspace's plan. This test fails when a new workspace route
 * is added without either a plan module (@RequireFeature) or a written reason why it belongs to the foundation
 * every workspace has, so a module cannot ship ungated by accident.
 */

/** Workspace routes that are part of the foundation every plan includes, by controller, with the reason. */
const FOUNDATION: Record<string, string> = {
  AuthController: 'Sign-in, sign-out, invitations and workspace switching',
  MeController: 'The signed-in person, their sessions, password and two-step verification',
  ApprovalsController: 'One inbox for approvals raised by the modules; each item is created by a gated module',
  AuditController: 'Viewing and verifying the audit trail is a security baseline (the CSV export is the audit_export module)',
  BillingController: 'Plan & billing: where an admin buys or changes the subscription',
  DesignationsController: 'Core HR (always included)',
  EmployeesController: 'Core HR (always included); module tabs inside the profile are gated in the service',
  DashboardController: 'Home dashboard; each card is shown only when its module is in the plan',
  OverviewController: 'Home overview; each block checks its module',
  PreferencesController: 'Personal appearance, favourites and notes',
  ViewsController: 'Saved list views',
  HolidayCalendarsController: 'Holiday calendars are shared by leave, attendance, shifts and payroll',
  MembersController: 'Workspace members and invitations (seat limit enforced in the service)',
  RolesController: 'Viewing roles; creating custom roles is the custom_roles module',
  PermissionsController: 'The permission catalogue',
  NotificationsController: 'In-app notifications from every module',
  OrganizationController: 'Company structure',
  LegalentitiesController: 'Company structure (a second legal entity is the multi_entity module, enforced in OrganizationService)',
  BusinessunitsController: 'Company structure',
  LocationsController: 'Company structure',
  DepartmentsController: 'Company structure',
  PrivacyController: 'Data-subject requests are a legal duty for every workspace',
  RetentionController: 'Data retention is a legal duty for every workspace',
  SetupController: 'First-run setup wizard',
  TenancyController: 'Workspace settings',
  SupportAccessController: 'Approving SAMPLEDGE support access',
  AiController: 'AI governance (status, settings, usage, history) shared by the Copilot and IQ modules; the Copilot actions are gated',
};

/** Single routes on otherwise gated or foundation controllers that are foundation on purpose. */
const FOUNDATION_ROUTES: Record<string, string> = {
  'TalentPeopleController.managed': 'Checks the performance or learning module named by its "for" parameter',
  ...Object.fromEntries(['calendars', 'createCalendar', 'updateCalendar', 'deleteCalendar', 'addHoliday', 'removeHoliday'].map((m) => [
    `LeaveController.${m}`, 'Holiday calendars are shared by leave, attendance, shifts and payroll',
  ])),
  ...Object.fromEntries(['skillsOf', 'setSkills', 'catalogueList', 'catalogueCreate', 'catalogueUpdate', 'catalogueMerge', 'catalogueDelete'].map((m) => [
    `LensesController.${m}`, 'Employee skills and the skills catalogue are shared by recruitment, staffing bids and Workforce Universe',
  ])),
};

/** Public routes (no session). Each one checks the plan of the workspace it belongs to in its service, or needs none. */
const PUBLIC_CHECKED_IN_SERVICE: Record<string, string> = {
  HealthController: 'none (liveness and readiness)',
  AuthController: 'none (sign-in); single sign-on checks the sso module',
  KioskController: 'attendance_advanced (AttendanceService.kioskDisplay)',
  ZkPushController: 'attendance_advanced (DevicesService.admit)',
  DeviceApiController: 'attendance_advanced (DevicesService.admit)',
  ProposalsPublicController: 'staffing_bids (ProposalsPublicService)',
  CareersPublicController: 'recruitment (CareersService)',
  ResumeFilesController: 'signed, expiring links issued by a gated module',
  ReceiptFilesController: 'signed, expiring links issued by a gated module',
  'DocumentsController.file': 'signed, expiring links issued by a gated module',
  SignatureAgentController: 'email_signatures (SignaturesService.agentByToken)',
  PlatformAuthController: 'none (SAMPLEDGE Console sign-in)',
  BillingWebhooksController: 'none (payment confirmations from Razorpay and Stripe, signed with the webhook secret)',
};

type Ctor = new (...args: never[]) => unknown;

function routes() {
  const out: { ctrl: string; name: string; path: string; feature?: string; isPublic: boolean; realm?: string }[] = [];
  for (const ctrl of CONTROLLERS as Ctor[]) {
    const base = (Reflect.getMetadata(PATH_METADATA, ctrl) as string) ?? '';
    const classPublic = Reflect.getMetadata(PUBLIC_KEY, ctrl) === true;
    const classRealm = (Reflect.getMetadata(REALM_KEY, ctrl) as { realm: string } | undefined)?.realm;
    for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
      const handler = (ctrl.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function' || name === 'constructor') continue;
      if (Reflect.getMetadata(METHOD_METADATA, handler) === undefined) continue;
      const sub = (Reflect.getMetadata(PATH_METADATA, handler) as string) ?? '';
      out.push({
        ctrl: ctrl.name,
        name,
        path: '/' + [base, sub].map((p) => p.replace(/^\/|\/$/g, '')).filter(Boolean).join('/'),
        feature: (Reflect.getMetadata(FEATURE_KEY, handler) ?? Reflect.getMetadata(FEATURE_KEY, ctrl)) as string | undefined,
        isPublic: classPublic || Reflect.getMetadata(PUBLIC_KEY, handler) === true,
        realm: (Reflect.getMetadata(REALM_KEY, handler) as { realm: string } | undefined)?.realm ?? classRealm,
      });
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? sourceFiles(p) : p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
  });
}

describe('every feature is controlled by the plan', () => {
  const all = routes();

  it('every workspace route needs a plan module or is documented foundation', () => {
    const ungated = all
      .filter((r) => !r.isPublic && r.realm !== 'platform' && r.realm !== 'scim' && !r.feature)
      .filter((r) => !FOUNDATION[r.ctrl] && !FOUNDATION_ROUTES[`${r.ctrl}.${r.name}`])
      .map((r) => `${r.ctrl}.${r.name} ${r.path}`);
    expect(ungated).toEqual([]);
  });

  it('every public route is listed with the plan check its service makes', () => {
    const unlisted = all.filter((r) => r.isPublic && !PUBLIC_CHECKED_IN_SERVICE[r.ctrl] && !PUBLIC_CHECKED_IN_SERVICE[`${r.ctrl}.${r.name}`]).map((r) => `${r.ctrl}.${r.name} ${r.path}`);
    expect(unlisted).toEqual([]);
  });

  it('every gate names a real module and every sellable module gates something', () => {
    const keys = new Set<string>(BOOLEAN_FEATURES.map((f) => f.key));
    const used = new Set(all.map((r) => r.feature).filter((f): f is string => !!f));
    expect([...used].filter((f) => !keys.has(f))).toEqual([]);
    // Modules enforced inside services rather than by a route decorator.
    const src = sourceFiles(join(__dirname, '../src')).map((p) => readFileSync(p, 'utf8')).join('\n');
    const enforced = (k: string) => used.has(k) || new RegExp(`(requireFeature|features\\.has|gated|need)\\(\\s*'${k}'`).test(src);
    const notEnforced = BOOLEAN_FEATURES.filter((f) => !isCoreFeature(f.key) && !isPlannedFeature(f.key)).map((f) => f.key).filter((k) => !enforced(k));
    expect(notEnforced).toEqual([]);
  });

  it('the launch plans only use catalogue keys and always include the foundation', () => {
    const keys = new Set<string>(FEATURES.map((f) => f.key));
    for (const p of PLAN_TEMPLATES) {
      expect(p.features.filter((k) => !keys.has(k))).toEqual([]);
      expect(p.features).toContain('core_hr');
    }
  });
});
