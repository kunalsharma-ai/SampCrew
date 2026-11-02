import { describe, expect, it } from 'vitest';
import { draftJobDescription, IQ_SUGGESTIONS, matchInContext, matchIq } from './iq';

describe('CREW IQ intent matching', () => {
  it('routes the example commands from the design to the right intent', () => {
    const cases: [string, string][] = [
      ['Show pending onboarding tasks.', 'onboarding_tasks'],
      ['Prepare a draft job description for a Senior HR Manager.', 'draft_job'],
      ['Summarize recruitment performance this quarter.', 'recruitment_summary'],
      ['Create a staffing proposal for five recruiters.', 'draft_bid'],
      ['Show departments with increasing overtime.', 'overtime'],
      ['Prepare an employee onboarding checklist.', 'onboarding_checklist'],
      ['What is waiting for my approval?', 'approvals'],
      ['Who is on leave this week?', 'on_leave'],
      ['headcount by department', 'headcount'],
      ['How many employees do we have', 'headcount'],
      ['Leave trend for the last six months', 'leave_trend'],
      ['How many days of sick leave do I get?', 'policy'],
      ['bananas', 'unknown'],
    ];
    for (const [q, intent] of cases) expect(matchIq(q).intent, q).toBe(intent);
    for (const s of IQ_SUGGESTIONS) expect(matchIq(s).intent, s).not.toBe('unknown');
  });

  it('pulls out counts, roles, titles and periods', () => {
    expect(matchIq('Create a staffing proposal for five recruiters').params).toMatchObject({ count: 5, role: 'Recruiter' });
    expect(matchIq('make a bid for 12 warehouse associates in Pune').params).toMatchObject({ count: 12, role: 'Warehouse Associate' });
    expect(matchIq('Draft a bid for 3 security staff').params).toMatchObject({ count: 3, role: 'Security' });
    expect(matchIq('Prepare a draft job description for a Senior HR Manager.').params.title).toBe('Senior HR Manager');
    expect(matchIq('write a JD for the plant supervisor role').params.title).toBe('Plant Supervisor');
    expect(matchIq('Summarize recruitment performance this quarter').params.period).toBe('quarter');
    expect(matchIq('who is on leave today').params.period).toBe('today');
    const m = matchIq('Show departments with increasing overtime');
    expect(m.matched).toEqual(['overtime']);
    expect(m.score).toBeGreaterThan(0);
  });

  it('drafts a job description as a template to be rewritten', () => {
    const d = draftJobDescription('Senior HR Manager', 'Northwind');
    expect(d).toContain('Northwind is looking for a Senior HR Manager');
    expect(d).toContain('[Main responsibility]');
  });
});

describe('CREW IQ: more subjects and follow-ups', () => {
  it('routes the new kinds of question', () => {
    const cases: [string, string][] = [
      ['What did the last payroll cost?', 'payroll_summary'],
      ['Expense claims waiting for approval', 'expenses_pending'],
      ['Who left this year?', 'attrition'],
      ['What is our attrition this quarter', 'attrition'],
      ['Whose probation ends this month?', 'probation'],
      ['Open helpdesk cases', 'cases'],
      ['Who is absent or late today?', 'attendance_today'],
      ['Goals at risk', 'goals'],
      ['Overdue training', 'learning'],
      ['Work anniversaries this month', 'anniversaries'],
      ['Who is on leave today?', 'on_leave'],
      ['What is waiting for my approval?', 'approvals'],
    ];
    for (const [q, intent] of cases) expect(matchIq(q).intent, q).toBe(intent);
  });

  it('continues the previous subject for a short follow-up, with a new period or department', () => {
    const first = matchInContext('Headcount by department', null, ['Sales', 'Operations']);
    expect(first.intent).toBe('headcount');
    const sales = matchInContext('What about Sales?', first, ['Sales', 'Operations']);
    expect(sales).toMatchObject({ intent: 'headcount', followUp: true, params: { department: 'Sales' } });
    const leave = matchInContext('Who is on leave this week?', sales, ['Sales']);
    expect(leave).toMatchObject({ intent: 'on_leave', params: { period: 'week' } });
    expect(leave.followUp).toBeUndefined();
    const today = matchInContext('and today?', leave, ['Sales']);
    expect(today).toMatchObject({ intent: 'on_leave', followUp: true, params: { period: 'today' } });
    expect(matchInContext('for everyone', sales, ['Sales']).params.department).toBeUndefined();
    // Without anything before it, a fragment is not guessed.
    expect(matchInContext('and today?', null).intent).not.toBe('on_leave');
    // A department named in a full question narrows it.
    expect(matchInContext('Who is absent or late today in Operations?', null, ['Operations']).params.department).toBe('Operations');
  });
});
