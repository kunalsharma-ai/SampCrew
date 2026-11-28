import { requestDateLabel, requestTimeLabel } from '@crew/contracts';

/* eslint-disable @typescript-eslint/no-explicit-any */
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const half = (h: string, end: boolean) => (h === 'full' ? '' : end ? ' (first half)' : ' (second half)');

/**
 * The leave application form as an email: a formal, print-friendly layout (company, applicant details, leave details,
 * approvals so far, declaration) that reads the same in Outlook, Gmail and Apple Mail. Plain text goes with it.
 */
export function leaveApplicationEmail(p: { form: Record<string, any>; days: string; reference: string; link: string; recipientName: string; copy: boolean }) {
  const f = p.form;
  const a = f.applicant ?? {};
  const hours = f.duration === 'hours' && f.startTime && f.endTime;
  const from = `${requestDateLabel(f.startDate)}${hours ? `, ${requestTimeLabel(f.startTime)}` : half(f.startHalf, false)}`;
  const to = `${requestDateLabel(f.endDate)}${hours ? `, ${requestTimeLabel(f.endTime)}` : half(f.endHalf, true)}`;
  const duration = f.duration === 'hours' ? 'Hours' : f.duration === 'half' ? 'Half day' : 'Full day';
  const subject = `${p.copy ? 'Copy: ' : ''}Leave application ${p.reference}: ${a.name} (${a.employeeCode ?? 'no code'}), ${f.leaveType?.name}, ${p.days} day${p.days === '1' ? '' : 's'}`;
  const rows: [string, unknown][] = [
    ['Employee name', a.name], ['Employee code', a.employeeCode ?? '—'], ['Designation', a.designation ?? '—'], ['Department', a.department ?? '—'],
    ['Workspace', [a.levelLabel, a.workspace].filter(Boolean).join(', ')], ['Reporting manager', f.reportingManager?.name ?? '—'], ['HR manager', f.hrManager?.name ?? '—'],
  ];
  const leaveRows: [string, unknown][] = [
    ['Leave type', f.leaveType?.name], ['Duration', duration], ['From', from], ['To', to], ['Number of days', p.days], ['Reason', f.reason],
    ...(f.contactDuringLeave ? [['Contact during leave', f.contactDuringLeave] as [string, unknown]] : []),
    ...(f.handoverTo ? [['Work handed over to', f.handoverTo] as [string, unknown]] : []),
    ['Request ID', f.requestRef],
    ['Approvers', ((f.sendTo ?? []) as { name: string; part?: string }[]).map((x) => `${x.name}${x.part === 'primary' ? ' (primary)' : ''}`).join(', ') || '—'],
    ...((f.cc ?? []).length ? [['CC', (f.cc as { name: string }[]).map((x) => x.name).join(', ')] as [string, unknown]] : []),
  ];
  const table = (title: string, r: [string, unknown][]) => `
    <tr><td style="padding:18px 28px 6px;font:600 12px/1.4 Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#4f46e5">${esc(title)}</td></tr>
    <tr><td style="padding:0 28px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px">
      ${r.map(([k, v], i) => `<tr style="background:${i % 2 ? '#ffffff' : '#f9fafb'}"><td style="padding:9px 12px;width:38%;font:13px/1.45 Arial,sans-serif;color:#6b7280;border-bottom:1px solid #eef0f3">${esc(k)}</td><td style="padding:9px 12px;font:600 13px/1.45 Arial,sans-serif;color:#111827;border-bottom:1px solid #eef0f3">${esc(v)}</td></tr>`).join('')}
    </table></td></tr>`;
  const approvals = (f.approvedBy ?? []) as { name: string; levelLabel: string; comment: string | null }[];
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f3f4f6;padding:24px 0"><tr><td align="center">
  <table role="presentation" width="640" cellspacing="0" cellpadding="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
    <tr><td style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:22px 28px;color:#ffffff">
      <div style="font:600 12px/1.4 Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;opacity:.85">${esc(f.company)}</div>
      <div style="font:700 22px/1.3 Arial,sans-serif;margin-top:4px">Leave Application Form</div>
      <div style="font:13px/1.4 Arial,sans-serif;margin-top:6px;opacity:.9">Reference ${esc(p.reference)} · Submitted ${esc(requestDateLabel(String(f.submittedAt).slice(0, 10)))}</div>
    </td></tr>
    <tr><td style="padding:20px 28px 0;font:14px/1.6 Arial,sans-serif;color:#374151">${p.copy
      ? `Dear ${esc(p.recipientName)}, this is your copy of the leave application you submitted. It is waiting for the approvers below.`
      : `Dear ${esc(p.recipientName)}, ${esc(a.name)} has applied for leave and named you as an approver. Please review the application and approve, reject or ask for changes in SampCrew.`}</td></tr>
    ${table('Employee details', rows)}
    ${table('Leave details', leaveRows)}
    ${approvals.length ? `<tr><td style="padding:18px 28px 6px;font:600 12px/1.4 Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:#4f46e5">Request approved by</td></tr>
    <tr><td style="padding:0 28px">${approvals.map((x) => `<div style="padding:8px 12px;margin-bottom:6px;border-left:3px solid #10b981;background:#ecfdf5;font:13px/1.45 Arial,sans-serif;color:#065f46"><b>${esc(x.name)}</b> (${esc(x.levelLabel)})${x.comment ? `: “${esc(x.comment)}”` : ''}</div>`).join('')}</td></tr>` : ''}
    <tr><td style="padding:18px 28px 0;font:12px/1.6 Arial,sans-serif;color:#6b7280">Declaration: I confirm that the information above is correct and that I will hand over my pending work before the leave starts.<br><b style="color:#111827">${esc(a.name)}</b></td></tr>
    <tr><td align="center" style="padding:22px 28px 28px"><a href="${esc(p.link)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font:600 14px/1 Arial,sans-serif;padding:13px 24px;border-radius:8px">${p.copy ? 'View my application' : 'Review and decide'}</a></td></tr>
  </table></td></tr></table></body></html>`;
  const text = [
    `Leave Application Form (${p.reference})`, f.company, '',
    ...rows.map(([k, v]) => `${k}: ${v ?? '—'}`), '',
    ...leaveRows.map(([k, v]) => `${k}: ${v ?? '—'}`), '',
    ...(approvals.length ? ['Request approved by:', ...approvals.map((x) => `- ${x.name} (${x.levelLabel})${x.comment ? `: "${x.comment}"` : ''}`), ''] : []),
    `${p.copy ? 'View my application' : 'Review and decide'}: ${p.link}`,
  ].join('\n');
  return { subject, html, text };
}
