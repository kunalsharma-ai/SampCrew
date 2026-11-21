import { describe, expect, it } from 'vitest';
import { FEATURE_PARTS } from './feature-parts';
import {
  MOBILE_MODULES, MOBILE_QUICK_ACTIONS, MOBILE_ROUTES, MOBILE_WIDGETS, defaultMobileConfig, describeMobileChanges, mobileFeature, mobileRouteAllowed, mobileRouteFor,
  normalizeMobileConfig, resolveMobileApp, validateMobileConfig,
} from './mobile-app';

const ALL_FEATURES = new Set<string>(['attendance_basic', 'leave', 'helpdesk', 'documents', 'learning', 'announcements', 'core_hr', 'performance', 'payroll', ...FEATURE_PARTS.map((p) => p.key)]);
const resolve = (config = defaultMobileConfig(), level: 'super' | 'hr' | 'employee' = 'employee', can?: (p: string) => boolean, features = ALL_FEATURES) =>
  resolveMobileApp({ config, version: 1, publishedAt: null, level, features, can });

describe('mobile app catalogue', () => {
  it('every shortcut, route owner and entitlement points at something real', () => {
    for (const s of [...MOBILE_QUICK_ACTIONS, ...MOBILE_WIDGETS]) expect(mobileFeature(s.feature), s.key).toBeDefined();
    for (const r of MOBILE_ROUTES) for (const o of r.owners) expect(o.includes('.') ? mobileFeature(o) : MOBILE_MODULES.find((m) => m.key === o), `${r.path} ${o}`).toBeDefined();
    const known = new Set<string>([...ALL_FEATURES]);
    for (const m of MOBILE_MODULES) if (m.entitlement) expect(known.has(m.entitlement), m.key).toBe(true);
    for (const m of MOBILE_MODULES) for (const f of m.features) if ('requires' in f && f.requires) expect(m.features.some((x) => x.key === f.requires)).toBe(true);
  });

  it('matches the longest route, by method', () => {
    expect(mobileRouteFor('leave/requests', 'POST')?.owners).toEqual(['leave.apply']);
    expect(mobileRouteFor('leave/requests', 'GET')?.owners).toEqual(['leave.history', 'leave.calendar']);
    expect(mobileRouteFor('leave/requests/0b4c/cancel', 'POST')?.owners).toEqual(['leave.cancel']);
    expect(mobileRouteFor('leave/requests/0b4c', 'GET')?.owners).toEqual(['leave.history', 'leave.calendar']);
    expect(mobileRouteFor('communication/emails/inbox', 'GET')?.owners).toEqual(['email.inbox']);
    expect(mobileRouteFor('communication/emails/send', 'POST')?.owners).toEqual(['email.compose']);
    expect(mobileRouteFor('employees/abc/documents?x=1', 'GET')?.owners).toEqual(['documents.mine']);
    expect(mobileRouteFor('employees/abc/photo', 'PUT')).toBeUndefined();
    expect(mobileRouteFor('me', 'GET')).toBeUndefined();
    expect(mobileRouteFor('mobile/devices', 'POST')).toBeUndefined();
    expect(mobileRouteFor('mobile/app', 'GET')).toBeUndefined();
  });
});

