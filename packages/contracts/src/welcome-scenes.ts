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
    formTitle: 'Sign in to your workspace',
  },
  hr: {
    level: 'HR Workspace',
    title: 'Hire, onboard and care for your people',
    message: 'Recruitment, onboarding, attendance and approvals for everyone you look after, moving fast.',
    highlights: ['Recruitment', 'Onboarding', 'Approvals'],
    formTitle: 'Sign in to your workspace',
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

/**
 * What the sign-in card says: its name, the line above it, and whether only SAMPLEDGE staff may use it. Super, HR and
 * Employee Workspaces share one sign-in address, so their card is role-neutral ("Workspace Sign In", issue #89): the
 * person's level is only known after they sign in. The welcome beside the card keeps the level's look and words.
 */
export const WORKSPACE_SIGN_IN_NAME = 'Workspace Sign In';
export const WELCOME_CARD: Record<WelcomeScene, { kicker: string; name: string; staffOnly?: boolean }> = {
  console: { kicker: 'Platform administration', name: 'Super Admin Console', staffOnly: true },
  super: { kicker: 'SampCrew', name: WORKSPACE_SIGN_IN_NAME },
  hr: { kicker: 'SampCrew', name: WORKSPACE_SIGN_IN_NAME },
  team: { kicker: 'SampCrew', name: WORKSPACE_SIGN_IN_NAME },
  employee: { kicker: 'SampCrew', name: WORKSPACE_SIGN_IN_NAME },
};

/** "Hello" in the languages SampCrew's customers speak, shown in turn beside the greeting. */
export const WELCOME_HELLOS = ['Hello', 'Namaste', 'Marhaba', 'Bonjour', 'Hola', 'Vanakkam'] as const;

/** The time-of-day greeting for an hour (0-23) of the person's own clock. */
export function timeGreeting(hour: number): string {
  if (hour < 5) return 'Good evening';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/** Light or dark sign-in page; auto keeps each workspace's own look (and the device's setting for the form). */
export const SIGN_IN_MODES = ['auto', 'light', 'dark'] as const;
export type SignInMode = (typeof SIGN_IN_MODES)[number];

export interface SignInPalette {
  key: string;
  label: string;
  /** Three colours for the swatch, the glows and the card's moving border. */
  colors: [string, string, string];
  /** The backdrop and the workspace name's colours on a dark page and on a light page (CSS gradients). */
  dark: { base: string; name: [string, string, string] };
  light: { base: string; name: [string, string, string] };
  /** Buttons, links and focus rings in the sign-in form. */
  tint: string;
}

/**
 * Colour palettes people can try on the sign-in pages. "signature" (no entry here) is each workspace's own colours;
 * these replace them everywhere on the page: backdrop, glows, the workspace name, the sign-in card and its button.
 */
export const SIGN_IN_PALETTES: SignInPalette[] = [
  { key: 'aurora', label: 'Aurora', colors: ['#22d3ee', '#a78bfa', '#f472b6'], tint: '#7c3aed',
    dark: { base: 'radial-gradient(120% 90% at 20% 0%, #1e1b4b 0%, #0b1026 55%, #050816 100%)', name: ['#a5f3fc', '#c4b5fd', '#f9a8d4'] },
    light: { base: 'linear-gradient(150deg, #ecfeff 0%, #f5f3ff 50%, #fdf2f8 100%)', name: ['#0891b2', '#7c3aed', '#db2777'] } },
  { key: 'sunset', label: 'Sunset', colors: ['#fb923c', '#f43f5e', '#a855f7'], tint: '#e11d48',
    dark: { base: 'radial-gradient(120% 90% at 20% 0%, #4c0519 0%, #1c0a1f 55%, #0c0512 100%)', name: ['#fed7aa', '#fda4af', '#d8b4fe'] },
    light: { base: 'linear-gradient(150deg, #fff7ed 0%, #ffe4e6 50%, #faf5ff 100%)', name: ['#ea580c', '#e11d48', '#9333ea'] } },
  { key: 'ocean', label: 'Ocean', colors: ['#38bdf8', '#2563eb', '#14b8a6'], tint: '#2563eb',
    dark: { base: 'radial-gradient(120% 90% at 20% 0%, #082f49 0%, #04162b 55%, #020817 100%)', name: ['#bae6fd', '#60a5fa', '#5eead4'] },
    light: { base: 'linear-gradient(150deg, #f0f9ff 0%, #e0f2fe 50%, #ecfeff 100%)', name: ['#0369a1', '#2563eb', '#0d9488'] } },
  { key: 'forest', label: 'Forest', colors: ['#34d399', '#a3e635', '#059669'], tint: '#059669',
    dark: { base: 'radial-gradient(120% 90% at 20% 0%, #064e3b 0%, #04170f 55%, #020a06 100%)', name: ['#bbf7d0', '#d9f99d', '#6ee7b7'] },
    light: { base: 'linear-gradient(150deg, #f0fdf4 0%, #ecfccb 50%, #ecfdf5 100%)', name: ['#047857', '#4d7c0f', '#059669'] } },
  { key: 'candy', label: 'Candy', colors: ['#f472b6', '#818cf8', '#fbbf24'], tint: '#db2777',
    dark: { base: 'radial-gradient(120% 90% at 20% 0%, #3b0764 0%, #1e0a2e 55%, #0f0517 100%)', name: ['#fbcfe8', '#c7d2fe', '#fde68a'] },
    light: { base: 'linear-gradient(150deg, #fdf2f8 0%, #eef2ff 50%, #fffbeb 100%)', name: ['#db2777', '#6366f1', '#d97706'] } },
  { key: 'graphite', label: 'Graphite', colors: ['#94a3b8', '#e2e8f0', '#64748b'], tint: '#3f3f46',
    dark: { base: 'radial-gradient(120% 90% at 20% 0%, #27272a 0%, #18181b 55%, #09090b 100%)', name: ['#fafafa', '#d4d4d8', '#a1a1aa'] },
    light: { base: 'linear-gradient(150deg, #fafafa 0%, #f4f4f5 50%, #e4e4e7 100%)', name: ['#18181b', '#3f3f46', '#71717a'] } },
];

/** Whether a workspace's own world is a dark one (auto mode keeps it). */
export function sceneIsDark(scene: WelcomeScene): boolean {
  return scene !== 'employee' && scene !== 'team';
}
