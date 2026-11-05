import { describe, expect, it } from 'vitest';
import { creditsFor, redact } from './ai-redact';
import { delayMs, evaluateCondition, render, retryDelayMs, validateDefinition } from './automation';
import { attritionRisk, payrollAnomalies } from './insights';

describe('redact', () => {
  it('removes identifiers and counts them', () => {
    const r = redact('Mail me at neha.d@example.com or call +91 98765 43210. PAN ABCDE1234F, Aadhaar 1234 5678 9012, IFSC HDFC0001234, account 001234567890.');
    expect(r.text).not.toMatch(/example\.com|98765|ABCDE1234F|5678|HDFC0001234|001234567890/);
    expect(r.text).toContain('[email]');
    expect(r.text).toContain('[tax id]');
    expect(r.removed).toMatchObject({ email: 1, pan: 1, ifsc: 1, phone: 1 });
  });
  it('leaves ordinary numbers alone', () => {
    const text = 'I took 12 days of leave in 2026 and my professional tax went up by 200.';
    expect(redact(text)).toEqual({ text, removed: {} });
  });
  it('handles UK identifiers', () => {
    const r = redact('NI number AB 12 34 56 C, IBAN GB82 WEST 1234 5698 7654 32');
    expect(r.text).toBe('NI number [national insurance number], IBAN [bank account]');
  });
  it('charges a credit per started thousand tokens', () => {
    expect(creditsFor(10, 5)).toBe(1);
    expect(creditsFor(1500, 600)).toBe(3);
  });
});

describe('workflow definitions', () => {
  const base = { trigger: { event: 'employee.created' }, steps: [{ id: 'notify_hr', type: 'notify', to: 'role', role: 'hr_admin', title: 'Welcome {{employee.name}}' }] };
  it('accepts a valid definition and fills defaults', () => {
    const v = validateDefinition(base, ['hr_admin']);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.definition.steps[0]).toMatchObject({ email: false, body: '' });
  });
  it('reports unknown fields, placeholders, roles and bad operators', () => {
    const v = validateDefinition({
      trigger: { event: 'employee.created' },
      steps: [
        { id: 'a', type: 'condition', field: 'leave.days', op: 'gt', value: 3 },
        { id: 'b', type: 'condition', field: 'employee.department', op: 'gt', value: 'x' },
        { id: 'b', type: 'notify', to: 'role', role: 'nobody', title: 'Hi {{salary}}' },
        { id: 'c', type: 'approval', approver: 'role', summary: 'ok' },
      ],
    }, ['hr_admin']);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      const msgs = v.issues.map((i) => i.message).join(' | ');
      expect(msgs).toContain('"leave.days" is not available');
      expect(msgs).toContain('needs a number or date field');
      expect(msgs).toContain('used twice');
      expect(msgs).toContain('{{salary}} is not available');
      expect(msgs).toContain('Role "nobody" does not exist');
      expect(msgs).toContain('Choose a role');
    }
  });
  it('needs at least one step that does something', () => {
    const v = validateDefinition({ trigger: { event: 'employee.created' }, steps: [{ id: 'w', type: 'delay', amount: 1, unit: 'days' }] });
    expect(v.ok).toBe(false);
  });
  it('evaluates conditions, ignoring case for text', () => {
    const ctx = { 'employee.department': 'Assembly Line', 'leave.days': 4, 'leave.from': '2026-11-10' };
    expect(evaluateCondition({ id: 'a', type: 'condition', field: 'employee.department', op: 'eq', value: 'assembly line' }, ctx).met).toBe(true);
    expect(evaluateCondition({ id: 'a', type: 'condition', field: 'leave.days', op: 'gt', value: 3 }, ctx).met).toBe(true);
    expect(evaluateCondition({ id: 'a', type: 'condition', field: 'leave.days', op: 'lt', value: '3' }, ctx).met).toBe(false);
    expect(evaluateCondition({ id: 'a', type: 'condition', field: 'leave.from', op: 'gte', value: '2026-11-10' }, ctx).met).toBe(true);
    expect(evaluateCondition({ id: 'a', type: 'condition', field: 'employee.department', op: 'in', value: ['Quality', 'Assembly line'] }, ctx).met).toBe(true);
    expect(evaluateCondition({ id: 'a', type: 'condition', field: 'employee.location', op: 'eq', value: 'Pune' }, ctx).met).toBe(false);
    expect(evaluateCondition({ id: 'a', type: 'condition', field: 'employee.location', op: 'neq', value: 'Pune' }, ctx).met).toBe(true);
  });
  it('renders templates and computes waits and back-off', () => {
    expect(render('Hi {{employee.name}}, {{ leave.days }} days {{missing}}.', { 'employee.name': 'Neha', 'leave.days': 2 })).toBe('Hi Neha, 2 days .');
    expect(delayMs({ id: 'd', type: 'delay', amount: 2, unit: 'hours' })).toBe(7_200_000);
    expect([1, 2, 3].map(retryDelayMs)).toEqual([30_000, 120_000, 480_000]);
  });
});

