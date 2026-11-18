import { z } from 'zod';

/**
 * Phone number checks shared by every form (web, mobile and the API), so a number accepted in one place is
 * accepted everywhere. A number may be written with its country code (+91 98201 23456, or 0091 ...) or, when the
 * country is known (the employee's legal entity, the workspace's country), in the local form (098765 43210).
 *
 * Numbers for the countries SampCrew has statutory packs for are checked against that country's numbering plan
 * (length and first digits). Any other country is checked against the international rules: up to 15 digits in
 * all, country code included.
 */

interface Plan {
  /** Calling code without the +. */
  cc: string;
  /** Lengths of the national number (without the country code or trunk 0). */
  lengths: number[];
  /** The national number must match this. */
  pattern: RegExp;
  /** The trunk prefix written before local numbers (0 in most countries, 1 in North America), if any. */
  trunk?: string;
  /** A local number may also be written without the trunk prefix (as in India and Singapore). */
  trunkOptional?: boolean;
  example: string;
}

const PLANS: Record<string, Plan> = {
  IN: { cc: '91', lengths: [10], pattern: /^[1-9]\d{9}$/, trunk: '0', trunkOptional: true, example: '+91 98201 23456' },
  US: { cc: '1', lengths: [10], pattern: /^[2-9]\d{2}[2-9]\d{6}$/, trunk: '1', trunkOptional: true, example: '+1 415 555 2671' },
  CA: { cc: '1', lengths: [10], pattern: /^[2-9]\d{2}[2-9]\d{6}$/, trunk: '1', trunkOptional: true, example: '+1 416 555 0134' },
  GB: { cc: '44', lengths: [9, 10], pattern: /^[1-9]\d{8,9}$/, trunk: '0', example: '+44 7700 900123' },
  AE: { cc: '971', lengths: [8, 9], pattern: /^(5\d{8}|[1-9]\d{7})$/, trunk: '0', example: '+971 50 123 4567' },
  SA: { cc: '966', lengths: [8, 9], pattern: /^(5\d{8}|[1-9]\d{7})$/, trunk: '0', example: '+966 50 123 4567' },
  QA: { cc: '974', lengths: [8], pattern: /^[3-7]\d{7}$/, trunkOptional: true, example: '+974 3312 3456' },
  SG: { cc: '65', lengths: [8], pattern: /^[3689]\d{7}$/, trunkOptional: true, example: '+65 6123 4567' },
  AU: { cc: '61', lengths: [9], pattern: /^[2-478]\d{8}$/, trunk: '0', example: '+61 412 345 678' },
};
/** Calling codes with a plan, longest first so +971 is not read as +9. */
const BY_CC = Object.values(PLANS).sort((a, b) => b.cc.length - a.cc.length);

export const PHONE_HINT = 'Include the country code, such as +91 98201 23456';

export type PhoneCheck = { ok: true; value: string; e164: string | null } | { ok: false; message: string };

const SEPARATORS = /[\s().-]/g;

/** Looks like nobody's number: 0000000000, 1111111111, 1234567890 and so on. */
function placeholder(digits: string): boolean {
  if (/^(\d)\1+$/.test(digits)) return true;
  const steps = [...digits].slice(1).map((c, i) => Number(c) - Number(digits[i]));
  return steps.every((x) => x === 1) || steps.every((x) => x === -1) || ['1234567890', '0987654321'].some((x) => digits.endsWith(x));
}

function checkNational(plan: Plan, national: string): string | null {
  if (!plan.lengths.includes(national.length)) {
    const want = plan.lengths.length === 1 ? `${plan.lengths[0]}` : `${plan.lengths[0]} or ${plan.lengths[plan.lengths.length - 1]}`;
    return `This number has ${national.length} digits after +${plan.cc}; numbers there have ${want}. For example ${plan.example}`;
  }
  if (!plan.pattern.test(national) || placeholder(national)) return `This is not a valid +${plan.cc} number. For example ${plan.example}`;
  return null;
}

