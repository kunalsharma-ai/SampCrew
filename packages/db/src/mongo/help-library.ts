import type { HelpArticleKind, HelpAudience, HelpIcon } from '@crew/contracts';

/**
 * The built-in Help & Support library: categories, FAQs, guides, tutorials, troubleshooting and quick starts for
 * every feature of SampCrew, for each level. It is seeded into the help tables with the catalogue (syncHelpLibrary)
 * and managed in the Console from then on: a Console Admin can edit, unpublish or delete any of it and add their
 * own, and the sync never overwrites what they changed.
 *
 * Who sees an article is decided per person on the server: its audiences (a Super Workspace also sees HR Workspace
 * and Employee Workspace content, an HR Workspace also sees Employee Workspace content), its feature or feature part
 * (switched on for the person's company and level), and its permission. Articles for features of other open pull
 * requests name their permissions and features, so they appear by themselves once those features exist.
 *
 * Writing rules: plain words, the names people see on screen, level names (Super Workspace, HR Workspace, Employee
 * Workspace) and never personal job titles. Steps name the menu path and link the page.
 */

export interface LibCategory {
  key: string;
  name: string;
  description: string;
  icon: HelpIcon;
  audiences: HelpAudience[];
  feature?: string;
  parent?: string;
  sort: number;
}

export interface LibStep { title: string; body: string; href?: string }

export interface LibArticle {
  slug: string;
  category: string;
  kind: HelpArticleKind;
  title: string;
  summary: string;
  body: string;
  steps: LibStep[];
  audiences: HelpAudience[];
  feature?: string;
  permission?: string;
  keywords: string[];
  href?: string;
  related: string[];
  sort: number;
}

interface Opts {
  audiences?: HelpAudience[];
  feature?: string;
  permission?: string;
  keywords?: string[];
  href?: string;
  related?: string[];
  summary?: string;
  body?: string;
}

const EVERYONE: HelpAudience[] = ['employee'];
const HR: HelpAudience[] = ['hr'];
const SUPER: HelpAudience[] = ['super'];
const CONSOLE: HelpAudience[] = ['console'];

let order = 0;
const firstSentence = (s: string) => {
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1]! : s).slice(0, 300);
};
type StepTuple = [title: string, body: string, href?: string];
const steps = (list: StepTuple[]): LibStep[] => list.map(([title, body, href]) => ({ title, body, ...(href ? { href } : {}) }));

function make(kind: HelpArticleKind, category: string, slug: string, title: string, o: Opts & { steps?: StepTuple[] }): LibArticle {
  order += 1;
  const body = o.body ?? '';
  return {
    slug, category, kind, title,
    summary: o.summary ?? firstSentence(body),
    body,
    steps: steps(o.steps ?? []),
    audiences: o.audiences ?? EVERYONE,
    ...(o.feature ? { feature: o.feature } : {}),
    ...(o.permission ? { permission: o.permission } : {}),
    keywords: o.keywords ?? [],
    ...(o.href ? { href: o.href } : {}),
    related: o.related ?? [],
    sort: order,
  };
}
/** A question and its answer. */
const faq = (category: string, slug: string, title: string, body: string, o: Opts = {}) => make('faq', category, slug, title, { ...o, body });
/** A step-by-step guide. */
const guide = (category: string, slug: string, title: string, summary: string, list: StepTuple[], o: Opts = {}) => make('guide', category, slug, title, { ...o, summary, steps: list });
/** An interactive tutorial: steps with "Go to page" and a tick per step, progress saved. */
const tutorial = (category: string, slug: string, title: string, summary: string, list: StepTuple[], o: Opts = {}) => make('tutorial', category, slug, title, { ...o, summary, steps: list });
/** A problem and how to fix it. */
const fix = (category: string, slug: string, title: string, body: string, o: Opts & { steps?: StepTuple[] } = {}) => make('troubleshooting', category, slug, title, { ...o, body });
/** A first-day guide for a level. */
const quick = (category: string, slug: string, title: string, summary: string, list: StepTuple[], o: Opts = {}) => make('quickstart', category, slug, title, { ...o, summary, steps: list });

// ------------------------------------------------------------------------------------------------------ categories

let catSort = 0;
const cat = (key: string, name: string, description: string, icon: HelpIcon, audiences: HelpAudience[], o: { feature?: string; parent?: string } = {}): LibCategory => {
  catSort += 10;
  return { key, name, description, icon, audiences, sort: catSort, ...o };
};

export const HELP_LIBRARY_CATEGORIES: LibCategory[] = [
  cat('getting-started', 'Getting started', 'Quick starts for your first day, whatever your level.', 'rocket', ['employee', 'console']),
  cat('getting-started-employee', 'For Employee Workspace', 'Your own attendance, leave, payslips, requests and profile.', 'user', EVERYONE, { parent: 'getting-started' }),
  cat('getting-started-hr', 'For HR Workspace', 'Running the people you look after: records, approvals, attendance and leave.', 'users', HR, { parent: 'getting-started' }),
  cat('getting-started-super', 'For Super Workspace', 'Setting up your company, HR Workspaces, features and billing.', 'building', SUPER, { parent: 'getting-started' }),
  cat('account', 'Account, sign-in & security', 'Password, two-step verification, sessions, notifications and appearance.', 'shield', EVERYONE),
  cat('home-approvals', 'Home, approvals & tasks', 'Your dashboard, the approval inbox and tasks from HR or your manager.', 'inbox', EVERYONE),
  cat('communication', 'Communication & announcements', 'Chat, emails from HR, announcements and Ask HR.', 'messages', EVERYONE),
  cat('employees', 'Employee management', 'Employee records, hiring, structure, logins and profile updates.', 'users', HR),
  cat('hr-workspaces', 'HR Workspaces & access levels', 'How Super, HR and Employee Workspaces fit together, and who can do what.', 'network', HR),
  cat('feature-management', 'Feature management', 'Switching modules, pages and buttons on or off for each level.', 'toggle', HR),
  cat('attendance', 'Attendance & time', 'Punching in and out, corrections, team attendance, late coming and shifts.', 'clock', EVERYONE, { feature: 'attendance_basic' }),
  cat('attendance-devices', 'Attendance machines & kiosks', 'Biometric and face machines, QR kiosks and geofences.', 'key', HR, { feature: 'attendance_basic', parent: 'attendance' }),
  cat('leave', 'Leave management', 'Applying for leave, balances, leave types, policies, allocation and approvals.', 'calendar', EVERYONE, { feature: 'leave' }),
  cat('payroll', 'Payroll & payslips', 'Payslips, salaries, payroll runs and statutory settings.', 'wallet', EVERYONE, { feature: 'payroll' }),
  cat('expenses', 'Expenses', 'Claiming money back for work expenses.', 'receipt', EVERYONE, { feature: 'expenses' }),
  cat('recruitment', 'Recruitment & ATS', 'Job requisitions, candidates, pipelines, interviews and offers.', 'briefcase', EVERYONE, { feature: 'recruitment' }),
  cat('candidate-crm', 'Candidate CRM', 'Your candidate database: profiles, follow-ups, calls, imports and exports.', 'users', HR, { feature: 'recruitment', parent: 'recruitment' }),
  cat('staffing', 'Staffing & bids', 'Pricing staffing proposals, clients, rate cards and templates.', 'handshake', HR, { feature: 'staffing_bids' }),
  cat('performance', 'Performance & appraisals', 'Goals, reviews, appraisal forms and cycles.', 'target', EVERYONE, { feature: 'performance' }),
  cat('learning', 'Learning & development', 'Courses, learning paths, quizzes, assignments and certificates.', 'graduation', EVERYONE, { feature: 'learning' }),
  cat('engagement', 'Recognition & surveys', 'Thanking colleagues and answering or running surveys.', 'heart', EVERYONE, { feature: 'engagement' }),
  cat('documents', 'Documents & verification', 'Your documents, document requests and background verification.', 'file', EVERYONE),
  cat('assets', 'Assets', 'Company laptops, phones and other assets: who holds what.', 'laptop', EVERYONE, { feature: 'asset_management' }),
  cat('onboarding', 'Onboarding', 'Checklists that welcome each new joiner.', 'checklist', HR, { feature: 'onboarding' }),
  cat('data-import', 'Data import & master data', 'Bringing data in from Excel or CSV, bulk changes and master lists.', 'upload', HR),
  cat('analytics', 'Analytics, AI & automation', 'HR analytics, Workforce Universe, attrition risk, Automation Studio and AI.', 'chart', HR),
  cat('compliance', 'Privacy & audit', 'Privacy requests, data retention and the audit trail.', 'scroll', HR),
  cat('workspace-settings', 'Workspace settings & integrations', 'Company settings, custom fields, single sign-on, integrations and email signatures.', 'settings', SUPER),
  cat('billing', 'Plan & billing', 'Your plan, seats, add-ons, invoices and payments.', 'card', SUPER),
  cat('mobile', 'Mobile app', 'SampCrew on your Android or iPhone.', 'phone', EVERYONE),
  cat('help-support', 'Help & Support', 'Using this help centre and raising a query.', 'headset', ['employee', 'console']),
  cat('troubleshooting', 'Troubleshooting', 'Fixes for common errors, access problems and things that do not work as expected.', 'wrench', EVERYONE),
  // Console Admin
  cat('console-start', 'Console: getting started', 'Your first day as a Console Admin.', 'rocket', CONSOLE),
  cat('console-companies', 'Companies & subscriptions', 'Workspaces, users, devices and activity of every customer.', 'building', CONSOLE),
  cat('console-plans', 'Plans, billing & revenue', 'Plans and pricing, invoices, add-ons, coupons and revenue.', 'tag', CONSOLE),
  cat('console-features', 'Feature management (Console)', 'What each company may use, for the whole application or one company.', 'toggle', CONSOLE),
  cat('console-support', 'Support inbox & help queries', 'Answering Super Workspaces and managing help queries.', 'headset', CONSOLE),
  cat('console-help', 'Managing the help centre', 'Writing FAQs, guides and tutorials, and setting up Raise a Query.', 'book', CONSOLE),
  cat('console-platform', 'Admins, integrations & health', 'Console admins, integrations, payroll country packs, health and audit.', 'activity', CONSOLE),
];

// ------------------------------------------------------------------------------------------------------ articles

