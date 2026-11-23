/**
 * The animated welcome on every SampCrew sign-in page (Web Portal, Console and the phone app). The look, the SampCrew
 * logo and the brand colours are the same everywhere; each level gets its own motion and welcome words, so the page
 * already feels like the place the person is going.
 *
 * Levels are the four SampCrew levels. "Team" is the Employee Workspace of someone who leads a team (people report to
 * them): same level, a welcome about their team. It is shown under the Employee Workspace name, never as a job title.
 */
export const WELCOME_SCENES = ['console', 'super', 'hr', 'team', 'employee'] as const;
export type WelcomeScene = (typeof WELCOME_SCENES)[number];

export interface WelcomeSceneCopy {
  /** The level name shown above the welcome (level names only, never a personal designation). */
  level: string;
  /** The welcome headline. */
  title: string;
  /** One line under it. */
  message: string;
  /** Three short things this level does, shown as chips. */
  highlights: [string, string, string];
  /** The sign-in form's heading. */
  formTitle: string;
}

export const WELCOME_COPY: Record<WelcomeScene, WelcomeSceneCopy> = {
  console: {
    level: 'Super Admin Console',
    title: 'Mission control for every SampCrew workspace',
    message: 'Client companies, plans, billing, security and platform health, live in one secure console.',
    highlights: ['Client companies', 'Plans & billing', 'Platform health'],
    formTitle: 'Sign in to the Console',
  },
  super: {
    level: 'Super Workspace',
    title: 'Lead your whole organisation from one place',
    message: 'Set up HR Workspaces, modules and policies, and see the workforce across every company you run.',
    highlights: ['HR Workspaces', 'Modules & policies', 'Company-wide insight'],
    formTitle: 'Sign in to your Super Workspace',
  },
  hr: {
    level: 'HR Workspace',
    title: 'Hire, onboard and care for your people',
    message: 'Recruitment, onboarding, attendance and approvals for everyone you look after, moving fast.',
    highlights: ['Recruitment', 'Onboarding', 'Approvals'],
    formTitle: 'Sign in to your HR Workspace',
  },
  team: {
    level: 'Employee Workspace',
    title: 'Your team is ready for today',
    message: 'Requests to approve, who is in, and what your team needs from you, all in one glance.',
    highlights: ['Team approvals', 'Who is in', 'Team goals'],
    formTitle: 'Sign in to your workspace',
  },
  employee: {
    level: 'Employee Workspace',
    title: 'Your workday, beautifully simple',
    message: 'Check in, plan leave, download payslips and keep up with your team, from any screen.',
    highlights: ['Attendance', 'Leave', 'Payslips'],
    formTitle: 'Sign in to your workspace',
  },
};

/** The levels a person can pick on the Web Portal and phone sign-in pages (the Console has its own page). */
export const WORKSPACE_WELCOME_CHOICES: { scene: Exclude<WelcomeScene, 'console' | 'team'>; label: string }[] = [
  { scene: 'super', label: 'Super Workspace' },
  { scene: 'hr', label: 'HR Workspace' },
  { scene: 'employee', label: 'Employee Workspace' },
];

/** Name of the cookie (web) and storage key (phone) that remembers the last level someone signed in to. */
export const WELCOME_SCENE_COOKIE = 'crew_welcome';

export function isWelcomeScene(v: unknown): v is WelcomeScene {
  return typeof v === 'string' && (WELCOME_SCENES as readonly string[]).includes(v);
}

/**
 * The scene for a signed-in person, from their levels (MeResponse.levels): Super Workspace, HR Workspace, or the
 * Employee Workspace (with the team welcome when people report to them).
 */
export function welcomeSceneFor(levels: { super: boolean; companyHr: boolean; hrWorkspaces: unknown[]; leadsTeam?: boolean } | null | undefined): WelcomeScene {
  if (!levels) return 'employee';
  if (levels.super) return 'super';
  if (levels.companyHr || levels.hrWorkspaces.length) return 'hr';
  return levels.leadsTeam ? 'team' : 'employee';
}

/**
 * The scene a sign-in page shows: the level asked for in the address (?space=hr) wins, then the level remembered from
 * the last sign-in on this device, then the Employee Workspace (most people). "manager" and "executive" are accepted
 * as other names for team and hr, so links written with those words still work.
 */
export function pickWelcomeScene(asked: string | null | undefined, remembered: string | null | undefined): Exclude<WelcomeScene, 'console'> {
  const alias = (v: string | null | undefined) => (v === 'manager' ? 'team' : v === 'executive' ? 'hr' : v);
  for (const v of [alias(asked), alias(remembered)]) if (isWelcomeScene(v) && v !== 'console') return v;
  return 'employee';
}
