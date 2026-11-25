import { describe, expect, it } from 'vitest';
import { RECORD_DOCUMENTS, employeeRecordInput, recordScore } from './employee-record';
import { BUILT_IN_DOCUMENT_TYPES } from './document-center';
import { isFeaturePart } from './feature-parts';
import { DEFAULT_PAGE_ACCESS, PAGE_ACCESS_CHOICES, withheldPages } from './page-access';

describe('issue #86: employee record and page access', () => {
  it('scores only required items, and counts an optional item once it is filled', () => {
    expect(recordScore([{ done: true, optional: false }, { done: false, optional: false }, { done: false, optional: true }])).toEqual({ score: 50, done: 1, total: 2 });
    expect(recordScore([{ done: true, optional: false }, { done: true, optional: true }])).toEqual({ score: 100, done: 2, total: 2 });
    expect(recordScore([]).score).toBe(100);
  });

  it('asks only for document types that exist', () => {
    const types = new Set(BUILT_IN_DOCUMENT_TYPES.map((t) => t.key as string));
    for (const d of RECORD_DOCUMENTS) for (const t of d.types) expect(types.has(t), `${d.key}: ${t}`).toBe(true);
  });

  it('reads Aadhaar with or without spaces and amounts as numbers', () => {
    const v = employeeRecordInput.parse({ parentAadhaar: '1234 5678 9012', ctcAnnual: '600000', fatherName: '' });
    expect(v).toMatchObject({ parentAadhaar: '123456789012', ctcAnnual: 600000, fatherName: null });
    expect(employeeRecordInput.safeParse({ parentAadhaar: '1234' }).success).toBe(false);
  });

  it('page access switches real pages; the day-one pages are ticked by default', () => {
    for (const c of PAGE_ACCESS_CHOICES) for (const p of c.parts) expect(isFeaturePart(p), p).toBe(true);
    expect(DEFAULT_PAGE_ACCESS).toEqual(['attendance', 'leave', 'announcements', 'signature']);
    expect(withheldPages(PAGE_ACCESS_CHOICES.map((c) => c.key))).toEqual([]);
    expect(withheldPages(DEFAULT_PAGE_ACCESS)).toContain('payroll.payslips');
    expect(withheldPages(DEFAULT_PAGE_ACCESS)).not.toContain('leave.requests');
  });
});