export const HELP_LIBRARY_ARTICLES: LibArticle[] = [
  // ============================================================================================ Getting started
  quick('getting-started-employee', 'quickstart-employee', 'Quick start for Employee Workspace', 'Everything you need on your first day: sign in safely, set up your profile, then attendance, leave and payslips.', [
    ['Secure your account', 'Open Security from your avatar menu, change your temporary password and turn on two-step verification with an authenticator app.', '/settings/security'],
    ['Check your profile', 'Open My profile and review your personal, contact, bank and emergency details. Changes go to HR for approval.', '/profile'],
    ['Look at Home', 'Home shows your hours, leave balances, tasks and announcements. Clock in at the top when you start work.', '/'],
    ['Learn how to ask for leave', 'Open Leave, press Apply for leave, choose the type and dates and send it. You can follow its status there.', '/leave'],
    ['Find your payslips', 'Payslips from finalised payroll runs are under Payslips. Open one to see how each amount was worked out.', '/payslips'],
    ['Get the phone app', 'Install SampCrew on your phone to punch in, apply for leave and read announcements on the go.'],
  ], { keywords: ['first day', 'new joiner', 'start', 'onboarding', 'employee'], related: ['how-to-apply-leave', 'how-to-punch-in', 'enable-two-step'] }),
  quick('getting-started-hr', 'quickstart-hr', 'Quick start for HR Workspace', 'Run the people you look after: find their records, work through approvals, and keep attendance and leave in order.', [
    ['See who you look after', 'Open Employees. You see the people of your HR Workspace (or the whole company if your access covers it).', '/employees'],
    ['Work through approvals', 'Approvals groups requests into cards. Open a card, read each request and approve or reject with remarks.', '/approvals'],
    ['Check attendance exceptions', 'Team attendance highlights missing punches and late arrivals for a day. Open a person to see how the day was counted.', '/attendance/team'],
    ['Allocate and approve leave', 'Leave management shows the leave types your Super Workspace made available to you, who has them and requests waiting for you.', '/leave/manage'],
    ['Answer help queries', 'Queries from your Employee Workspace members arrive in Help & Support > Queries inbox. Reply, set the status or escalate to the Super Workspace.', '/help/inbox'],
  ], { audiences: HR, keywords: ['hr admin', 'start', 'first day'], related: ['how-approvals-work', 'what-is-hr-workspace', 'answer-a-help-query'] }),
  quick('getting-started-super', 'quickstart-super', 'Quick start for Super Workspace', 'Set up your company once: structure, people, HR Workspaces, features, rules and billing.', [
    ['Finish workspace setup', 'The setup wizard takes you through company details, locations and departments. You can change everything later.', '/setup'],
    ['Build your structure', 'Structure holds legal entities, departments, locations, designations and grades. Employee records pick from these lists.', '/organization'],
    ['Add your people', 'Create employees one by one or import them from a spreadsheet. Give each one a login and an access level under Logins & access.', '/employees'],
    ['Create HR Workspaces', 'An HR Workspace is a unit (a branch, department or client team) with its own HR admins and modules. People not in one stay in the central group.', '/hr-workspaces'],
    ['Choose features for each level', 'Super Workspace Admin > Features decides which modules and pages HR Workspace and Employee Workspace may use.', '/settings/hr-admin?tab=features'],
    ['Set the rules', 'Attendance settings, Holidays and leave rules, Leave management and Approval settings decide how requests are counted and approved.', '/settings/attendance'],
    ['Check plan and billing', 'Plan & billing shows your plan, seats, add-ons and invoices.', '/settings/billing'],
  ], { audiences: SUPER, keywords: ['owner', 'setup', 'company', 'admin'], related: ['what-is-hr-workspace', 'feature-switches-levels', 'import-employees'] }),
  faq('getting-started', 'what-is-sampcrew', 'What is SampCrew and how is it organised?', 'SampCrew is one platform for your whole workforce: people records, attendance, leave, payroll, recruitment, performance, learning, communication and more, on the web and on the phone app.\n\nIt has four levels:\n- Console Admin: the SAMPLEDGE team that runs SampCrew for every company.\n- Super Workspace: the people who run your company account and decide what everyone else may use.\n- HR Workspace: HR teams that look after a group of people (a branch, department or client team), or the whole company.\n- Employee Workspace: every person, for their own attendance, leave, payslips and requests.\n\nWhat you see in the menu follows your level, your permissions and the features your company switched on.', { keywords: ['levels', 'overview', 'about', 'four levels'], related: ['what-is-hr-workspace', 'why-cant-i-see-menu'] }),
  faq('getting-started', 'what-is-my-level', 'How do I know which level I am on?', 'Your level is shown under your name in the avatar menu and in Help & Support (for example "Help for HR Workspace"). It is given by your Super Workspace under Logins & access. Your job title or designation does not change your level.', { keywords: ['access level', 'role', 'my role'] }),
  faq('getting-started', 'where-is-help', 'Where can I find help while I work?', 'Three places:\n- The "i" icon next to page titles, sections and fields explains what each one is for.\n- Help & Support in the menu (and the ? button at the top) has guides, FAQs, tutorials and troubleshooting for the features you have.\n- Raise a Query, inside Help & Support, when you cannot find an answer.', { keywords: ['info icon', 'help', 'i icon'], href: '/help', related: ['raise-a-query'] }),

  // ============================================================================================ Account
  guide('account', 'enable-two-step', 'Turn on two-step verification', 'Protect your account with a code from an authenticator app every time you sign in on a new device.', [
    ['Open Security', 'Choose Security from your avatar menu (Password & sign-in).', '/settings/security'],
    ['Start set-up', 'Press Set up two-step verification. A QR code appears.'],
    ['Scan the code', 'Scan it with an authenticator app (Google Authenticator, Microsoft Authenticator or similar).'],
    ['Confirm', 'Type the 6-digit code from the app and save. Keep your recovery codes somewhere safe.'],
  ], { keywords: ['mfa', '2fa', 'authenticator', 'otp', 'security'], href: '/settings/security', related: ['lost-authenticator', 'mfa-step-up'] }),
  guide('account', 'change-password', 'Change your password', 'Change it any time from Security; you stay signed in on this device.', [
    ['Open Security', 'Avatar menu > Password & sign-in.', '/settings/security'],
    ['Enter passwords', 'Type your current password and the new one twice. Use at least 12 characters with letters, numbers and a symbol.'],
    ['Save', 'Press Change password. Other devices are asked to sign in again.'],
  ], { keywords: ['password', 'reset', 'change'], href: '/settings/security', related: ['forgot-password'] }),
  guide('account', 'forgot-password', 'Forgot your password?', 'Reset it by email from the sign-in page, on the web or the phone app.', [
    ['Open Forgot password', 'On the sign-in page press Forgot password and type your work email.'],
    ['Open the email', 'You get a link that works for a short time. Check spam if it does not arrive.'],
    ['Choose a new password', 'Open the link, set a new password and sign in.'],
  ], { keywords: ['forgot password', 'reset password', 'cannot sign in', 'locked out'], related: ['reset-email-not-arriving'] }),
  faq('account', 'sign-out-devices', 'How do I sign out of a device I no longer use?', 'Open Security. The list of places you are signed in shows each browser and phone with its last activity. Press Sign out next to the one you do not recognise, or sign out everywhere.', { keywords: ['sessions', 'devices', 'sign out'], href: '/settings/security' }),
  faq('account', 'notification-settings', 'How do I choose which notifications I get?', 'Open Notification settings. Switch each category on or off for SampCrew and email, set the notification sound and its volume, and choose whether pop-ups show. Approvals and workspace notices always appear in SampCrew.', { keywords: ['notifications', 'email alerts', 'sound', 'mute'], href: '/settings/notifications' }),
  faq('account', 'notification-center', 'Where can I see all my notifications?', 'The bell at the top shows the latest ones. Notifications in the You menu lists everything by category, with important ones first; filter by unread, category or priority, mark read or unread, and open one to go to its record.', { keywords: ['bell', 'notification center', 'alerts'], href: '/notifications' }),
  faq('account', 'appearance', 'Can I change how SampCrew looks?', 'Yes. Appearance lets you choose light or dark mode, a theme, colours, density, motion and accessibility options, and upload your photo. Your choice follows you to every device.', { keywords: ['theme', 'dark mode', 'photo', 'colours', 'accessibility'], href: '/settings/appearance' }),
  faq('account', 'mfa-step-up', 'Why am I asked for my two-step code again?', 'Sensitive actions such as payroll figures, billing and changing features ask you to confirm your two-step verification code even when you are signed in. Enter the code from your authenticator app and the action continues where you left it.', { keywords: ['mfa required', 'verify again', 'step up'], related: ['enable-two-step'] }),
  faq('account', 'switch-workspace', 'I belong to two companies. How do I switch?', 'If your login is a member of more than one workspace, the workspace switcher in the avatar menu lists them. Choose one; SampCrew opens it with your access in that company.', { keywords: ['switch company', 'multiple workspaces'] }),

  // ============================================================================================ Home, approvals, tasks
  faq('home-approvals', 'what-is-home', 'What does Home show?', 'Home is your daily starting point: clock in and out, your hours, leave balances and attendance this month, your calendar and tasks, what needs you today, announcements and shortcuts. HR Workspace and Super Workspace also see numbers for the people they look after. Use Customize to add, move or hide cards.', { keywords: ['dashboard', 'home page', 'widgets'], href: '/' }),
  faq('home-approvals', 'how-approvals-work', 'How do approvals work?', 'Every request that needs a decision (leave, attendance corrections, expenses, profile updates, job requisitions and more) goes through an approval chain set in Approval settings. Each step is decided by a person or a level. The Approvals page groups requests into category cards; your remarks are shared with the person who asked, and remarks are required to reject.', { keywords: ['approve', 'reject', 'approval chain', 'inbox'], href: '/approvals', related: ['approve-a-request', 'change-approval-chain'] }),
  guide('home-approvals', 'approve-a-request', 'Approve or reject a request', 'Decide the requests waiting for you from the Approvals page.', [
    ['Open Approvals', 'The inbox icon at the top shows how many are waiting.', '/approvals'],
    ['Pick a card', 'Requests are grouped into cards such as Leave or Expenses. Open one.'],
    ['Read the request', 'Open a request to see its details, documents, who decided earlier steps and their remarks.'],
    ['Decide', 'Press Approve, or Reject with a remark. The person is notified and sees your remark.'],
  ], { audiences: EVERYONE, keywords: ['approve', 'reject', 'pending'], href: '/approvals' }),
  guide('home-approvals', 'change-approval-chain', 'Change who approves a kind of request', 'Approval settings decide who approves each kind of request and in what order.', [
    ['Open Approval settings', 'Administration > Approval settings.', '/settings/approvals'],
    ['Choose the request type', 'Pick leave, expenses, corrections or another type.'],
    ['Edit the chain', 'Add, remove or reorder steps. A step can be the reporting manager, an HR Workspace, the Super Workspace or a named person.'],
    ['Save', 'New requests follow the new chain. Requests already in progress keep theirs.'],
  ], { audiences: SUPER, permission: 'org:manage', keywords: ['approval chain', 'approver', 'workflow'], href: '/settings/approvals' }),
  faq('home-approvals', 'what-are-tasks', 'What are My tasks?', 'Tasks are work given to you: HR tasks (upload a document, fill in a form, acknowledge a policy) and manager tasks from your reporting manager. Each has a due date and priority. Open a task to start it, upload what it asks for or send it for review.', { keywords: ['tasks', 'to do', 'assign task'], href: '/tasks' }),
  guide('home-approvals', 'assign-a-task', 'Assign a task to someone', 'Managers and HR can give a person a task with a due date and an optional document to upload.', [
    ['Open My tasks', 'Workspace > My tasks.', '/tasks'],
    ['Press Assign a task', 'Choose the person, write what is needed, set the due date and priority.'],
    ['Ask for a document (optional)', 'Tick that the task needs a document; you or HR verify it when it arrives.'],
    ['Follow up', 'Tasks I assign shows progress. Accept, reopen with a reason or cancel.'],
  ], { audiences: HR, keywords: ['assign', 'task', 'manager task'], href: '/tasks' }),

  // ============================================================================================ Communication
  faq('communication', 'what-is-communication', 'What is Communication?', 'Communication brings together chat with colleagues and the HR team, emails HR sends you, groups, and help requests to HR (Ask HR). HR sees an overview of emails sent and messages waiting for a reply.', { feature: 'helpdesk', permission: 'helpdesk:use', keywords: ['chat', 'messages', 'ask hr', 'email'], href: '/communication' }),
  guide('communication', 'start-a-chat', 'Start a chat', 'Send a message to a colleague, a group or the HR team.', [
    ['Open Communication > Chat', 'Your conversations are listed with unread ones first.', '/communication/chat'],
    ['Press New', 'Search a person by name, level or workspace, or choose a group.'],
    ['Write and send', 'Press Enter to send (Shift+Enter for a new line). Attach up to 5 files.'],
    ['Check delivery', 'Your messages show Sent, Delivered and Read.'],
  ], { feature: 'helpdesk', permission: 'helpdesk:use', keywords: ['chat', 'message', 'dm'], href: '/communication/chat' }),
  guide('communication', 'send-hr-email', 'Email people from HR', 'Send an email to everyone, departments, designations, groups or chosen people and follow its delivery.', [
    ['Open Emails', 'Communication > Emails > New email.', '/communication/emails/new'],
    ['Choose the audience', 'Pick everyone, departments, designations, groups or people. Add Cc or Bcc addresses if needed.'],
    ['Write it', 'Add the subject, message and attachments. Save a draft to finish later.'],
    ['Send and track', 'Each person gets their own copy. Open the email later to see who it was delivered to.'],
  ], { audiences: HR, feature: 'helpdesk', permission: 'helpdesk:manage', keywords: ['email', 'bulk email', 'mail'], href: '/communication/emails' }),
  faq('communication', 'ask-hr', 'How do I ask HR a question?', 'Use Ask HR in Communication: search the HR help articles first, then choose a category, write your question and send it. HR answers in the conversation and you are notified. For questions about using SampCrew itself, use Raise a Query in Help & Support.', { feature: 'helpdesk', permission: 'helpdesk:use', keywords: ['helpdesk', 'ask hr', 'hr question', 'case'], href: '/helpdesk', related: ['raise-a-query'] }),
  faq('communication', 'read-announcements', 'Where do I read company announcements?', 'Announcements lists news from HR and internal communications, urgent and pinned ones first. Open one to read it and download its files. If it asks you to acknowledge, press I have read this.', { feature: 'announcements', permission: 'announcements:read', keywords: ['news', 'notice', 'acknowledge'], href: '/announcements' }),
  guide('communication', 'publish-announcement', 'Publish an announcement', 'Write, target and publish news to everyone or chosen groups, now or on a schedule.', [
    ['Open Manage announcements', 'Engagement & relations > Manage announcements > New.', '/announcements/manage/new'],
    ['Choose the audience', 'Everyone, departments, designations, groups or chosen people.'],
    ['Write it', 'Add a title, formatted text, files, a category and priority. Urgent ones are also emailed.'],
    ['Ask for acknowledgement (optional)', 'Tick it to see who has read and acknowledged.'],
    ['Publish or schedule', 'Publish now or pick a date and time. Follow reads and remind people from the announcement page.'],
  ], { audiences: HR, feature: 'announcements', permission: 'announcements:manage', keywords: ['announcement', 'broadcast', 'schedule'], href: '/announcements/manage' }),
  faq('communication', 'sampcrew-support-chat', 'How does the Super Workspace contact SampCrew?', 'SampCrew Support (in the Workspace menu) is your company\'s private chat with the SampCrew Console Admin team, for questions, technical issues, account and billing. Only the Super Workspace can use it. You can also raise a query in Help & Support; queries from the Super Workspace go to the same team.', { audiences: SUPER, keywords: ['support', 'contact sampledge', 'console admin'], href: '/support', related: ['raise-a-query'] }),

  // ============================================================================================ Employees
  guide('employees', 'create-employee', 'Create an employee', 'The Create employee form walks you through personal details, job, pay and access.', [
    ['Open Employees', 'Employee management > Employees > Create employee.', '/employees?create=employee'],
    ['Personal details', 'Name, date of birth (calendar), phone and personal email. Duplicates are checked as you type.'],
    ['Job details', 'Legal entity, department, location, designation, grade, reporting manager and joining date.'],
    ['Access', 'Choose whether the person gets a login and at which level (Employee, HR or Super Workspace).'],
    ['Save', 'The record is created; the onboarding checklist starts if one is set up.'],
  ], { audiences: HR, permission: 'employees:create', keywords: ['hire', 'add employee', 'new joiner'], href: '/employees', related: ['import-employees', 'invite-login'] }),
  guide('employees', 'import-employees', 'Import existing employees from a spreadsheet', 'Add many people at once from a template, checked row by row before anything is saved.', [
    ['Open Import employees', 'Employee management > Import employees.', '/employees/import'],
    ['Download the template', 'It has every column SampCrew reads, including one per leave type for opening balances.'],
    ['Fill it in', 'One row per person. Required columns are marked.'],
    ['Check the file', 'Upload it and press Check. Fix the rows with problems and check again.'],
    ['Import', 'Only rows that pass are imported. The result lists what was added.'],
  ], { audiences: HR, permission: 'employees:create', feature: 'core_hr.import', keywords: ['import', 'excel', 'csv', 'bulk', 'upload'], href: '/employees/import' }),
  faq('employees', 'effective-dated-changes', 'How do I change someone\'s job, department or manager?', 'Open the employee and change the job details. Job changes are effective-dated: pick the date the change takes effect. The history tab keeps every earlier value, and reports use the value valid on each date.', { audiences: HR, permission: 'employees:read', keywords: ['transfer', 'promotion', 'job change', 'manager change'], href: '/employees' }),
  guide('employees', 'invite-login', 'Give someone a login and an access level', 'Logins & access decides who can sign in and at which level.', [
    ['Open Logins & access', 'Employee management > Logins & access.', '/people'],
    ['Invite', 'Press Invite a colleague and enter their work email.'],
    ['Choose the level', 'Employee Workspace, HR Workspace (for the whole company or named HR Workspaces) or Super Workspace.'],
    ['Limit it (optional)', 'For HR Workspace, limit the access to HR Workspaces, legal entities, departments or areas.'],
    ['Send', 'They receive an email to set their password. Changes to access apply at their next request.'],
  ], { audiences: HR, permission: 'users:read', keywords: ['invite', 'login', 'access', 'user'], href: '/people', related: ['what-is-hr-workspace'] }),
  faq('employees', 'suspend-login', 'How do I stop someone from signing in?', 'Open Logins & access, find the person and suspend their login. Their employee record stays. Suspended logins do not count toward your Employee Workspace limit.', { audiences: HR, permission: 'users:read', keywords: ['suspend', 'block', 'deactivate', 'exit'], href: '/people' }),
  guide('employees', 'review-profile-updates', 'Review profile changes from employees', 'Employees update their own profile; the change waits for HR before it becomes the official record.', [
    ['Open Profile updates', 'Employee management > Profile updates.', '/profile/updates'],
    ['Open an update', 'Compare the old and new values and any proof attached.'],
    ['Decide', 'Approve to update the record at once, or reject or ask for more information with a remark the employee sees.'],
  ], { audiences: HR, permission: 'profiles:review', keywords: ['profile update', 'bank change', 'address change'], href: '/profile/updates' }),
  faq('employees', 'update-my-profile', 'How do I update my own details?', 'Open My profile, choose a section and press Update. Your change goes to HR for approval and your current details stay until HR approves. Bank and identity numbers are shown masked.', { keywords: ['profile', 'address', 'bank details', 'emergency contact'], href: '/profile' }),
  faq('employees', 'company-structure', 'What goes into Structure?', 'Structure holds your legal entities, business units, departments, locations, designations and grades, and shows the reporting tree. Set these up before hiring, because employee records pick from these lists.', { audiences: HR, permission: 'org:read', keywords: ['department', 'location', 'designation', 'org chart', 'legal entity'], href: '/organization' }),
  faq('employees', 'custom-fields', 'Can we add our own fields to employee records?', 'Yes. Custom fields lets the Super Workspace add fields such as blood group or T-shirt size, with validation and the places they are used. Archived fields keep their values.', { audiences: SUPER, permission: 'fields:manage', keywords: ['custom field', 'extra field'], href: '/settings/custom-fields' }),
  faq('employees', 'background-verification', 'How does background verification work?', 'HR opens a verification case for a person, chooses the checks and an agency, and uploads documents. The agency works on the case in its own portal; every step is recorded in the case history.', { audiences: HR, feature: 'background_verification', permission: 'bgv:view', keywords: ['bgv', 'verification', 'agency'], href: '/verification' }),

  // ============================================================================================ HR Workspaces & access
  faq('hr-workspaces', 'what-is-hr-workspace', 'What is an HR Workspace?', 'An HR Workspace is a unit inside your company, such as a branch, department or client team, with its own HR admins and a set of modules the Super Workspace gives it. Its admins reach only its people and none of the company-wide settings. Employees not in any HR Workspace stay in the central group, run by the Super Workspace and company-wide HR.', { audiences: HR, keywords: ['hr workspace', 'branch', 'unit', 'central group'], href: '/hr-workspaces', related: ['create-hr-workspace', 'feature-switches-levels'] }),
  guide('hr-workspaces', 'create-hr-workspace', 'Create an HR Workspace and add people', 'Split your company into HR Workspaces, each with its admins, modules and people.', [
    ['Open HR Workspaces', 'Employee management > HR Workspaces > New HR Workspace.', '/hr-workspaces'],
    ['Name it', 'Give it a name, kind and an optional limit on how many people it may hold. Your plan sets how many HR Workspaces you can have.'],
    ['Choose modules', 'Tick the company modules it may use and pass on to its people.'],
    ['Add admins', 'Choose the people who run it. They get the HR Workspace level for it.'],
    ['Move people in', 'From the central group, tick people and move them in. Each move is recorded with a reason.'],
  ], { audiences: SUPER, permission: 'hierarchy:manage', keywords: ['create hr workspace', 'move employees', 'transfer'], href: '/hr-workspaces' }),
  faq('hr-workspaces', 'access-levels', 'What can each level do?', 'Access levels lists what Super Workspace, HR Workspace and Employee Workspace may do in each module, and at what scope (own, team, department, entity or the whole company). Super Workspace always has everything. A person\'s level is set under Logins & access; designation and job title do not change it.', { audiences: HR, permission: 'roles:read', keywords: ['permissions', 'roles', 'access levels', 'scope'], href: '/settings/roles' }),
  faq('hr-workspaces', 'workspace-limits', 'Why can\'t I add another HR Workspace or login?', 'Your plan sets how many HR Workspaces and Employee Workspaces (people who can sign in) your company may have. The pages where you create them show used and allowed. Archive an unused HR Workspace or suspend old logins, or ask the Super Workspace to upgrade the plan in Plan & billing.', { audiences: HR, keywords: ['limit reached', 'workspace_limit_reached', '402', 'seats'], related: ['change-plan'] }),

  // ============================================================================================ Feature management
  faq('feature-management', 'feature-switches-levels', 'Who decides which features I can use?', 'Features flow down the levels:\n- SAMPLEDGE (Console) decides what your company holds, through your plan and its own switches.\n- The Super Workspace switches modules, pages and buttons on or off for the HR Workspace level and the Employee Workspace level.\n- An HR Workspace can switch Employee Workspace features off for its own people, within what the Super Workspace allowed.\n\nA feature switched off at any level disappears from the menu and its pages and API are closed. Nothing is deleted; switching it back on brings everything back.', { audiences: HR, keywords: ['feature management', 'modules', 'switch off', 'enable feature', 'hidden'], related: ['switch-features-super', 'why-cant-i-see-menu'] }),
  guide('feature-management', 'switch-features-super', 'Switch features on or off for HR and Employee Workspaces', 'Super Workspace Admin > Features shows each module and page with its state for each level.', [
    ['Open Super Workspace Admin', 'Administration > Super Workspace Admin > Features.', '/settings/hr-admin?tab=features'],
    ['Open a module', 'Each module lists its pages and buttons with Active, Inherited, Inactive or Restricted labels.'],
    ['Switch a level', 'Turn a page off for the HR Workspace level, the Employee Workspace level or both. Switching off asks you to confirm with two-step verification.'],
    ['Check the result', 'People see the change at their next request. The change is recorded in the audit trail.'],
  ], { audiences: SUPER, permission: 'modules:manage', keywords: ['feature', 'switch', 'help centre on off'], href: '/settings/hr-admin?tab=features' }),
  guide('feature-management', 'switch-features-hr', 'Choose Employee Workspace features for your people', 'HR Workspaces can switch features off for the people they look after, within what the Super Workspace allowed.', [
    ['Open Employee features', 'Employee management > Employee features.', '/employee-features'],
    ['Pick the scope', 'The central group or one of your HR Workspaces.'],
    ['Switch pages off or on', 'Only features your level was given can be switched.'],
  ], { audiences: HR, permission: 'modules:assign', keywords: ['employee features', 'switch'], href: '/employee-features' }),
  faq('feature-management', 'help-availability', 'Can we switch Help & Support on or off?', 'Yes. Help & Support has three parts: the help centre (guides, FAQs and tutorials), raising and tracking queries, and the queries inbox for those who answer. SAMPLEDGE controls them for your company; the Super Workspace switches them for the HR Workspace and Employee Workspace levels in Super Workspace Admin > Features (People module).', { audiences: SUPER, keywords: ['help centre', 'disable help', 'raise query off'], href: '/settings/hr-admin?tab=features' }),

  // ============================================================================================ Attendance
  guide('attendance', 'how-to-punch-in', 'Clock in and out', 'Record your working time on the web, the phone app, a site kiosk or an attendance machine.', [
    ['On the web', 'Press Clock in at the top of Home or on Attendance when you start; Clock out when you finish.', '/attendance'],
    ['On the phone', 'Open the Attendance tab and punch. If you are offline it is saved and sent when you are back online.'],
    ['At a kiosk', 'Scan the site\'s QR code with your phone and confirm the punch.'],
    ['Check the day', 'Attendance shows how each day was counted: present, half day, absent, leave or holiday.'],
  ], { feature: 'attendance_basic', permission: 'attendance:punch', keywords: ['punch', 'clock in', 'check in', 'mark attendance'], href: '/attendance', related: ['request-correction', 'punch-refused-location'] }),
  guide('attendance', 'request-correction', 'Fix a missing or wrong punch', 'Ask for a correction for any day; your approver decides it in Approvals.', [
    ['Open Attendance', 'My work > Attendance.', '/attendance'],
    ['Choose the day', 'Open the day with the missing or wrong punch.'],
    ['Request a correction', 'Give the right in and out times and a reason.'],
    ['Wait for approval', 'The day is recounted once it is approved. You are notified either way.'],
  ], { feature: 'attendance_basic', permission: 'attendance:punch', keywords: ['correction', 'regularise', 'missing punch', 'forgot to punch'], href: '/attendance' }),
  faq('attendance', 'how-day-counted', 'How is my day counted as present, half day or absent?', 'Attendance settings set your shift, the hours needed for a full and half day, grace minutes and weekly offs. SampCrew applies them to your punches, approved leave and holidays. Open a day to see the raw punches and the rules that decided it.', { feature: 'attendance_basic', keywords: ['half day', 'absent', 'present', 'status'], href: '/attendance' }),
  guide('attendance', 'review-team-attendance', 'Review attendance for the people you look after', 'Find exceptions every day and approve corrections.', [
    ['Open Team attendance', 'Attendance & time > Team attendance.', '/attendance/team'],
    ['Filter exceptions', 'Show missing punches, late or absent people for a day.'],
    ['Open a person', 'See their day in detail and the rules applied.'],
    ['Approve corrections', 'Correction requests wait for you in Approvals.', '/approvals'],
  ], { audiences: HR, feature: 'attendance_basic', permission: 'attendance:approve', keywords: ['team attendance', 'exceptions', 'register'], href: '/attendance/team' }),
  faq('attendance', 'all-employees-register', 'Where do I see attendance for everyone?', 'All employees attendance shows a month register for everyone you can see, and the HR Workspace and Employee Workspace attendance pages give dashboards by HR Workspace and person, with an Excel export. Employee Workspace members see only their own attendance.', { audiences: HR, feature: 'attendance_basic', permission: 'attendance:approve', keywords: ['register', 'monthly attendance', 'export attendance', 'excel'], href: '/attendance/register' }),
  guide('attendance', 'late-coming-penalties', 'Manage late coming reminders and penalties', 'See late arrivals, the reminders sent and the deductions payroll will make.', [
    ['Open Late coming & penalties', 'Attendance & time > Late coming & penalties.', '/attendance/late'],
    ['Pick a month', 'Each late day shows whether a reminder was sent.'],
    ['Act', 'Send a reminder, withdraw one sent in error, or waive a penalty with a reason.'],
  ], { audiences: HR, feature: 'attendance_basic', permission: 'attendance:approve', keywords: ['late', 'penalty', 'deduction', 'reminder'], href: '/attendance/late' }),
  guide('attendance', 'attendance-settings', 'Set attendance rules', 'Shifts, punching rules, late-coming reminders, rewards, payroll locks and kiosks are set once in Attendance settings.', [
    ['Open Attendance settings', 'Attendance & time > Attendance settings.', '/settings/attendance'],
    ['Shifts and hours', 'Set shift times, full and half day hours, grace minutes and weekly offs.'],
    ['Punching rules', 'Choose where people may punch from (web, phone, kiosk, machines) and whether location is checked.'],
    ['Late coming', 'Set reminders and penalties.'],
    ['Payroll lock', 'Lock a month so attendance cannot change after payroll is run.'],
  ], { audiences: SUPER, feature: 'attendance_basic', permission: 'attendance:configure', keywords: ['attendance rules', 'shift', 'grace', 'weekly off'], href: '/settings/attendance' }),
  faq('attendance', 'shifts-rosters', 'How do shifts and rosters work?', 'Shifts shows your planned shifts and lets you ask a colleague to swap. People who schedule build a roster grid of who works which shift each day and publish it; everyone is notified of their shifts.', { feature: 'shift_scheduling', permission: 'shifts:read', keywords: ['roster', 'shift swap', 'schedule'], href: '/shifts' }),
  guide('attendance-devices', 'connect-attendance-machine', 'Connect a biometric or face attendance machine', 'Machines send punches straight to SampCrew.', [
    ['Open Attendance devices', 'Attendance & time > Attendance devices > Add machine.', '/settings/devices'],
    ['Follow the setup steps', 'Each machine type shows the server address and key to enter on the machine.'],
    ['Send a test punch', 'The log shows punches as they arrive.'],
    ['Map people', 'Map each employee to their user number on the machine.'],
  ], { audiences: SUPER, feature: 'attendance_advanced', permission: 'devices:manage', keywords: ['biometric', 'machine', 'zkteco', 'face', 'device'], href: '/settings/devices' }),
  faq('attendance-devices', 'qr-kiosk', 'How does the QR kiosk work?', 'A kiosk shows a QR code that changes often. People scan it with their phone to punch at that site. Set kiosks up in Attendance settings; geofences are set on each location under Structure.', { audiences: HR, feature: 'attendance_advanced', keywords: ['kiosk', 'qr code', 'site punch', 'geofence'], href: '/settings/attendance' }),
  fix('attendance', 'punch-refused-location', 'My punch was refused because of my location', 'Your company checks that phone punches are made at a work location.\n- Turn on location for SampCrew in your phone settings and try again outdoors or near a window.\n- Make sure you are inside the location\'s geofence; HR can see its radius under Structure > Locations.\n- If you work elsewhere today, punch anyway if allowed or ask for a correction afterwards.', { feature: 'attendance_basic', keywords: ['outside geofence', 'location', 'gps', 'punch refused'], related: ['request-correction'] }),

  // ============================================================================================ Leave
  guide('leave', 'how-to-apply-leave', 'Apply for leave', 'Ask for time off, attach a document if needed, and follow the decision.', [
    ['Open Leave', 'My work > Leave, or press Request time off in the Create menu.', '/leave'],
    ['Press Apply for leave', 'Choose the leave type. Your balance for it is shown.'],
    ['Choose the dates', 'Pick start and end dates, and half days if the type allows them.'],
    ['Add a reason and document', 'Some types ask for a document, such as a medical certificate.'],
    ['Send', 'The request goes to the approvers your company set. Follow it on the Leave page; you are notified of each decision.'],
  ], { feature: 'leave', permission: 'leave:request', keywords: ['apply leave', 'time off', 'holiday', 'vacation', 'sick leave'], href: '/leave', related: ['cancel-leave', 'leave-balance-wrong'] }),
  faq('leave', 'cancel-leave', 'Can I change or cancel my leave?', 'Yes. While a request waits for approval you can change or cancel it. Approved leave can be cancelled before it starts, and a change to approved leave goes for approval again. Open the request on the Leave page to do either.', { feature: 'leave', permission: 'leave:request', keywords: ['cancel leave', 'withdraw', 'change dates'], href: '/leave' }),
  faq('leave', 'leave-year-view', 'How do I see my leave for the whole year?', 'On the Leave page switch to Year view to see all twelve months, with holidays, approved and pending leave. Your balances per type are at the top.', { feature: 'leave', permission: 'leave:request', keywords: ['calendar', 'year view', 'holidays'], href: '/leave' }),
  faq('leave', 'who-approves-leave', 'Who approves my leave?', 'Each leave type has its approval route: your HR Workspace, the Super Workspace, or both in order, often after your reporting manager. The request page shows where it was sent and each decision with remarks.', { feature: 'leave', keywords: ['approver', 'leave approval', 'manager'], href: '/leave' }),
  guide('leave', 'create-leave-type', 'Create a leave type and its policy', 'The Super Workspace creates leave types, with their policy and approval route, in Leave management.', [
    ['Open Leave management', 'Attendance & time > Leave management > Leave types.', '/leave/manage'],
    ['Add a type', 'Pick a standard type (casual, sick, earned and more) or create your own with a code and colour.'],
    ['Set the policy', 'Yearly entitlement, accrual (monthly or quarterly), carry forward, half days, notice, documents and limits.'],
    ['Set approval', 'Choose HR Workspace, Super Workspace or both, and the order.'],
    ['Save', 'Every change is versioned; requests keep the rules they were made under.'],
  ], { audiences: SUPER, feature: 'leave', permission: 'leave:allocate', keywords: ['leave type', 'leave policy', 'accrual', 'carry forward'], href: '/leave/manage', related: ['allocate-leave'] }),
  guide('leave', 'allocate-leave', 'Allocate leave to people or HR Workspaces', 'Give leave types to employees, or make them available to HR Workspaces to allocate to their people.', [
    ['Open Leave management', 'Attendance & time > Leave management > Allocations.', '/leave/manage'],
    ['Choose the type', 'Pick a leave type the Super Workspace created.'],
    ['Choose who gets it', 'Employees (by department, location or people) or HR Workspaces. An HR Workspace allocates what it was given to its own people.'],
    ['Save', 'Balances appear for the people at once.'],
  ], { audiences: HR, feature: 'leave', permission: 'leave:allocate', keywords: ['allocate', 'assign leave', 'entitlement'], href: '/leave/manage' }),
  guide('leave', 'adjust-balance', 'Adjust someone\'s leave balance', 'Add or deduct days with a remark, for example to credit comp-off.', [
    ['Open Leave balances', 'Attendance & time > Leave balances.', '/leave/balances'],
    ['Find the person', 'Filter by department or search a name.'],
    ['Adjust', 'Press Adjust, choose the type, add or deduct days and write the remark (required; the person sees it).'],
    ['Check history', 'Adjustment history lists every change.'],
  ], { audiences: HR, feature: 'leave', permission: 'leave:approve', keywords: ['comp off', 'balance', 'credit leave', 'deduct'], href: '/leave/balances' }),
  guide('leave', 'holiday-calendars', 'Set up holiday calendars', 'Holidays per location or legal entity are added before the year starts.', [
    ['Open Holidays and leave rules', 'Attendance & time > Holidays and leave rules.', '/settings/leave'],
    ['Add a calendar', 'Name it and choose the locations or entities it covers.'],
    ['Add holidays', 'Add each date with a name. Optional holidays can be marked.'],
  ], { audiences: SUPER, feature: 'leave', permission: 'leave:allocate', keywords: ['holiday', 'public holiday', 'calendar'], href: '/settings/leave' }),
  fix('leave', 'leave-balance-wrong', 'My leave balance looks wrong', 'Balances come from your allocation, accrual and the requests you made.\n- Check that pending requests are counted as used until they are decided.\n- Accrual may add days monthly or quarterly, so early in the year you may not have the full year yet.\n- Open Leave and the type to see each credit and deduction.\n- If it is still wrong, ask HR: they can adjust the balance with a remark, or raise a query here.', { feature: 'leave', keywords: ['balance', 'wrong balance', 'missing leave'], related: ['adjust-balance', 'raise-a-query'] }),
  fix('leave', 'cannot-apply-leave', 'I cannot apply for a leave type', 'A type may be missing or refused because:\n- it was not allocated to you or your HR Workspace yet;\n- its policy needs notice days, a document or a minimum service period;\n- the dates overlap another request or a holiday;\n- the type is switched off for your level.\nThe form shows the reason when it refuses. Ask HR if the type should be available to you.', { feature: 'leave', keywords: ['leave refused', 'not allowed', 'leave type missing'] }),

  // ============================================================================================ Payroll
  faq('payroll', 'read-payslip', 'How do I read my payslip?', 'Open Payslips and choose a month. The payslip shows earnings, deductions, net pay and year-to-date totals; "How this was worked out" explains each line. Use Print for a paper or PDF copy. Payslips appear when payroll for the month is finalised.', { feature: 'payroll', permission: 'payslips:read', keywords: ['payslip', 'salary slip', 'net pay', 'deductions'], href: '/payslips' }),
  tutorial('payroll', 'run-payroll', 'Run monthly payroll', 'Start, compute, check and finalise a payroll run for one legal entity.', [
    ['Check salaries', 'Every employee needs a current salary. Add revisions under Salaries.', '/payroll/salaries'],
    ['Start a run', 'Payroll runs > New run, pick the month and legal entity.', '/payroll'],
    ['Compute', 'SampCrew uses attendance, leave, loss-of-pay days and adjustments.'],
    ['Review payslips', 'Open payslips with warnings, change loss-of-pay days or add one-off adjustments; the run recomputes.'],
    ['Send for approval', 'The approver finalises the run. Payslips are published to employees.'],
    ['Download files', 'Download the payroll register and the bank file for payment.'],
  ], { audiences: HR, feature: 'payroll', permission: 'payroll:read', keywords: ['payroll run', 'salary processing', 'bank file', 'register'], href: '/payroll' }),
  guide('payroll', 'salary-revision', 'Add a salary revision', 'Salaries are effective-dated annual CTC split into pay components.', [
    ['Open Salaries', 'Payroll > Salaries, then the employee.', '/payroll/salaries'],
    ['Add a revision', 'Enter the new CTC and the date it takes effect.'],
    ['Preview the split', 'Check the components before saving.'],
  ], { audiences: HR, feature: 'payroll', permission: 'payroll:read', keywords: ['ctc', 'increment', 'salary change', 'hike'], href: '/payroll/salaries' }),
  faq('payroll', 'payroll-settings', 'Where are statutory and pay component settings?', 'Payroll settings hold pay components, statutory schemes per country (India by default, with packs for the UK, US, UAE, Saudi Arabia, Qatar, Singapore and Australia, or a custom scheme) and payroll defaults. Changes apply to runs started afterwards.', { audiences: SUPER, feature: 'payroll', permission: 'payroll:configure', keywords: ['pf', 'esi', 'tax', 'statutory', 'components', 'country'], href: '/settings/payroll' }),
  faq('payroll', 'payroll-mfa', 'Why do payroll pages ask for two-step verification?', 'Pay figures are sensitive, so payroll pages need a session confirmed with two-step verification. If you have not turned it on yet, do it from Security.', { audiences: HR, feature: 'payroll', keywords: ['payroll mfa', 'verification'], related: ['enable-two-step'] }),

  // ============================================================================================ Expenses
  guide('expenses', 'claim-expense', 'Claim an expense', 'Get money back for work expenses with a receipt.', [
    ['Open Expenses', 'My work > Expenses > New claim.', '/expenses'],
    ['Fill it in', 'Category, date, amount and a short description.'],
    ['Attach the receipt', 'A photo or PDF of the receipt.'],
    ['Submit', 'Your approvers decide it. Approved claims are paid with your next salary.'],
  ], { feature: 'expenses', permission: 'expenses:submit', keywords: ['reimbursement', 'receipt', 'claim', 'travel'], href: '/expenses' }),

  // ============================================================================================ Recruitment
  tutorial('recruitment', 'hire-end-to-end', 'Hire someone from job requisition to offer', 'The full hiring flow in SampCrew.', [
    ['Create a job requisition', 'Jobs > Create job requisition. Give the role, headcount, skills and pay range.', '/recruitment?create=requisition'],
    ['Get it approved', 'Send it for approval; approvers decide it in Approvals.'],
    ['Publish the job', 'Publish it to your career site and share the link.'],
    ['Add candidates', 'Candidates apply online, or add them yourself or in bulk.', '/recruitment/candidates'],
    ['Interview', 'Schedule interviews; panel members submit scorecards under My interviews.', '/recruitment/interviews'],
    ['Compare and offer', 'Compare shortlisted candidates side by side, then make the offer and move them to Hired.'],
  ], { audiences: HR, feature: 'recruitment', permission: 'requisitions:read', keywords: ['hiring', 'job', 'ats', 'requisition', 'offer'], href: '/recruitment' }),
  faq('recruitment', 'pipeline-stages', 'How do I move candidates through the pipeline?', 'Open a job and drag candidates between stages on its board, or open a candidate and change the stage. Select several on Candidates to move, email or export them in bulk. Stages are set in Recruitment settings.', { audiences: HR, feature: 'recruitment', permission: 'candidates:read', keywords: ['pipeline', 'stage', 'kanban', 'move candidate'], href: '/recruitment/candidates' }),
  guide('recruitment', 'submit-scorecard', 'Submit an interview scorecard', 'Interview panel members rate the candidate after the interview.', [
    ['Open My interviews', 'Recruitment & ATS > My interviews.', '/recruitment/interviews'],
    ['Open the interview', 'See the role and the candidate\'s profile.'],
    ['Rate and recommend', 'Rate each skill with evidence and give your recommendation.'],
    ['Submit', 'Recruiters see your scorecard when comparing candidates.'],
  ], { feature: 'recruitment', permission: 'requisitions:read', keywords: ['scorecard', 'interview feedback', 'panel'], href: '/recruitment/interviews' }),
  faq('recruitment', 'recruitment-settings', 'What is in Recruitment settings?', 'Pipeline stages, sources, career site, offer templates and email templates used across hiring. Changes apply to new jobs and candidates.', { audiences: SUPER, feature: 'recruitment', permission: 'recruitment:configure', keywords: ['career site', 'stages', 'offer template'], href: '/settings/recruitment' }),
  faq('candidate-crm', 'what-is-candidate-crm', 'What is the Candidate CRM?', 'The Candidate CRM is your candidate database inside Recruitment & ATS: every candidate with a Candidate ID (CAN-…), their experience, pay, notice period, stage, recruiter, remarks, calls, follow-ups, documents and full timeline. The Super Workspace always has it and switches it on for each HR Workspace in CRM Settings.', { audiences: HR, feature: 'recruitment.crm', keywords: ['crm', 'candidate database', 'talent pool'], href: '/recruitment/crm' }),
  guide('candidate-crm', 'crm-add-candidate', 'Add a candidate to the CRM', 'Record a candidate with their details; duplicates are checked first.', [
    ['Open All candidates', 'Recruitment & ATS > Candidate CRM > Add candidate.', '/recruitment/crm/candidates/new'],
    ['Fill in details', 'Give an email or phone number, experience, pay, notice period, preferences and recruiter insights.'],
    ['Save', 'The candidate gets a Candidate ID. If a duplicate is found you can open the existing one instead.'],
  ], { audiences: HR, feature: 'recruitment.crm', keywords: ['add candidate', 'new candidate'], href: '/recruitment/crm/candidates' }),
  guide('candidate-crm', 'crm-follow-ups', 'Schedule and complete follow-ups', 'Never miss a call back: follow-ups remind you before they are due.', [
    ['Open a candidate', 'From All candidates or the pipeline.', '/recruitment/crm/candidates'],
    ['Schedule a follow-up', 'Choose the date, time and what to do. Log a call with its outcome at the same time if you like.'],
    ['Work the list', 'Follow-ups shows overdue, today and upcoming. Complete, reschedule or mark missed.', '/recruitment/crm/follow-ups'],
  ], { audiences: HR, feature: 'recruitment.crm', keywords: ['follow up', 'reminder', 'call back'], href: '/recruitment/crm/follow-ups' }),
  guide('candidate-crm', 'crm-import', 'Import candidates from Excel or CSV', 'Bring a spreadsheet of candidates in, with column matching and duplicate rules.', [
    ['Open Import', 'Candidate CRM > Import.', '/recruitment/crm/import'],
    ['Download the sample', 'Use it as a guide for your columns.'],
    ['Upload and match columns', 'SampCrew suggests a match for each column.'],
    ['Check every row', 'Choose what to do with duplicates, then import. Rows with problems go into an error report.'],
  ], { audiences: HR, feature: 'recruitment.crm', keywords: ['import candidates', 'excel', 'csv'], href: '/recruitment/crm/import' }),
  faq('candidate-crm', 'crm-access', 'Why can\'t my HR Workspace open the Candidate CRM?', 'The Super Workspace switches the CRM, and each of its powers (import, export, delete), on or off for each HR Workspace in Candidate CRM > Settings. Switching off keeps the data. Ask your Super Workspace to switch it on.', { audiences: HR, feature: 'recruitment', keywords: ['crm access', 'crm hidden'], href: '/recruitment/crm/settings' }),

  // ============================================================================================ Staffing
  guide('staffing', 'create-bid', 'Create and send a staffing bid', 'Price a staffing proposal, get it approved and send it to the client.', [
    ['Start a bid', 'Staffing bids > Quick Bid for a fast price, or New bid for the full editor.', '/staffing/bids'],
    ['Add roles', 'Pick the client and template, add roles with headcount, pay and bill rates. The margin updates as you type.'],
    ['Send for approval', 'Finance approves before the proposal can be sent.'],
    ['Email the proposal', 'The client accepts or declines online with a private link.'],
  ], { audiences: HR, feature: 'staffing_bids', permission: 'bids:read', keywords: ['bid', 'proposal', 'quote', 'margin', 'staffing'], href: '/staffing/bids' }),
  faq('staffing', 'rate-cards', 'What are rate cards and proposal templates?', 'Rate cards hold standard monthly pay and bill rates per role, for all clients or one client; picking one fills a bid\'s rates. Proposal templates hold the cover note, terms, validity and pricing defaults new bids start from; Quick Bid uses the default one.', { audiences: HR, feature: 'staffing_bids', permission: 'bids:read', keywords: ['rate card', 'template', 'bill rate'], href: '/staffing/rate-cards' }),

  // ============================================================================================ Performance
  faq('performance', 'set-goals', 'How do I set goals and check in?', 'Open Goals and press Set a goal: give it a period, weight and measurable key results. Add check-ins with your progress and confidence as you go; your manager sees every check-in.', { feature: 'performance', permission: 'performance:read', keywords: ['goals', 'okr', 'key results', 'check in'], href: '/goals' }),
  guide('performance', 'fill-appraisal', 'Complete your appraisal', 'Fill in your self-appraisal before the deadline; your manager and HR follow.', [
    ['Open Appraisal', 'My work > Appraisal, then the current cycle.', '/appraisal'],
    ['Answer each question', 'Pick a score for rated questions and add comments and written answers.'],
    ['Save drafts', 'Save as you go; nothing is shared until you submit.'],
    ['Submit', 'Your part locks. Your manager evaluates, HR reviews and you see the final result when HR shares it.'],
  ], { feature: 'performance', permission: 'performance:read', keywords: ['appraisal', 'self review', 'self appraisal', 'rating'], href: '/appraisal' }),
  tutorial('performance', 'run-appraisal-cycle', 'Build an appraisal form and launch a cycle', 'Set up appraisals for the whole company or a group.', [
    ['Open Appraisal forms & cycles', 'Performance & learning > Appraisal forms & cycles.', '/settings/appraisals'],
    ['Create a form', 'Start from a template or blank: sections, questions, weights, rating scale and performance categories.'],
    ['Create a cycle', 'Choose the form, period, people and deadlines for each stage.'],
    ['Launch', 'Appraisals are created for everyone in the cycle and they are notified.'],
    ['Review and share', 'HR reviews, then shares finalised results and closes the cycle.'],
  ], { audiences: HR, feature: 'performance', permission: 'performance:configure', keywords: ['appraisal cycle', 'review cycle', 'form builder'], href: '/settings/appraisals' }),
  faq('performance', 'review-cycles', 'What is the difference between Reviews and Appraisals?', 'Reviews are performance reviews with self, manager and peer feedback, run in review cycles. Appraisals are the scored yearly or half-yearly evaluation built from appraisal forms. Your company may use one or both.', { feature: 'performance', permission: 'performance:read', keywords: ['reviews', 'feedback', '360'], href: '/reviews' }),

  // ============================================================================================ Learning
  faq('learning', 'my-learning', 'Where are the courses assigned to me?', 'My learning lists the modules and learning paths assigned to you, with due dates and progress. Open one to start it; some have quizzes or assignments, and you can download a certificate when you complete it.', { feature: 'learning', permission: 'learning:read', keywords: ['course', 'training', 'certificate', 'quiz'], href: '/learning' }),
  tutorial('learning', 'create-learning-module', 'Create and assign a learning module', 'Build a module with lessons, quizzes and assignments and assign it to people.', [
    ['Open Learning management', 'Performance & learning > Learning management > New module.', '/learning/manage'],
    ['Add content', 'Lessons (text, video links, files), quizzes with a pass mark and assignments to review.'],
    ['Target it', 'Choose departments, designations, HR Workspaces or people, and the due date.'],
    ['Publish', 'People are notified and see it in My learning.'],
    ['Follow progress', 'Reports show completion, scores and overdue learners; review submitted assignments.'],
  ], { audiences: HR, feature: 'learning', permission: 'learning:manage', keywords: ['lms', 'module', 'assign training', 'quiz'], href: '/learning/manage' }),
  faq('learning', 'learning-paths', 'What is a learning path?', 'A learning path groups courses in order, such as an induction programme. HR builds paths under Learning paths (Course catalogue) and assigns them like a single course.', { audiences: HR, feature: 'learning', permission: 'learning:configure', keywords: ['learning path', 'catalogue', 'curriculum'], href: '/learning/catalogue' }),

  // ============================================================================================ Engagement
  faq('engagement', 'give-recognition', 'How do I thank a colleague?', 'Open Recognition, pick the person and a company value, say what they did and post it on the wall. They are notified.', { feature: 'engagement', permission: 'recognition:give', keywords: ['kudos', 'thanks', 'appreciation', 'recognition'], href: '/recognition' }),
  faq('engagement', 'answer-survey', 'Are surveys anonymous?', 'Anonymous surveys never show your name. Results for groups smaller than the anonymity threshold are hidden, so nobody can work out who answered. Open Surveys to answer the ones sent to you before they close.', { feature: 'engagement', permission: 'surveys:respond', keywords: ['survey', 'anonymous', 'pulse'], href: '/surveys' }),
  guide('engagement', 'run-survey', 'Run a survey', 'Ask a group questions and read the results by department.', [
    ['Open Survey results', 'Engagement & relations > Survey results > New survey.', '/surveys/manage'],
    ['Write questions', 'Add rating, choice and text questions.'],
    ['Choose the audience', 'Pick the people and an anonymity threshold.'],
    ['Open it', 'People are notified. Results update as answers come in.'],
  ], { audiences: HR, feature: 'engagement', permission: 'engagement:manage', keywords: ['survey', 'engagement', 'questionnaire'], href: '/surveys/manage' }),

  // ============================================================================================ Documents
  faq('documents', 'my-documents', 'Where are my documents?', 'Documents keeps your identity proofs, certificates, letters and other files, with their verification status. Upload what HR asks for, follow document requests and download what HR shared with you.', { permission: 'documents:read', feature: 'documents', keywords: ['documents', 'upload document', 'id proof', 'certificate'], href: '/documents' }),
  guide('documents', 'verify-documents', 'Verify or reject documents', 'HR checks uploaded documents and approves or rejects them with a comment.', [
    ['Open Documents', 'Find the person or the document request.', '/documents'],
    ['Open the document', 'Check the file and its details.'],
    ['Decide', 'Approve, or reject with a reason (required). The person sees your comment and can upload again.'],
  ], { audiences: HR, permission: 'documents:manage', feature: 'documents', keywords: ['verify document', 'reject document', 'document approval'], href: '/documents' }),
  faq('documents', 'document-access', 'Who can see employee documents?', 'Document access (Super Workspace) decides which levels and HR Workspaces may view, upload or verify each kind of document. Every download is recorded.', { audiences: SUPER, permission: 'documents:manage', feature: 'documents', keywords: ['document access', 'privacy', 'permissions'], href: '/settings/document-access' }),

  // ============================================================================================ Assets
  faq('assets', 'my-assets', 'How do I acknowledge a laptop or phone given to me?', 'My assets lists company assets given to you. Check each one and press Acknowledge. When you return it, HR records the return and its condition.', { feature: 'asset_management', permission: 'assets:view', keywords: ['laptop', 'asset', 'acknowledge', 'equipment'], href: '/assets/mine' }),
  guide('assets', 'assign-asset', 'Add and assign an asset', 'Keep track of who holds each company asset.', [
    ['Open Assets', 'Employee management > Assets > Add asset.', '/assets'],
    ['Describe it', 'Code, category, make, serial number, purchase and warranty details, and documents such as the invoice.'],
    ['Assign it', 'Choose the person and date. They are asked to acknowledge it.'],
    ['Record returns and repairs', 'The asset history keeps every change.'],
  ], { audiences: HR, feature: 'asset_management', permission: 'assets:view', keywords: ['inventory', 'assign laptop', 'asset register'], href: '/assets' }),

  // ============================================================================================ Onboarding
  guide('onboarding', 'onboarding-checklist', 'Build an onboarding checklist', 'Templates of tasks for HR, the manager and IT, copied onto each new joiner.', [
    ['Open Onboarding checklists', 'Employee management > Onboarding checklists.', '/settings/onboarding'],
    ['Create a template', 'Add tasks with who does each one and when, relative to the joining date.'],
    ['Use it', 'New employees get a copy when they are created. Changing a template does not change checklists already started.'],
  ], { audiences: HR, feature: 'onboarding', permission: 'employees:create', keywords: ['onboarding', 'joining', 'checklist', 'induction'], href: '/settings/onboarding' }),

  // ============================================================================================ Data import
  tutorial('data-import', 'data-import-wizard', 'Import data with the import wizard', 'Bring employees, attendance, leave balances and more in from Excel or CSV.', [
    ['Open Data import', 'Data import > New import.', '/imports/new'],
    ['Upload the file', 'Choose what you are importing and upload the spreadsheet.'],
    ['Match columns', 'SampCrew suggests a field for each column; create a new field if one is missing.'],
    ['Check problems', 'Every row is checked. Decide what to do with each problem row.'],
    ['Import', 'Finished imports are listed with what was added, changed or skipped.', '/imports'],
  ], { audiences: HR, feature: 'data_import', permission: 'imports:run', keywords: ['import', 'bulk upload', 'migration', 'excel'], href: '/imports' }),
  faq('data-import', 'master-data', 'What is master data?', 'Master data holds the lists other records pick from, such as designations, grades, banks and reasons, with a library of ready-made values. Change them in one place and every form uses the new values.', { audiences: HR, permission: 'org:read', feature: 'core_hr.master_data', keywords: ['master data', 'lists', 'dropdown values'], href: '/settings/master-data' }),

  // ============================================================================================ Analytics, AI, automation
  faq('analytics', 'hr-analytics', 'What does HR analytics show?', 'Live workforce numbers: headcount, joiners, leavers, attendance, leave, hiring and pay trends, calculated from live records when you open the page. Use the module tabs to switch.', { audiences: HR, permission: 'employees:read', feature: 'core_hr.analytics', keywords: ['analytics', 'reports', 'headcount', 'attrition'], href: '/insights' }),
  faq('analytics', 'workforce-universe', 'What is the Workforce Universe?', 'An interactive map of your workforce with skills, flows and locations. Switch lenses at the top, click a group to drill in, and build what-if scenarios to plan headcount and cost.', { audiences: HR, feature: 'workforce_universe', permission: 'employees:read', keywords: ['universe', 'workforce map', 'scenario'], href: '/insights/universe' }),
  faq('analytics', 'attrition-risk', 'How is attrition risk worked out?', 'A rules-based score from inputs such as tenure, pay changes, leave patterns and reviews. Open a person to see the reasons, talk to them or their manager, and record a review of what you did.', { audiences: HR, feature: 'workforce_analytics', permission: 'insights:attrition', keywords: ['attrition', 'flight risk', 'retention'], href: '/insights/attrition' }),
  tutorial('analytics', 'build-workflow', 'Build an automation workflow', 'Let SampCrew do repetitive work on its own, such as a welcome email when someone joins.', [
    ['Open Automation Studio', 'Analytics & AI > Automation Studio > New workflow.', '/automation/new'],
    ['Choose the trigger', 'What starts it, for example an employee joining or a leave request approved.'],
    ['Add steps', 'Send an email, create a task, post to Slack and more.'],
    ['Test it', 'Run it with sample values. It is saved inactive until you activate it.'],
    ['Activate and monitor', 'Workflow runs lists every run; open a failed one to see the step that failed and retry.', '/automation/runs'],
  ], { audiences: HR, feature: 'automation', permission: 'automation:manage', keywords: ['automation', 'workflow', 'trigger'], href: '/automation' }),
  faq('analytics', 'ai-settings', 'How is AI used in SampCrew?', 'AI features are off until your company switches them on in AI settings, where you choose what the assistant may do. AI activity records every request with who made it. SAMPLEDGE sets up the AI provider.', { audiences: SUPER, feature: 'ai_copilot', permission: 'ai:configure', keywords: ['ai', 'copilot', 'assistant'], href: '/settings/ai' }),

  // ============================================================================================ Compliance
  guide('compliance', 'privacy-request', 'Handle a privacy request', 'When someone asks for a copy of their data or for it to be erased.', [
    ['Log it', 'Compliance > Privacy requests > New request. Record who asked and what for.', '/privacy'],
    ['Prepare', 'For a copy, prepare and download the data. For erasure, review what would be removed.'],
    ['Complete', 'Confirm the erasure or send the copy, then close the request. Reject with a reason if it cannot be done.'],
  ], { audiences: HR, permission: 'privacy:manage', keywords: ['gdpr', 'dpdp', 'erase data', 'data copy'], href: '/privacy' }),
  faq('compliance', 'audit-trail', 'How do I find out who changed something?', 'Audit trail is a tamper-evident record of every change: who, what, when and from where. Filter by person, area or date, and open an event to see exactly what changed, before and after.', { audiences: HR, permission: 'audit:read', keywords: ['audit', 'history', 'who changed', 'log'], href: '/settings/audit' }),

  // ============================================================================================ Workspace settings
  faq('workspace-settings', 'workspace-defaults', 'Where do I change the company name, time zone or currency?', 'Workspace settings hold your organisation-wide defaults: name, time zone, currency, locale and brand colour. Legal entities and locations can override time zone and currency.', { audiences: SUPER, permission: 'tenant:read', keywords: ['company name', 'time zone', 'currency', 'logo'], href: '/settings/workspace' }),
  guide('workspace-settings', 'setup-sso', 'Set up single sign-on', 'Let people sign in with your company identity provider.', [
    ['Open Single sign-on', 'Administration > Single sign-on.', '/settings/single-sign-on'],
    ['Enter provider details', 'OIDC or SAML details from your identity provider.'],
    ['Test with one account', 'Make sure sign-in works before switching it on for everyone.'],
    ['Provision with SCIM (optional)', 'Create and remove users automatically from your directory.'],
  ], { audiences: SUPER, feature: 'sso', permission: 'security:manage', keywords: ['sso', 'saml', 'oidc', 'azure ad', 'okta', 'scim'], href: '/settings/single-sign-on' }),
  faq('workspace-settings', 'integrations', 'How do we connect SampCrew to other systems?', 'Integrations has API keys for your own systems, webhooks that post signed messages to your endpoint when something happens, and Slack for Automation Studio. Only workspace owners can change them.', { audiences: SUPER, feature: 'integrations_advanced', permission: 'integrations:manage', keywords: ['api', 'webhook', 'slack', 'integration'], href: '/settings/integrations' }),
  guide('workspace-settings', 'email-signature', 'Set up your Outlook email signature', 'Pick a design and keep it up to date in Outlook on your Windows computer.', [
    ['Open Email signature', 'You > Email signature.', '/settings/signature'],
    ['Choose a design', 'Pick one of 20 designs shown with your details.'],
    ['Customise', 'Colours, font, what is shown and your own links.'],
    ['Install', 'Download the setup file and open it on your Windows computer.'],
  ], { audiences: EVERYONE, feature: 'email_signatures', keywords: ['signature', 'outlook', 'email footer'], href: '/settings/signature' }),
  faq('workspace-settings', 'support-access', 'How do we let SAMPLEDGE support look at our workspace?', 'Support access lets the SAMPLEDGE support team see your workspace for a limited time and reason you choose. You can revoke it any time, and everything they do is audited.', { audiences: SUPER, permission: 'tenant:read', keywords: ['support access', 'grant access', 'sampledge'], href: '/settings/support' }),
  faq('workspace-settings', 'mobile-app-settings', 'Can we choose what the phone app shows?', 'Yes. Mobile app (Super Workspace) lets you choose the modules and tabs the central SampCrew app shows for each level, preview it and publish. The app only hides; it never gives access someone does not have.', { audiences: SUPER, permission: 'mobileapp:manage', keywords: ['mobile app config', 'phone tabs'], href: '/settings/mobile-app' }),

  // ============================================================================================ Billing
  faq('billing', 'change-plan', 'How do I change our plan or add seats?', 'Plan & billing shows your plan, seats in use, add-ons, invoices and every plan you can buy. Switch plan, start a free trial of a plan, add modules, and pay invoices online when SAMPLEDGE has set up Razorpay or Stripe. Enterprise is requested from SAMPLEDGE.', { audiences: SUPER, permission: 'billing:read', keywords: ['upgrade', 'plan', 'seats', 'pricing', 'subscription'], href: '/settings/billing' }),
  faq('billing', 'invoices', 'Where are our invoices?', 'Plan & billing lists every invoice with its status. Open one to download the GST invoice PDF or pay it online.', { audiences: SUPER, permission: 'billing:read', keywords: ['invoice', 'gst', 'payment', 'receipt'], href: '/settings/billing' }),
  fix('billing', 'workspace-read-only', 'Our workspace became read-only', 'A workspace turns read-only when an invoice stays unpaid past its due date. People can still sign in and read, but changes are refused. Pay the invoice in Plan & billing, or contact SampCrew Support if you have already paid; SAMPLEDGE can lift the lock for 7 days.', { audiences: SUPER, keywords: ['locked', 'read only', 'unpaid', 'cannot save'], href: '/settings/billing', related: ['sampcrew-support-chat'] }),

  // ============================================================================================ Mobile
  faq('mobile', 'install-app', 'How do I get the SampCrew phone app?', 'Install SampCrew from the Play Store or App Store (your company may send you a link), open it and sign in with your work email and password. You can turn on fingerprint or face unlock after the first sign-in.', { keywords: ['android', 'iphone', 'ios', 'install', 'download app'], related: ['quickstart-employee'] }),
  faq('mobile', 'app-features', 'What can I do in the app?', 'Punch in and out (also offline), apply for and follow leave, read payslips and announcements, approve requests, chat, follow tasks and reach Help & Support with the same guides and queries as on the web. What it shows follows your level and the features your company switched on.', { keywords: ['mobile features', 'app'] }),
  fix('mobile', 'app-stuck-loading', 'The app is stuck on the loading screen', 'Close the app fully and open it again. Check your internet connection. If it still does not open, update the app from the store, then sign in again. Your saved punches are kept and sent once you are back online.', { keywords: ['splash', 'loading', 'app not opening', 'crash'] }),
  fix('mobile', 'offline-punch', 'I punched while offline. Was it saved?', 'Yes. Punches made without a connection are kept on the phone (the Attendance tab shows a badge with how many are waiting) and sent with their original time once you are online.', { feature: 'attendance_basic', keywords: ['offline', 'no internet', 'queue'] }),

  // ============================================================================================ Help & Support
  guide('help-support', 'raise-a-query', 'Raise a query', 'When you cannot find an answer, ask the people who look after you. Every query gets a ticket ID you can follow.', [
    ['Open Help & Support', 'Press Help & Support in the menu, or the ? button at the top.', '/help'],
    ['Search first', 'Type your question or the error message. Most answers are already here.'],
    ['Press Raise a query', 'Choose a category (or Other), the page or feature it is about, a subject and a description.', '/help/queries/new'],
    ['Attach a screenshot', 'Add up to 5 files if they help explain the problem. Your name and email are filled in from your account.'],
    ['Submit and follow it', 'You get a ticket ID such as HQ-00012. Follow it under My queries; you are notified of every reply and status change.', '/help/queries'],
  ], { keywords: ['raise query', 'ticket', 'support request', 'contact', 'other'], href: '/help/queries/new', related: ['where-does-my-query-go', 'query-statuses'] }),
  faq('help-support', 'where-does-my-query-go', 'Who answers my query?', 'Queries go to the level that looks after you:\n- Employee Workspace: the HR Workspace that runs your group (or company-wide HR for the central group).\n- HR Workspace: the Super Workspace.\n- Super Workspace: the SampCrew Console Admin team.\nSome categories (for example product problems) go straight to SampCrew. Whoever handles it can escalate it to the level above.', { keywords: ['who answers', 'routing', 'escalate'], related: ['raise-a-query'] }),
  faq('help-support', 'query-statuses', 'What do the query statuses mean?', '- Open: received, nobody has picked it up yet.\n- In Progress: someone is working on it.\n- Awaiting User Response: the team replied and needs something from you. Reply to move it on.\n- Resolved: the team thinks it is answered. You can reopen it for a while if it is not.\n- Closed: finished; raise a new query if you need more help.', { keywords: ['status', 'open', 'in progress', 'awaiting', 'resolved', 'closed', 'reopen'], href: '/help/queries' }),
  faq('help-support', 'reopen-query', 'My query was resolved but the problem is back. What can I do?', 'Open it under My queries and press Reopen with a note. You can reopen a resolved query for a number of days set by SampCrew (14 by default). After that, or once it is closed, raise a new query and mention the old ticket ID.', { keywords: ['reopen', 'not fixed', 'resolved'], href: '/help/queries' }),
  tutorial('help-support', 'answer-a-help-query', 'Answer queries in the inbox', 'For HR Workspace and Super Workspace: answer the queries raised by the people you look after.', [
    ['Open the queries inbox', 'Help & Support > Queries inbox. New queries are at the top, with unassigned ones marked.', '/help/inbox'],
    ['Assign it', 'Assign it to yourself or a colleague so others know it is taken. The status moves to In Progress.'],
    ['Reply', 'Write the answer and attach files. Your reply sets Awaiting User Response unless you choose another status. Add an internal note the person does not see if useful.'],
    ['Resolve', 'Set Resolved once it is answered. The person can reopen it for a while, or rate the answer.'],
    ['Escalate if needed', 'If it needs the level above, press Escalate with a reason. It moves to the Super Workspace or SampCrew.'],
  ], { audiences: HR, feature: 'core_hr.help_inbox', keywords: ['answer query', 'inbox', 'support queue', 'tickets'], href: '/help/inbox' }),
  faq('help-support', 'tutorial-progress', 'How do tutorials work?', 'Tutorials are step-by-step walkthroughs of important workflows. Each step has a Go to page button that opens the right page, and a tick to mark it done. Your progress is saved, so you can come back later and carry on.', { keywords: ['tutorial', 'walkthrough', 'interactive'] }),

  // ============================================================================================ Troubleshooting
  fix('troubleshooting', 'why-cant-i-see-menu', 'I cannot see a menu item or page', 'Menu items show only when all three are true:\n- your company\'s plan includes the module and SAMPLEDGE has it switched on;\n- your level has it switched on (the Super Workspace, or your HR Workspace, may have switched it off);\n- you hold the permission it needs.\nAsk your Super Workspace (or HR Workspace) which of these applies, or raise a query.', { keywords: ['missing menu', 'not visible', 'hidden page', 'no access', 'cannot find'], related: ['feature-switches-levels', 'raise-a-query'] }),
  fix('troubleshooting', 'no-access-page', 'I see "You do not have access" or a 403 error', 'The page or action needs a permission or level you do not have, or the feature was switched off for your level. If you think you should have it, ask your Super Workspace to check Logins & access, or raise a query with the page you tried to open.', { keywords: ['403', 'forbidden', 'no access', 'not allowed', 'permission denied'], related: ['why-cant-i-see-menu'] }),
  fix('troubleshooting', 'session-expired', 'I keep getting signed out', 'Sessions end after a period without activity and when your password or access changes. Sign in again. If it happens every few minutes, clear the site\'s cookies, check your computer\'s clock is right and make sure your browser accepts cookies for SampCrew.', { keywords: ['signed out', 'session expired', 'login loop', '401'] }),
  fix('troubleshooting', 'lost-authenticator', 'I lost the phone with my authenticator app', 'Use one of your recovery codes to sign in, then set up two-step verification again on your new phone from Security. If you have no recovery codes, ask your Super Workspace (or SAMPLEDGE for a Super Workspace) to reset your two-step verification.', { keywords: ['lost phone', 'mfa reset', 'authenticator', 'recovery code'], related: ['enable-two-step'] }),
  fix('troubleshooting', 'reset-email-not-arriving', 'The password reset email does not arrive', 'Check spam and the address you typed. Reset emails need email delivery set up for SampCrew; the Super Workspace can see every reset in Password resets, where "Email not set up" means SAMPLEDGE must set up email delivery first. Your Super Workspace can also set a temporary password for you.', { keywords: ['reset email', 'no email', 'forgot password'], related: ['forgot-password'] }),
  fix('troubleshooting', 'upload-refused', 'My file upload was refused', 'Files can be up to 10 MB, and must be a PDF, image (PNG, JPEG or WebP), Office document, text or CSV file whose content matches its type. Renaming a file to a different extension makes it fail the check. Reduce the size or export it again as PDF.', { keywords: ['upload failed', 'file too large', 'unsupported type', 'content mismatch'] }),
  fix('troubleshooting', 'mfa-required-error', 'An action fails with "two-step verification required"', 'Sensitive pages (payroll, billing, feature switches) need two-step verification. Turn it on in Security, then try again; you will be asked for the code in place.', { keywords: ['mfa_required', 'mfa required', 'verification required'], related: ['enable-two-step', 'mfa-step-up'] }),
  fix('troubleshooting', 'page-slow-or-error', 'A page shows "Something went wrong"', 'Reload the page. If it keeps happening, note what you were doing and the time, then raise a query with a screenshot. The team can find the error from the time and page.', { keywords: ['error', 'something went wrong', '500', 'crash', 'bug'], related: ['raise-a-query'] }),

  // ============================================================================================ Console Admin
  quick('console-start', 'quickstart-console', 'Quick start for Console Admin', 'Your first day in the SampCrew Console.', [
    ['Secure your account', 'Two-step verification is required for every Console action. Change your temporary password when asked.'],
    ['Look at the Overview', 'Workspaces, trials, subscriptions and revenue across all customers.', '/'],
    ['Open a workspace', 'Workspaces lists every customer with plan, status and seats.', '/tenants'],
    ['Answer support', 'Support inbox has Super Workspace conversations; Help queries has queries raised in the help centre.', '/support'],
    ['Know your role', 'Super admin, Support, Billing operations and Viewer roles see different menus.'],
  ], { audiences: CONSOLE, keywords: ['console', 'start', 'admin'], related: ['console-roles'] }),
  faq('console-start', 'console-roles', 'What can each Console role do?', '- Super admin: everything, including Console admins, integrations, plans and Help content.\n- Support: workspaces (read), support inbox, help queries, health and audit.\n- Billing operations: billing, plans and revenue.\n- Viewer: read-only overview, billing and health.', { audiences: CONSOLE, keywords: ['console roles', 'capabilities', 'permissions'], href: '/admins' }),
  guide('console-companies', 'console-create-workspace', 'Create a workspace for a customer', 'Set up a new company with its plan and first Super Workspace.', [
    ['Open Workspaces', 'Press New workspace.', '/tenants'],
    ['Company details', 'Name, slug, country and the first Super Workspace person\'s email.'],
    ['Plan', 'Choose the plan, seats, billing period and an optional trial.'],
    ['Create', 'The Super Workspace receives an invitation to sign in.'],
  ], { audiences: CONSOLE, keywords: ['new tenant', 'new customer', 'create workspace'], href: '/tenants' }),
  faq('console-companies', 'console-tenant-users', 'How do I help a customer with a login?', 'Open the workspace > Users. Reset a password, force a password change, lock or unlock a login, or sign someone out everywhere. A reason is required and recorded in both audit trails.', { audiences: CONSOLE, keywords: ['reset password', 'unlock user', 'login help'], href: '/tenants' }),
  faq('console-companies', 'console-suspend', 'How do I suspend a workspace?', 'Open the workspace and choose Suspend with a reason. People cannot sign in until it is reactivated. The change is recorded in the platform audit and the customer\'s audit trail.', { audiences: CONSOLE, keywords: ['suspend', 'deactivate tenant'], href: '/tenants' }),
  faq('console-plans', 'console-plans', 'How do plans work?', 'Plans & pricing defines each plan\'s modules, limits (employees, HR Workspaces, Employee Workspaces) and prices per currency. A customer\'s features come from their plan, add-ons, deals and Console overrides, worked out on every request.', { audiences: CONSOLE, keywords: ['plans', 'pricing', 'limits', 'modules'], href: '/plans' }),
  faq('console-plans', 'console-billing', 'What is in Billing & revenue?', 'MRR and ARR, every invoice, the add-on catalogue, coupon codes, seller details and GST, reminders, and notifications from Razorpay and Stripe. Record bank transfers with Mark paid. Payment keys are kept in Integrations.', { audiences: CONSOLE, keywords: ['revenue', 'mrr', 'invoices', 'coupons', 'razorpay', 'stripe'], href: '/billing' }),
  faq('console-features', 'console-feature-management', 'How do I switch a feature off for every company or one company?', 'Feature management (Console) switches each module and page for the whole application: new features start Pending until you activate them. For one company, open the workspace > Features & permissions and use the Pages and buttons board. Company admins then decide within what you allowed.', { audiences: CONSOLE, keywords: ['feature flags', 'pending', 'activate', 'per company'], href: '/features' }),
  faq('console-features', 'console-help-availability', 'How do I control Help & Support for a company?', 'Help & Support has three parts in the People module: Help centre (guides, FAQs and tutorials), Raise and track queries, and Queries inbox. Switch them for every company in Feature management, or for one company in its Features & permissions board. The Super Workspace then switches them for HR and Employee Workspace levels.', { audiences: CONSOLE, keywords: ['help centre on off', 'disable queries'], href: '/features' }),
  guide('console-support', 'console-support-inbox', 'Answer a Super Workspace in the support inbox', 'Private conversations with each company\'s Super Workspace.', [
    ['Open Support inbox', 'Unread conversations show in the menu badge.', '/support'],
    ['Filter', 'Unread, Waiting for reply, Replied or Resolved. Search by company, subject or text.'],
    ['Reply', 'Your name is recorded on the message. The Super Workspace is notified.'],
    ['Resolve', 'Resolve when done. A new message from the workspace reopens it.'],
  ], { audiences: CONSOLE, keywords: ['support inbox', 'chat', 'customer'], href: '/support' }),
  tutorial('console-support', 'console-help-queries', 'Handle help queries from Super Workspaces', 'Queries raised in the help centre by Super Workspaces, and escalated from HR Workspaces, come to the Console team.', [
    ['Open Help queries', 'The list shows every company\'s queries with status, category and assignee.', '/help-queries'],
    ['Assign', 'Assign a query to yourself or another Console Admin.'],
    ['Reply or ask for more', 'Reply sets Awaiting User Response by default. Add internal notes the company does not see.'],
    ['Update the status', 'Move it to In Progress, Resolved or Closed. The raiser is notified of each change.'],
  ], { audiences: CONSOLE, keywords: ['help queries', 'tickets', 'support queue'], href: '/help-queries' }),
  tutorial('console-help', 'console-write-article', 'Add a FAQ, guide or tutorial', 'Write new help content when a feature changes or is added.', [
    ['Open Help content', 'Help content > Articles > New article.', '/help-content'],
    ['Choose the kind and category', 'FAQ, Guide, Tutorial, Troubleshooting or Quick start, in a category or subcategory.'],
    ['Write it', 'Title, summary and body. Guides and tutorials have steps, each with an optional page link.'],
    ['Target it', 'Choose the levels (Console Admin, Super, HR, Employee Workspace), and optionally the feature and permission it needs. People without them never see it.'],
    ['Publish or save as draft', 'Drafts are only visible here. Publish when ready; unpublish any time.'],
  ], { audiences: CONSOLE, keywords: ['write article', 'new faq', 'help content', 'cms'], href: '/help-content' }),
  faq('console-help', 'console-builtin-content', 'What happens to built-in help content when SampCrew is updated?', 'SampCrew comes with a built-in library. Updates add new built-in articles and refresh ones you have not touched. Once you edit, unpublish or delete a built-in article or category, updates leave it as you set it.', { audiences: CONSOLE, keywords: ['built in', 'library', 'update', 'seed'], href: '/help-content' }),
  guide('console-help', 'console-query-categories', 'Manage query categories and settings', 'Choose what people pick from when they raise a query, and how queries behave.', [
    ['Open Help content > Query categories', 'Add, rename, reorder or switch off categories. Other is always last and cannot be removed.', '/help-content?tab=categories'],
    ['Send some straight to SampCrew', 'Tick "Goes to SampCrew Support" for categories such as product problems.'],
    ['Settings', 'Allow attachments, how many days a resolved query may be reopened, whether handlers may escalate, and the welcome text.', '/help-content?tab=settings'],
  ], { audiences: CONSOLE, keywords: ['query categories', 'other', 'settings', 'attachments'], href: '/help-content' }),
  faq('console-platform', 'console-admins', 'How do I add another Console Admin?', 'Console admins (Super admin only) lets you invite an admin with a role, reset their password or disable them. Every admin must use two-step verification. If everyone is locked out, the recovery command on the server (pnpm db:admin) creates or resets one.', { audiences: CONSOLE, keywords: ['console admin', 'invite admin', 'recovery'], href: '/admins' }),
  faq('console-platform', 'console-integrations', 'Where are API keys for email, payments and AI?', 'Integrations keeps every key in the database: email delivery, Razorpay and Stripe, AI provider and more. The server\'s .env file only holds the database connection.', { audiences: CONSOLE, keywords: ['integrations', 'smtp', 'api keys', 'razorpay'], href: '/integrations' }),
  faq('console-platform', 'console-health', 'How do I check the system is healthy?', 'System health shows the API, database replication, backups (including point-in-time backups) and background jobs. Platform audit records every Console action.', { audiences: CONSOLE, keywords: ['health', 'backups', 'status', 'audit'], href: '/health' }),
  faq('console-platform', 'console-statutory-packs', 'What are payroll country packs?', 'Payroll country packs hold the statutory rules (contributions, taxes, limits) for each supported country. Companies pick them in Payroll settings; India is the default.', { audiences: CONSOLE, keywords: ['statutory', 'country pack', 'payroll rules'], href: '/statutory-packs' }),
];

