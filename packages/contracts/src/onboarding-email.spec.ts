import { describe, expect, it } from 'vitest';
import {
  checklistProgress, cleanEmailHtml, DEFAULT_LIBRARY_CATEGORIES, DEFAULT_LIBRARY_ITEMS, DEFAULT_TEMPLATES, emailTemplateGroup, emailTemplateInput, mayRequireDocument,
  onboardingDocStatus, renderEmailSubject, renderEmailTemplate, textToHtml,
} from './index';

describe('onboarding document library', () => {
  it('ships 35 documents in categories A to G, each in a category, and 8 templates of known documents', () => {
    expect(DEFAULT_LIBRARY_CATEGORIES.map((c) => c.letter).join('')).toBe('ABCDEFG');
    expect(DEFAULT_LIBRARY_ITEMS).toHaveLength(35);
    const cats = new Set(DEFAULT_LIBRARY_CATEGORIES.map((c) => c.key));
    expect(DEFAULT_LIBRARY_ITEMS.every((i) => cats.has(i.category))).toBe(true);
    expect(new Set(DEFAULT_LIBRARY_ITEMS.map((i) => i.key)).size).toBe(35);
    expect(DEFAULT_TEMPLATES).toHaveLength(8);
    const keys = new Set(DEFAULT_LIBRARY_ITEMS.map((i) => i.key));
    expect(DEFAULT_TEMPLATES.every((t) => t.items.every((k) => keys.has(k)))).toBe(true);
    expect(DEFAULT_TEMPLATES.filter((t) => t.isDefault)).toHaveLength(1);
  });

  it('maps request statuses to the seven onboarding statuses; nothing is approved before HR approves', () => {
    expect(onboardingDocStatus('new_request')).toBe('assigned');
    expect(onboardingDocStatus('new_request', true)).toBe('not_submitted');
    expect(onboardingDocStatus('submitted')).toBe('pending_hr_approval');
    expect(onboardingDocStatus('under_verification')).toBe('pending_hr_approval');
    expect(onboardingDocStatus('completed')).toBe('approved');
    expect(onboardingDocStatus('rejected')).toBe('rejected');
    expect(onboardingDocStatus('correction_required')).toBe('resubmission_required');
  });

  it('completes only when every mandatory document is approved', () => {
    const p = checklistProgress([{ status: 'approved', mandatory: true }, { status: 'pending_hr_approval', mandatory: true }, { status: 'not_submitted', mandatory: false }]);
    expect(p).toMatchObject({ total: 3, mandatory: 2, approved: 1, pendingApproval: 1, complete: false, percent: 50 });
    expect(checklistProgress([{ status: 'approved', mandatory: true }, { status: 'not_submitted', mandatory: false }])).toMatchObject({ complete: true, percent: 100 });
  });

  it('keeps sensitive documents optional for HR', () => {
    expect(mayRequireDocument('super', { sensitive: true }, false)).toBe(true);
    expect(mayRequireDocument('hr', { sensitive: false }, true)).toBe(true);
    expect(mayRequireDocument('hr', { sensitive: true }, true)).toBe(false);
    expect(mayRequireDocument('hr', { sensitive: false }, false)).toBe(false);
  });
});

describe('company email templates', () => {
  const vars = { content: textToHtml('Hello <Priya>,\n\nOpen https://x.example/a'), subject: 'Leave approved', company_name: 'Acme & Co', recipient_email: 'p@acme.com', year: '2026' };

  it('needs {{content}} and fills every placeholder, escaping all but the message', () => {
    expect(emailTemplateInput.safeParse({ html: '<p>No slot</p>' }).success).toBe(false);
    expect(emailTemplateInput.safeParse({ html: '<p>{{ content }}</p>' }).success).toBe(true);
    const out = renderEmailTemplate('<h1>{{company_name}}</h1>{{content}}<small>{{recipient_email}} {{year}} {{unknown}}</small>', vars);
    expect(out).toContain('<h1>Acme &amp; Co</h1>');
    expect(out).toContain('Hello &lt;Priya&gt;');
    expect(out).toContain('<a href="https://x.example/a">');
    expect(out).toContain('p@acme.com 2026 </small>');
  });

  it('removes scripts, handlers and javascript: links from imported HTML', () => {
    const out = cleanEmailHtml('<div onclick="x()">a</div><script>alert(1)</script><a href="javascript:alert(1)">b</a><iframe src="x"></iframe>{{content}}');
    expect(out).not.toMatch(/script|onclick|javascript:|iframe/i);
    expect(out).toContain('{{content}}');
  });

  it('keeps the subject unless the template sets one, and picks the template kind from the email', () => {
    expect(renderEmailSubject(null, { subject: 'Hi', company_name: 'Acme' })).toBe('Hi');
    expect(renderEmailSubject('{{company_name}}: {{subject}}', { subject: 'Hi', company_name: 'Acme' })).toBe('Acme: Hi');
    expect(emailTemplateGroup('candidate.offer')).toBe('recruitment');
    expect(emailTemplateGroup('communication.email')).toBe('communication');
    expect(emailTemplateGroup('invitation')).toBe('account');
    expect(emailTemplateGroup('membership.login_created')).toBe('account');
    expect(emailTemplateGroup('leave.approved')).toBe('notification');
  });
});