describe('attrition risk', () => {
  const steady = { tenureMonths: 24, monthsSinceJobChange: 10, unplannedLeaveRecent: 1, unplannedLeavePrior: 1, lateOrAbsentDays30: 0, lastRatingShare: 0.8, recognitions180: 2, payQueries90: 0 };
  it('is low with no factors', () => {
    expect(attritionRisk(steady)).toEqual({ score: 0, band: 'low', factors: [] });
  });
  it('adds named factors with evidence, highest first', () => {
    const r = attritionRisk({ ...steady, tenureMonths: 40, monthsSinceJobChange: null, unplannedLeaveRecent: 6, unplannedLeavePrior: 1, lastRatingShare: 0.4, recognitions180: 0 });
    expect(r.factors.map((f) => f.key)).toEqual(['stalled', 'leave_spike', 'low_rating', 'no_recognition']);
    expect(r.score).toBe(70);
    expect(r.band).toBe('high');
    expect(r.factors[1]!.evidence).toBe('6 days in the last 90 days, 1 in the 90 days before');
  });
  it('caps at 100', () => {
    const r = attritionRisk({ tenureMonths: 6, monthsSinceJobChange: null, unplannedLeaveRecent: 9, unplannedLeavePrior: 0, lateOrAbsentDays30: 5, lastRatingShare: 0.2, recognitions180: 0, payQueries90: 3 });
    expect(r.score).toBe(90);
    expect(attritionRisk({ ...steady, tenureMonths: 40, monthsSinceJobChange: 40, unplannedLeaveRecent: 9, unplannedLeavePrior: 0, lateOrAbsentDays30: 5, lastRatingShare: 0.2, recognitions180: 0, payQueries90: 3 }).score).toBe(95);
  });
});

describe('payroll checks', () => {
  const h = (gross: string, net: string, components = ['BASIC', 'HRA', 'PF']) => ({ gross, net, components });
  it('says there is nothing to compare on a first run', () => {
    expect(payrollAnomalies({ employeeName: 'A', gross: '50000.00', net: '45000.00', lopDays: '0', daysInPeriod: 30, components: ['BASIC'], history: [] }).map((a) => a.code)).toEqual(['no_history']);
  });
  it('flags big changes against the median of recent months and component changes', () => {
    const out = payrollAnomalies({ employeeName: 'A', gross: '65000.00', net: '58000.00', lopDays: '0', daysInPeriod: 30, components: ['BASIC', 'HRA', 'PF', 'BONUS'], history: [h('50000.00', '45000.00'), h('50000.00', '45000.00'), h('52000.00', '46000.00')] });
    expect(out.map((a) => a.code)).toEqual(['gross_change', 'net_change', 'component_added']);
    expect(out[0]!.message).toBe('Gross pay is up 30% on the usual 50000.00.');
  });
  it('flags negative net and heavy unpaid days', () => {
    const out = payrollAnomalies({ employeeName: 'A', gross: '1000.00', net: '-200.00', lopDays: '20', daysInPeriod: 30, components: ['BASIC'], history: [h('1000.00', '900.00', ['BASIC'])] });
    expect(out.map((a) => a.code)).toEqual(['negative_net', 'high_lop', 'net_change']);
  });
  it('stays quiet for normal months', () => {
    expect(payrollAnomalies({ employeeName: 'A', gross: '50000.00', net: '45100.00', lopDays: '0', daysInPeriod: 30, components: ['BASIC', 'HRA', 'PF'], history: [h('50000.00', '45000.00'), h('50000.00', '45000.00')] })).toEqual([]);
  });
});
