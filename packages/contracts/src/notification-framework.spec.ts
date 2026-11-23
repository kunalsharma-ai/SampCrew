import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NOTIFICATION_POLICY, kindNeedsAction, notificationLocks, pickWelcomeScene, resolveNotificationPreferences, shouldPlaySound, WELCOME_COPY,
  WELCOME_SCENES, welcomeSceneFor,
} from './index';

describe('notification preferences inside the organisation policy', () => {
  it('fills every category with in app, email, phone and sound on, and keeps approvals and workspace notices in the app', () => {
    const p = resolveNotificationPreferences({ categories: { approvals: { inApp: false }, leave: { inApp: false, email: false } } });
    expect(p.categories.approvals.inApp).toBe(true);
    expect(p.categories.leave).toEqual({ inApp: false, email: false, push: true, sound: true });
    expect(p.categories.payroll).toEqual({ inApp: true, email: true, push: true, sound: true });
    expect(p.customised).toBe(true);
  });

  it('reads settings saved before phone and sound columns existed', () => {
    const p = resolveNotificationPreferences({ categories: { leave: { inApp: true, email: false } }, sound: { enabled: true, volume: 50, minPriority: 'high' } });
    expect(p.categories.leave).toEqual({ inApp: true, email: false, push: true, sound: true });
  });

  it('applies the policy: required categories and emails on, sound, desktop and push off when not allowed', () => {
    const policy = { ...DEFAULT_NOTIFICATION_POLICY, mandatory: ['leave'], emailRequired: ['payroll'], allowSound: false, allowDesktop: false, allowPush: false };
    const p = resolveNotificationPreferences({ categories: { leave: { inApp: false }, payroll: { email: false } }, sound: { enabled: true, volume: 60, minPriority: 'normal' }, desktop: true }, policy);
    expect(p.categories.leave.inApp).toBe(true);
    expect(p.categories.payroll.email).toBe(true);
    expect(p.categories.learning).toMatchObject({ push: false, sound: false });
    expect(p.sound.enabled).toBe(false);
    expect(p.desktop).toBe(false);
    expect(p.locks).toEqual(notificationLocks(policy as never));
  });

  it('starts people who never chose from the organisation defaults', () => {
    const p = resolveNotificationPreferences(undefined, { defaults: { sound: true, toasts: false, desktop: true } });
    expect(p).toMatchObject({ customised: false, toasts: false, desktop: true });
    expect(p.sound.enabled).toBe(true);
  });

  it('plays a sound only for allowed categories at or above the chosen priority', () => {
    const p = resolveNotificationPreferences({ sound: { enabled: true, volume: 50, minPriority: 'normal' }, categories: { learning: { sound: false } } });
    expect(shouldPlaySound(p.sound, 'normal', 'leave', p)).toBe(true);
    expect(shouldPlaySound(p.sound, 'urgent', 'learning', p)).toBe(false);
    expect(shouldPlaySound(p.sound, 'low', 'leave', p)).toBe(false);
    expect(shouldPlaySound({ ...p.sound, enabled: false }, 'urgent')).toBe(false);
  });

  it('knows which notices ask for action', () => {
    expect(kindNeedsAction('approval.requested')).toBe(true);
    expect(kindNeedsAction('task.assigned')).toBe(true);
    expect(kindNeedsAction('expense_claim.requested')).toBe(true);
    expect(kindNeedsAction('leave.approved')).toBe(false);
    expect(kindNeedsAction('payslip.published')).toBe(false);
  });
});

describe('sign-in welcome scenes', () => {
  it('has words for every scene, with level names only', () => {
    for (const s of WELCOME_SCENES) expect(WELCOME_COPY[s].level).toMatch(/^(Console|Super Workspace|HR Workspace|Employee Workspace)$/);
  });

  it('picks the scene from the signed-in levels', () => {
    expect(welcomeSceneFor({ super: true, companyHr: false, hrWorkspaces: [] })).toBe('super');
    expect(welcomeSceneFor({ super: false, companyHr: true, hrWorkspaces: [] })).toBe('hr');
    expect(welcomeSceneFor({ super: false, companyHr: false, hrWorkspaces: [{}] })).toBe('hr');
    expect(welcomeSceneFor({ super: false, companyHr: false, hrWorkspaces: [], leadsTeam: true })).toBe('team');
    expect(welcomeSceneFor({ super: false, companyHr: false, hrWorkspaces: [] })).toBe('employee');
    expect(welcomeSceneFor(null)).toBe('employee');
  });

  it('prefers the address, then the remembered level, and never shows the Console scene on a workspace page', () => {
    expect(pickWelcomeScene('hr', 'super')).toBe('hr');
    expect(pickWelcomeScene(null, 'team')).toBe('team');
    expect(pickWelcomeScene('manager', null)).toBe('team');
    expect(pickWelcomeScene('executive', null)).toBe('hr');
    expect(pickWelcomeScene('console', 'console')).toBe('employee');
    expect(pickWelcomeScene('nonsense', undefined)).toBe('employee');
  });
});