describe('mobile app configuration', () => {
  it('starts with every module, Attendance, Chat and Documents in the bar', () => {
    const app = resolve();
    expect(app.tabs).toEqual(['attendance', 'chat', 'documents']);
    expect(app.more).toContain('leave');
    expect(app.more).toContain('email');
    expect(app.quickActions.map((q) => q.key)).toContain('attendance.punch');
    // Admin-only shortcuts stay off an Employee Workspace phone.
    expect(app.quickActions.map((q) => q.key)).not.toContain('approvals.open');
    expect(resolve(undefined, 'hr').quickActions.map((q) => q.key)).toContain('approvals.open');
    expect(validateMobileConfig(defaultMobileConfig()).filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('hiding Email removes it, its shortcuts and its routes, and nothing else', () => {
    const c = defaultMobileConfig();
    c.modules.email!.enabled = false;
    const app = resolve(c);
    expect(app.modules.map((m) => m.key)).not.toContain('email');
    expect(app.quickActions.map((q) => q.key)).not.toContain('email.open');
    expect(app.modules.map((m) => m.key)).toContain('learning');
    expect(mobileRouteAllowed(c, mobileRouteFor('communication/emails/inbox', 'GET')!, 'employee')).toBe(false);
    expect(mobileRouteAllowed(c, mobileRouteFor('communication/conversations', 'GET')!, 'employee')).toBe(true);
    // People search is shared with chat, so it stays open while chat is on.
    expect(mobileRouteAllowed(c, mobileRouteFor('communication/people', 'GET')!, 'employee')).toBe(true);
  });

  it('applies levels per module and per feature', () => {
    const c = defaultMobileConfig();
    c.modules.learning!.levels.super = false;
    c.modules.attendance!.features.history!.levels.employee = false;
    expect(resolve(c, 'super').modules.map((m) => m.key)).not.toContain('learning');
    expect(resolve(c, 'employee').modules.map((m) => m.key)).toContain('learning');
    expect(resolve(c, 'employee').modules.find((m) => m.key === 'attendance')!.features).not.toContain('history');
    expect(resolve(c, 'hr').modules.find((m) => m.key === 'attendance')!.features).toContain('history');
    expect(resolve(c, 'employee').modules.find((m) => m.key === 'attendance')!.features).not.toContain('team');
  });

  it('never grants what the plan or permissions do not', () => {
    const noLearning = new Set([...ALL_FEATURES].filter((k) => !k.startsWith('learning')));
    expect(resolve(undefined, 'employee', undefined, noLearning).modules.map((m) => m.key)).not.toContain('learning');
    const app = resolve(undefined, 'employee', (p) => ['attendance:read', 'leave:request', 'helpdesk:use'].includes(p));
    const att = app.modules.find((m) => m.key === 'attendance')!;
    expect(att.features).not.toContain('punch');
    expect(att.features).not.toContain('breaks');
    expect(app.modules.find((m) => m.key === 'email')!.features).toEqual(['inbox']);
    expect(app.modules.map((m) => m.key)).not.toContain('documents');
  });

  it('checks the bar, dependencies and limits before publishing', () => {
    const c = defaultMobileConfig();
    c.modules.leave!.placement = 'tab';
    c.modules.attendance!.features.punch!.enabled = false;
    c.quickActions.forEach((q) => (q.enabled = true));
    const errors = validateMobileConfig(c).filter((i) => i.severity === 'error').map((i) => i.message);
    expect(errors.some((m) => m.includes('bottom bar'))).toBe(true);
    expect(errors.some((m) => m.includes('Breaks needs Check in and out'))).toBe(true);
    expect(errors.some((m) => m.includes('quick actions'))).toBe(true);
  });

  it('keeps locked modules on and fills in new catalogue entries', () => {
    const c = defaultMobileConfig();
    c.modules.profile!.enabled = false;
    delete c.modules.sessions;
    c.quickActions = c.quickActions.filter((q) => q.key !== 'tasks.open');
    const n = normalizeMobileConfig(c);
    expect(n.modules.profile!.enabled).toBe(true);
    expect(n.modules.sessions!.enabled).toBe(true);
    expect(n.quickActions.find((q) => q.key === 'tasks.open')!.enabled).toBe(false);
  });

  it('describes changes in words', () => {
    const a = defaultMobileConfig();
    const b = normalizeMobileConfig(a);
    b.modules.email!.enabled = false;
    b.modules.leave!.features.cancel!.enabled = false;
    expect(describeMobileChanges(a, b)).toEqual(['Leave: Cancel a request off', 'Email hidden']);
  });
});
