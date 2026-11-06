/**
 * Removes personal identifiers from text before it is sent to an AI provider. This is the second line of
 * defence: the prompts SampCrew builds never include bank, tax, national ID, salary or health fields in the first
 * place. Free text (a helpdesk question, an article) can still contain them, so every prompt passes through here.
 *
 * Patterns are deliberately broad: a false positive costs a placeholder in the prompt, a false negative leaks data.
 */

export type RedactionKind = 'email' | 'phone' | 'aadhaar' | 'pan' | 'ifsc' | 'iban' | 'card' | 'nino' | 'account';

const RULES: { kind: RedactionKind; label: string; re: RegExp }[] = [
  { kind: 'email', label: '[email]', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { kind: 'iban', label: '[bank account]', re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g },
  { kind: 'pan', label: '[tax id]', re: /\b[A-Z]{5}\d{4}[A-Z]\b/gi },
  { kind: 'ifsc', label: '[bank code]', re: /\b[A-Z]{4}0[A-Z0-9]{6}\b/gi },
  { kind: 'nino', label: '[national insurance number]', re: /\b[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z] ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/gi },
  // Card numbers before Aadhaar and phone numbers, which are shorter runs of digits.
  { kind: 'card', label: '[card number]', re: /\b(?:\d[ -]?){15,18}\d\b/g },
  { kind: 'aadhaar', label: '[national id]', re: /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g },
  { kind: 'phone', label: '[phone]', re: /(?:\+\d{1,3}[ -]?)?(?:\(?\d{2,5}\)?[ -]?)?\d{3,5}[ -]?\d{4,6}\b/g },
  { kind: 'account', label: '[account number]', re: /\b\d{9,18}\b/g },
];

export interface Redaction {
  text: string;
  removed: Partial<Record<RedactionKind, number>>;
}

export function redact(input: string): Redaction {
  const removed: Partial<Record<RedactionKind, number>> = {};
  let text = input;
  for (const rule of RULES) {
    text = text.replace(rule.re, (m) => {
      // Short digit runs inside ordinary sentences ("12 days", "2026") are not phone numbers.
      if (rule.kind === 'phone' && m.replace(/\D/g, '').length < 10) return m;
      removed[rule.kind] = (removed[rule.kind] ?? 0) + 1;
      return rule.label;
    });
  }
  return { text, removed };
}

/** Total number of identifiers removed. */
export const redactionCount = (r: Redaction['removed']) => Object.values(r).reduce((s, n) => s + (n ?? 0), 0);

/** AI credits charged for a call: one credit per started thousand tokens, at least one. */
export function creditsFor(inputTokens: number, outputTokens: number): number {
  return Math.max(1, Math.ceil((inputTokens + outputTokens) / 1000));
}