/** Categories people choose from when raising a query. "other" is required and always last. */
export const HELP_QUERY_CATEGORY_SEED: { key: string; label: string; description: string; toConsole: boolean; sort: number }[] = [
  { key: 'account', label: 'Account, sign-in & security', description: 'Passwords, two-step verification, sessions and access.', toConsole: false, sort: 10 },
  { key: 'people', label: 'Employee records & profile', description: 'Employee details, profile updates, structure and logins.', toConsole: false, sort: 20 },
  { key: 'attendance', label: 'Attendance & shifts', description: 'Punches, corrections, late coming, shifts and machines.', toConsole: false, sort: 30 },
  { key: 'leave', label: 'Leave', description: 'Applying, balances, leave types and approvals.', toConsole: false, sort: 40 },
  { key: 'payroll', label: 'Payroll, payslips & expenses', description: 'Payslips, salaries, payroll runs and expense claims.', toConsole: false, sort: 50 },
  { key: 'recruitment', label: 'Recruitment & Candidate CRM', description: 'Jobs, candidates, interviews and the CRM.', toConsole: false, sort: 60 },
  { key: 'performance-learning', label: 'Performance & learning', description: 'Goals, appraisals, reviews and courses.', toConsole: false, sort: 70 },
  { key: 'communication', label: 'Communication & announcements', description: 'Chat, emails, announcements and notifications.', toConsole: false, sort: 80 },
  { key: 'mobile', label: 'Mobile app', description: 'Installing, signing in and using the phone app.', toConsole: false, sort: 90 },
  { key: 'access-features', label: 'Access & features', description: 'Missing menus, permissions and feature switches.', toConsole: false, sort: 100 },
  { key: 'billing', label: 'Plan & billing', description: 'Plans, seats, invoices and payments (answered by SampCrew).', toConsole: true, sort: 110 },
  { key: 'bug', label: 'Something is not working (SampCrew product)', description: 'An error or a problem with SampCrew itself (answered by SampCrew).', toConsole: true, sort: 120 },
  { key: 'feedback', label: 'Suggestion or feedback', description: 'An idea to make SampCrew better.', toConsole: false, sort: 130 },
  { key: 'other', label: 'Other', description: 'Anything that does not fit the categories above.', toConsole: false, sort: 10000 },
];

