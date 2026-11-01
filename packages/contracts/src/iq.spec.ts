import { describe, expect, it } from 'vitest';
import { draftJobDescription, IQ_SUGGESTIONS, matchIq } from './iq';

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
