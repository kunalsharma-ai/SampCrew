/**
 * Help text for the "i" icons in the SampCrew mobile app. Edit the words here; each screen, card or field that shows
 * an icon names its entry by key (for example `help="leave.balances"`), so a typo is a type error.
 *
 * `what` is what it is for; `how` how to use it; `where` where or when it is used. Keep each to a sentence or two.
 */
export interface MobileHelpEntry {
  title: string;
  what: string;
  how?: string;
  where?: string;
}

export const MOBILE_HELP = {
  // Screens (shown in the header)
  home: {
    title: 'Home',
    what: 'Your day at a glance: today’s shift and punches, approvals waiting for you, leave left, announcements and notifications.',
    how: 'Tap a tile or a quick action to jump straight to it. Pull down to refresh.',
    where: 'Open the app here every day.',
  },
  attendance: {
    title: 'Attendance',
    what: 'Punch in and out, and see today’s punches and how your day is counted.',
    how: 'Tap Punch in when you start and Punch out when you finish. Without a signal, punches are saved on the phone and sent later.',
    where: 'At work, on each working day. Your workspace may ask for your location or a selfie.',
  },
  leave: {
    title: 'Leave',
    what: 'Your leave balances and your leave requests.',
    how: 'Tap Apply for leave to ask for time off. You can cancel a request while it is still pending.',
    where: 'Whenever you plan time off. Your manager is notified to approve it.',
  },
  'leave.new': {
    title: 'Apply for leave',
    what: 'Ask for time off.',
    how: 'Choose the leave type, the first and last day, and whether it is a full or half day, then send.',
    where: 'Send it as early as you can. You get a notification when it is decided.',
  },
  helpdesk: {
    title: 'Ask HR',
    what: 'Questions you have sent to HR and their answers.',
    how: 'Tap Ask a question to start one. Open a case to read HR’s reply or answer back.',
    where: 'For anything about pay, leave, policies or your records.',
  },
  'helpdesk.new': {
    title: 'Ask HR a question',
    what: 'Send a question to HR.',
    how: 'Pick a topic so it reaches the right person, write a short subject and your question, then send.',
    where: 'HR replies in the app and you are notified.',
  },
  'helpdesk.case': {
    title: 'Case',
    what: 'One question to HR: the conversation and what happens next.',
    how: 'Reply at the bottom. When it is resolved, rate how HR handled it.',
  },
  tasks: {
    title: 'My tasks',
    what: 'Tasks HR and your manager gave you, such as uploading a document, reading a policy or finishing a piece of work.',
    how: 'Switch between HR tasks and Manager tasks. Tap a task to update it.',
    where: 'Overdue tasks are open tasks past their due date.',
  },
  'tasks.list': {
    title: 'Task list',
    what: 'Your tasks with their status. Open shows what still needs you; All includes finished ones.',
  },
  'tasks.task': {
    title: 'Task',
    what: 'One task: what it asks for, who gave it and its history.',
    how: 'Start it, send it for review or mark it completed. For a document task, take or choose a photo and upload it.',
  },
  'tasks.document': {
    title: 'Document',
    what: 'The document this task asks for. HR checks it and verifies or rejects it.',
    how: 'Take a clear photo, choose one, or choose a file (PDF, Word or text) from your phone, as the task allows. Add a remark if needed, then upload. If HR rejects it, the task reopens with their reason.',
  },
  appraisal: {
    title: 'Appraisal',
    what: 'Your performance appraisals: the self-appraisal to fill in and results HR has shared.',
    how: 'Open the current one to score yourself and write your answers.',
  },
  'appraisal.list': {
    title: 'Self-appraisal',
    what: 'The appraisal waiting for your self-assessment, and how much you have answered.',
    where: 'Submit it before the due date. Your manager evaluates it next.',
  },
  'appraisal.team': {
    title: 'My team',
    what: 'Appraisals of the people who report to you. Each one is yours to evaluate once they submit their self-appraisal.',
    how: 'Open one, score each question next to their own score, write your section, save and submit. HR reviews it next.',
  },
  'appraisal.hr': {
    title: 'HR review',
    what: 'Appraisals whose manager evaluation is in, and finalised ones not yet shared with the employee.',
    how: 'Open one to set final scores or an approved percentage with a reason, finalise it, then share the result.',
  },
  'appraisal.form': {
    title: 'Appraisal form',
    what: 'Score each question on the scale and answer the written questions: your self-appraisal, or, as a manager or HR, your part of someone else’s.',
    how: 'Save a draft any time. Submit once every required question is answered; it then locks.',
  },
  'appraisal.result': {
    title: 'Your result',
    what: 'The final percentage and band HR approved, with your own and your manager’s scores.',
  },
  profile: {
    title: 'My profile',
    what: 'Your personal, contact, emergency, address, bank and identity details, and your work details.',
    how: 'Tap Request a change on personal, emergency, address, bank or skills. HR approves it before your record changes, and you are notified. Education, jobs and ID numbers need documents, so change them on the web.',
  },
  'profile.work': {
    title: 'Work details',
    what: 'Your job, manager, location, shift and working days, as HR keeps them.',
    where: 'Ask HR if something here is wrong.',
  },
  'profile.updates': {
    title: 'Profile updates',
    what: 'Changes you send go to HR for approval. Only one update per section is open at a time.',
    how: 'Withdraw a pending update to change it, or wait for HR. If HR asks for more information, send a new update.',
  },
  'profile.masked': {
    title: 'Masked numbers',
    what: 'Bank account, PAN and Aadhaar numbers are stored encrypted and show only their last 4 characters.',
  },
  'home.workspace': {
    title: 'My workspace',
    what: 'Your open tasks, the self-appraisal waiting for you and this month’s attendance rewards.',
    how: 'Tap a line to open it.',
  },
  me: {
    title: 'Me',
    what: 'Your profile, photo, payslips, security and how the app looks.',
    how: 'Change your photo, open a payslip, manage sign-in and pick a theme.',
  },
  approvals: {
    title: 'Approvals',
    what: 'Requests waiting for your decision, like leave or attendance corrections.',
    how: 'Read the request, add a comment if you like, then tap Approve or Reject. The person is notified straight away.',
    where: 'For managers and approvers.',
  },
  notifications: {
    title: 'Notifications',
    what: 'Everything SampCrew has told you about: decisions, announcements, replies and reminders.',
    how: 'Tap a notification to open what it is about.',
  },
  payslip: {
    title: 'Payslip',
    what: 'One month’s pay: earnings, deductions and net pay.',
    how: 'Check each line. Ask HR if something looks wrong.',
    where: 'Available once payroll for the month is finalised.',
  },
  announcement: {
    title: 'Announcement',
    what: 'Company news from HR.',
    how: 'Read it and tap Acknowledge if it asks you to.',
  },
  devices: {
    title: 'Signed-in devices',
    what: 'Phones and browsers signed in to your account.',
    how: 'Sign out any device you no longer use or do not recognise.',
    where: 'Check it if you lose a phone.',
  },

  // Sections
  'home.today': { title: 'Today', what: 'Your shift today and whether you have punched in.', how: 'Tap Punch in or Punch out.' },
  'home.approvals': { title: 'Waiting for your approval', what: 'Requests from your team that need your decision.' },
  'home.announcements': { title: 'Announcements', what: 'The latest company news. Some ask you to acknowledge them.' },
  'home.notifications': { title: 'Notifications', what: 'Your newest notifications.' },
  'attendance.today': { title: 'Today', what: 'Today’s status, shift and the button to punch.', how: 'Punch in when you start and out when you finish.' },
  'attendance.queue': { title: 'Waiting to send', what: 'Punches saved on this phone while it was offline.', how: 'They are sent automatically when you are back online. Keep the app installed until then.' },
  'attendance.missing': { title: 'Not recorded', what: 'Punches the server could not accept, with the reason.', how: 'Ask your manager or HR to correct the day.' },
  'attendance.punches': { title: 'Today’s punches', what: 'Every punch recorded today, from the app, a kiosk or a machine.' },
  'leave.balances': { title: 'Balances', what: 'Days left for each leave type this year.', how: 'Pending requests are already taken off what is available.' },
  'leave.requests': { title: 'My requests', what: 'Your leave requests and their status.', how: 'Tap a pending request to cancel it.' },
  'helpdesk.cases': { title: 'My cases', what: 'Your questions to HR.', how: 'Switch between open and all cases.' },
  'helpdesk.next': { title: 'Next step', what: 'What HR will do next with this case.' },
  'helpdesk.rating': { title: 'How did HR handle this?', what: 'Rate the help you got, from 1 to 5. It helps HR improve.' },
  'me.photo': { title: 'Your photo', what: 'The photo colleagues see next to your name.', how: 'Take or choose a photo, or remove it.' },
  'me.payslips': { title: 'Payslips', what: 'Your payslips from finalised payroll.' },
  'me.security': { title: 'Security', what: 'Two-step verification, biometric unlock, signed-in devices and signing out.', how: 'Turn on biometric unlock so nobody else can open SampCrew on this phone.' },
  'me.appearance': { title: 'Appearance', what: 'How the app looks: theme, style, background, mode and contrast.', how: 'Your choice follows you to the web portal too.' },

  // Fields
  'field.leaveType': { title: 'Leave type', what: 'The kind of leave. Your balance for it is shown.' },
  'field.leaveDuration': { title: 'Part of the day', what: 'A full day, or the first or second half of a one-day leave.' },
  'field.comment': { title: 'Comment', what: 'Optional note shown to the person when you decide.' },
  'field.category': { title: 'What is it about?', what: 'The topic decides who in HR picks up your question.' },
  'field.priority': { title: 'How urgent is it?', what: 'How soon you need an answer. Use Urgent only when it cannot wait.' },
  'field.workspace': { title: 'Workspace', what: 'Your company’s workspace address. Only needed if your account is in more than one workspace.' },
  'field.style': { title: 'Visual style', what: 'Neon is the colourful glass look; Classic is plain and calm.' },
  'field.mode': { title: 'Mode', what: 'Light, dark, or follow your phone’s setting.' },
  'field.contrast': { title: 'Contrast', what: 'High contrast makes text and borders stronger and easier to read.' },
} satisfies Record<string, MobileHelpEntry>;

export type HelpKey = keyof typeof MOBILE_HELP;