// ------------------------------------------------------------------------------------------------------ sync

interface SyncTables {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  collection(name: string): any;
}

/**
 * Seeds and refreshes the built-in library. Rows a Console Admin edited (customised_at) or deleted (deleted_at) are
 * left exactly as they are; a key or slug a Console Admin already used for their own content is skipped. Safe to run
 * on every catalogue sync.
 */
export async function syncHelpLibraryMongo(tx: SyncTables): Promise<{ categories: number; articles: number; queryCategories: number }> {
  const out = { categories: 0, articles: 0, queryCategories: 0 };
  const cats = tx.collection('help_categories');
  const ids = new Map<string, string>();
  // Parents first, so subcategories can name them.
  const ordered = [...HELP_LIBRARY_CATEGORIES.filter((c) => !c.parent), ...HELP_LIBRARY_CATEGORIES.filter((c) => c.parent)];
  for (const c of ordered) {
    const fields = {
      key: c.key, name: c.name, description: c.description, icon: c.icon, audiences: c.audiences, feature: c.feature ?? null,
      parent_id: c.parent ? ids.get(c.parent) ?? null : null, sort: c.sort, status: 'published',
    };
    const existing = await cats.findOne({ key: c.key });
    if (!existing) {
      const row = await cats.insert({ ...fields, builtin_key: c.key });
      ids.set(c.key, row.id);
      out.categories += 1;
      continue;
    }
    ids.set(c.key, existing.id);
    if (existing.builtin_key !== c.key || existing.customised_at || existing.deleted_at) continue;
    await cats.updateOne({ id: existing.id }, { $set: fields });
  }
  const arts = tx.collection('help_articles');
  for (const a of HELP_LIBRARY_ARTICLES) {
    const categoryId = ids.get(a.category);
    if (!categoryId) continue;
    const fields = {
      slug: a.slug, category_id: categoryId, kind: a.kind, title: a.title, summary: a.summary, body: a.body, steps: a.steps,
      audiences: a.audiences, feature: a.feature ?? null, permission: a.permission ?? null, keywords: a.keywords, href: a.href ?? null,
      related: a.related, sort: a.sort, status: 'published',
    };
    const existing = await arts.findOne({ slug: a.slug });
    if (!existing) {
      await arts.insert({ ...fields, builtin_key: a.slug });
      out.articles += 1;
      continue;
    }
    if (existing.builtin_key !== a.slug || existing.customised_at || existing.deleted_at) continue;
    await arts.updateOne({ id: existing.id }, { $set: fields });
  }
  const qcats = tx.collection('help_query_categories');
  for (const q of HELP_QUERY_CATEGORY_SEED) {
    const fields = { key: q.key, label: q.label, description: q.description, to_console: q.toConsole, sort: q.sort, active: true };
    const existing = await qcats.findOne({ key: q.key });
    if (!existing) {
      await qcats.insert({ ...fields, builtin_key: q.key });
      out.queryCategories += 1;
      continue;
    }
    if (existing.builtin_key !== q.key || existing.customised_at || existing.deleted_at) continue;
    await qcats.updateOne({ id: existing.id }, { $set: fields });
  }
  const settings = tx.collection('help_settings');
  if (!(await settings.exists({ key: 'default' }))) {
    await settings.insert({ key: 'default', attachments: true, reopen_days: 14, escalation: true, welcome: 'Search guides, FAQs and tutorials, or raise a query and we will get back to you.' });
  }
  return out;
}
