import type { AiFeature } from './types';

export const FEATURE: Record<AiFeature, { name: string; description: string }> = {
  assistant: { name: 'HR assistant', description: 'Employees ask a question on the Ask HR page and get an answer drawn only from your published help articles, with the articles it used.' },
  helpdesk_draft: { name: 'Reply drafts', description: 'HR handlers can ask for a draft reply to a helpdesk case. They edit it and send it themselves; nothing is sent automatically. Never offered on confidential cases.' },
  workflow_draft: { name: 'Workflow drafts', description: 'Workflow administrators describe an automation in plain English and get a draft workflow to review, test and activate.' },
};

export const STATUS: Record<string, { label: string; tone: 'success' | 'neutral' | 'warning' | 'danger' }> = {
  ok: { label: 'Answered', tone: 'success' },
  no_sources: { label: 'No matching article', tone: 'neutral' },
  refused: { label: 'Declined by the AI', tone: 'warning' },
  error: { label: 'Provider error', tone: 'danger' },
  over_limit: { label: 'Over credit limit', tone: 'warning' },
};

export const REDACTION: Record<string, string> = {
  email: 'email addresses', phone: 'phone numbers', aadhaar: 'national ID numbers', pan: 'tax IDs', ifsc: 'bank codes', iban: 'bank accounts',
  card: 'card numbers', nino: 'national insurance numbers', account: 'account numbers',
};