/**
 * Checks a phone number. `country` (ISO 3166 alpha-2) lets a local number without a country code be checked against
 * that country's plan; without it a local number only needs a believable length. On success `value` is the number as
 * typed with spacing tidied, and `e164` the international form when the country is known.
 */
export function checkPhone(raw: string, country?: string | null): PhoneCheck {
  const value = raw.trim().replace(/\s+/g, ' ');
  if (!value) return { ok: false, message: 'Enter a phone number' };
  if (/[^0-9+\s().-]/.test(value)) return { ok: false, message: 'Use only digits, spaces, brackets, - and a leading +' };
  if (value.lastIndexOf('+') > 0) return { ok: false, message: 'A + can only come first, before the country code' };
  if ((value.match(/\(/g)?.length ?? 0) !== (value.match(/\)/g)?.length ?? 0)) return { ok: false, message: 'Close the bracket in this number' };
  let digits = value.replace(SEPARATORS, '').replace('+', '');
  let international = value.startsWith('+');
  if (!international && digits.startsWith('00')) { international = true; digits = digits.slice(2); }
  if (!digits) return { ok: false, message: 'Enter a phone number' };

  if (international) {
    if (digits.length < 8 || digits.length > 15) return { ok: false, message: `A number with its country code has 8 to 15 digits; this one has ${digits.length}` };
    const plan = BY_CC.find((p) => digits.startsWith(p.cc));
    if (plan) {
      const bad = checkNational(plan, digits.slice(plan.cc.length));
      if (bad) return { ok: false, message: bad };
    } else if (placeholder(digits)) {
      return { ok: false, message: 'This does not look like a real phone number' };
    }
    return { ok: true, value, e164: `+${digits}` };
  }

  const plan = country ? PLANS[country.toUpperCase()] : undefined;
  if (!plan) {
    if (digits.length < 8 || digits.length > 15) return { ok: false, message: `${PHONE_HINT}. This number has ${digits.length} digits` };
    if (placeholder(digits.replace(/^0+/, ''))) return { ok: false, message: 'This does not look like a real phone number' };
    return { ok: true, value, e164: null };
  }
  // A local number: drop the trunk prefix, or read a number already starting with the country code (919876543210).
  let national = digits;
  if (plan.trunk && digits.startsWith(plan.trunk) && plan.lengths.includes(digits.length - plan.trunk.length)) national = digits.slice(plan.trunk.length);
  else if (digits.startsWith(plan.cc) && plan.lengths.includes(digits.length - plan.cc.length) && !plan.lengths.includes(digits.length)) national = digits.slice(plan.cc.length);
  else if (plan.trunk && !plan.trunkOptional && !digits.startsWith(plan.trunk)) {
    return { ok: false, message: `Start with ${plan.trunk} or the country code. For example ${plan.example}` };
  }
  const bad = checkNational(plan, national);
  if (bad) return { ok: false, message: bad.replace(` after +${plan.cc}`, '') };
  return { ok: true, value, e164: `+${plan.cc}${national}` };
}

/** Returns the error message for a phone number, or null when it is valid (or empty and optional). */
export function phoneError(raw: string | null | undefined, country?: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  const r = checkPhone(raw, country);
  return r.ok ? null : r.message;
}

/**
 * The schema every phone field uses. Without a known country, a number written with a country code is checked
 * against that country's plan and a local one only for its length; forms that know the country (the hire form,
 * the profile) check local numbers against it too, and so does the API where the record has a country.
 */
export const phoneNumber = z.string().trim().max(40, 'A phone number has at most 40 characters').transform((v, ctx) => {
  const r = checkPhone(v);
  if (!r.ok) { ctx.addIssue({ code: 'custom', message: r.message }); return z.NEVER; }
  return r.value;
});

/** An optional phone field where an empty string means "none" (forms that send every field). */
export const optionalPhone = z.string().trim().max(40, 'A phone number has at most 40 characters').optional().transform((v, ctx) => {
  if (!v) return undefined;
  const r = checkPhone(v);
  if (!r.ok) { ctx.addIssue({ code: 'custom', message: r.message }); return z.NEVER; }
  return r.value;
});
